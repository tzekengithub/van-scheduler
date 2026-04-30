import { NextRequest } from "next/server";
import { buildScheduleContext } from "@/lib/chat-context";
import { db } from "@/lib/db";
import { bookings, vans } from "@/drizzle/schema";
import { eq } from "drizzle-orm";
import { saveRule, getActiveRules } from "@/lib/scheduling-rules";
import { aiRecheckAllVans } from "@/lib/ai-scheduler";
import { config } from "@/lib/config";

export const runtime = "nodejs";

const TOOLS = [
  {
    type: "function",
    function: {
      name: "assign_van",
      description: "Assign a specific van to a booking. Sets manualChange=1 to lock it.",
      parameters: {
        type: "object",
        properties: {
          bookingId: { type: "number", description: "Booking ID" },
          vanId: { type: "number", description: "Van ID to assign" },
        },
        required: ["bookingId", "vanId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_outsource",
      description: "Mark a booking as outsourced with a company name.",
      parameters: {
        type: "object",
        properties: {
          bookingId: { type: "number" },
          companyName: { type: "string" },
        },
        required: ["bookingId", "companyName"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_scheduling_rule",
      description: "Save a scheduling rule that will be applied to all future AI van assignments. Use this whenever the user says an assignment is wrong, or gives a preference/constraint to remember for the future.",
      parameters: {
        type: "object",
        properties: {
          rule: {
            type: "string",
            description: "Clear, actionable rule, e.g. 'Van WXY1234 should not be assigned to Singapore routes'",
          },
        },
        required: ["rule"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "trigger_recheck",
      description: "Re-run AI van assignment for all auto-managed bookings. Use after saving rules or when the user asks to redo assignments.",
      parameters: { type: "object", properties: {} },
    },
  },
];

async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  if (name === "assign_van") {
    const { bookingId, vanId } = args as { bookingId: number; vanId: number };
    const [van] = await db.select().from(vans).where(eq(vans.id, vanId)).limit(1);
    if (!van) return `Error: Van ID ${vanId} not found`;
    await db.update(bookings).set({
      vanId,
      vehiclePlate: van.vanNumber ?? "",
      driverName: van.driverName ?? "",
      driverContact: van.driverContact ?? "",
      inHouseOrOutsourced: "I",
      manualChange: 1,
    }).where(eq(bookings.id, bookingId));
    return `Assigned van ${van.vanNumber} (${van.driverName ?? "?"}) to booking #${bookingId}`;
  }

  if (name === "set_outsource") {
    const { bookingId, companyName } = args as { bookingId: number; companyName: string };
    await db.update(bookings).set({
      vanId: null,
      vehiclePlate: "",
      driverName: "",
      driverContact: "",
      inHouseOrOutsourced: "O",
      outsourcedCompany: companyName,
      manualChange: 1,
    }).where(eq(bookings.id, bookingId));
    return `Booking #${bookingId} marked as outsourced to ${companyName}`;
  }

  if (name === "save_scheduling_rule") {
    const { rule } = args as { rule: string };
    await saveRule(rule);
    return `Rule saved: "${rule}"`;
  }

  if (name === "trigger_recheck") {
    const logs: string[] = [];
    await aiRecheckAllVans((msg) => logs.push(msg));
    const last = logs.filter((l) => l.startsWith("✓") || l.startsWith("⚠")).slice(-5).join("; ");
    return `Recheck complete. ${last || "Done."}`;
  }

  return `Unknown tool: ${name}`;
}

export async function POST(request: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object | string) => {
        try {
          const payload = typeof data === "string" ? data : JSON.stringify(data);
          controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
        } catch {}
      };

      try {
        const { messages, includeContext } = await request.json();

        const apiKey = process.env.OPENROUTER_API_KEY;
        if (!apiKey) throw new Error("OPENROUTER_API_KEY not configured");

        // Load saved rules
        const rules = await getActiveRules();
        const rulesSection = rules.length > 0
          ? `\nSAVED SCHEDULING RULES (always respect these):\n${rules.map((r, i) => `${i + 1}. ${r}`).join("\n")}`
          : "";

        // Only fetch full schedule context on the first message (token optimization)
        const scheduleContext = includeContext ? await buildScheduleContext() : "";
        const contextSection = scheduleContext
          ? `\nCURRENT SCHEDULE DATA:\n${scheduleContext}\n`
          : "";

        const systemContent = `You are the scheduling assistant for ${config.company.name}, a Malaysian van transport company.

YOUR CAPABILITIES:
- Answer questions about bookings, vans, drivers, and conflicts
- Assign a van directly using assign_van tool
- Mark a booking as outsourced using set_outsource tool
- Save a scheduling rule using save_scheduling_rule — ALWAYS do this when the user says an assignment was wrong or gives you a preference to remember
- Re-run AI assignment using trigger_recheck
- Respond in the same language the user writes in (English, Bahasa Malaysia, or Mandarin)
- Be concise and direct${contextSection}${rulesSection}`;

        // Agentic tool loop
        type ChatMsg = { role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string };
        const chatMessages: ChatMsg[] = [
          { role: "system", content: systemContent },
          ...messages,
        ];

        const toolLog: Array<{ tool: string; result: string }> = [];
        let MAX_LOOPS = 5;

        while (MAX_LOOPS-- > 0) {
          const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
              "HTTP-Referer": "https://van-scheduler.vercel.app",
            },
            body: JSON.stringify({
              model: "google/gemini-2.5-pro-preview",
              temperature: 0.2,
              stream: false,
              tools: TOOLS,
              tool_choice: "auto",
              messages: chatMessages,
            }),
          });

          if (!res.ok) {
            const errText = await res.text().catch(() => "");
            throw new Error(`OpenRouter ${res.status}: ${errText.slice(0, 200)}`);
          }

          const data = await res.json();
          const choice = data.choices?.[0];
          const msg = choice?.message;
          if (!msg) throw new Error("Empty response");

          // No tool calls — send final response and finish
          if (!msg.tool_calls || msg.tool_calls.length === 0) {
            if (toolLog.length > 0) {
              send({ type: "actions", actions: toolLog });
            }
            // Simulate streaming: chunk the text
            const text: string = msg.content ?? "";
            const chunks = text.match(/.{1,8}/g) ?? [text];
            for (const chunk of chunks) {
              send({ choices: [{ delta: { content: chunk } }] });
            }
            send("[DONE]");
            break;
          }

          // Execute tool calls
          chatMessages.push({ role: "assistant", content: msg.content ?? null, tool_calls: msg.tool_calls });

          for (const tc of msg.tool_calls as Array<{ id: string; function: { name: string; arguments: string } }>) {
            const toolName = tc.function.name;
            let toolArgs: Record<string, unknown> = {};
            try { toolArgs = JSON.parse(tc.function.arguments ?? "{}"); } catch {}

            send({ type: "tool_start", tool: toolName, args: toolArgs });
            const result = await executeTool(toolName, toolArgs);
            send({ type: "tool_done", tool: toolName, result });

            toolLog.push({ tool: toolName, result });
            chatMessages.push({ role: "tool", tool_call_id: tc.id, content: result });
          }
        }

        controller.close();
      } catch (err: unknown) {
        console.error("[/api/chat]", err);
        const msg = `Error: ${err instanceof Error ? err.message : String(err)}`;
        send({ choices: [{ delta: { content: msg } }] });
        send("[DONE]");
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}
