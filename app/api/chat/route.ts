import { NextRequest } from "next/server";
import { buildScheduleContext } from "@/lib/chat-context";
import { db } from "@/lib/db";
import { bookings, vans, schedulingRules } from "@/drizzle/schema";
import { eq } from "drizzle-orm";
import { saveRule, getActiveRules } from "@/lib/scheduling-rules";
import { aiRecheckAllVans } from "@/lib/ai-scheduler";
import { recheckAllVans } from "@/lib/recheck";
import { config } from "@/lib/config";
import { z } from "zod";

const ChatSchema = z.object({
  messages: z.array(z.object({
    role: z.string().max(20),
    content: z.string().max(10000).nullable(),
  })).min(1).max(50),
  includeContext: z.boolean().optional(),
});

export const runtime = "nodejs";

const TOOLS = [
  // ── Van assignment ────────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "assign_van",
      description: "Assign a specific van to a booking. Sets manualChange=1 to lock it. Use when user says 'put van X on booking Y' or 'assign van X to [client/date]'.",
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
  // ── Outsource ─────────────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "set_outsource",
      description: "Mark a booking as outsourced to a company. Use when user says 'outsource booking X to [company]'.",
      parameters: {
        type: "object",
        properties: {
          bookingId: { type: "number" },
          companyName: { type: "string" },
          reason: { type: "string", description: "Optional reason for outsourcing" },
        },
        required: ["bookingId", "companyName"],
      },
    },
  },
  // ── Set in-house ──────────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "set_inhouse",
      description: "Mark a booking back as in-house (undo outsource). Clears outsourcedCompany.",
      parameters: {
        type: "object",
        properties: {
          bookingId: { type: "number" },
        },
        required: ["bookingId"],
      },
    },
  },
  // ── Edit booking ──────────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "edit_booking",
      description: "Edit any field(s) on a booking. Use for changing client, route, date, pax count, amount, paid status, trip type, details, driver info, overtime, introducer, tour guide, etc. Only pass fields that need changing.",
      parameters: {
        type: "object",
        properties: {
          bookingId: { type: "number" },
          travelDate: { type: "string", description: "YYYY-MM-DD" },
          fromLocation: { type: "string" },
          toLocation: { type: "string" },
          clientDetails: { type: "string" },
          details: { type: "string" },
          tripType: { type: "string", description: "trip | round_trip | day_trip | one_way_ride | tpri" },
          passengerCount: { type: "number" },
          amount: { type: "string" },
          myrPerVehicle: { type: "string" },
          paidStatus: { type: "string", description: "U = unpaid, P = paid, D = deposit" },
          driverName: { type: "string" },
          driverContact: { type: "string" },
          overtime: { type: "string" },
          introducer: { type: "string" },
          tourGuide: { type: "string" },
          invoiceNo: { type: "string" },
          manualChange: { type: "number", description: "1 = lock from auto-reassign, 0 = allow auto" },
        },
        required: ["bookingId"],
      },
    },
  },
  // ── Delete booking ────────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "delete_booking",
      description: "Permanently delete a booking. Only do this when the user explicitly asks to delete/remove a booking.",
      parameters: {
        type: "object",
        properties: {
          bookingId: { type: "number" },
        },
        required: ["bookingId"],
      },
    },
  },
  // ── Mark paid ─────────────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "mark_paid",
      description: "Mark one or more bookings as paid (P), unpaid (U), or deposit (D). Shortcut for common payment status updates.",
      parameters: {
        type: "object",
        properties: {
          bookingIds: { type: "array", items: { type: "number" }, description: "List of booking IDs" },
          status: { type: "string", enum: ["P", "U", "D"], description: "P=paid, U=unpaid, D=deposit" },
        },
        required: ["bookingIds", "status"],
      },
    },
  },
  // ── Allow double-book ─────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "allow_double_book",
      description: "Mark all bookings on a specific van+date as manualChange=1 so multiple jobs on the same van/day are intentional and won't show as conflicts.",
      parameters: {
        type: "object",
        properties: {
          bookingIds: { type: "array", items: { type: "number" }, description: "All booking IDs sharing that van+day" },
        },
        required: ["bookingIds"],
      },
    },
  },
  // ── Van CRUD ──────────────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "edit_van",
      description: "Edit a van's details: driver name, driver contact, Singapore/Thailand capability, max pax, location, vehicle type. Only pass fields that need changing.",
      parameters: {
        type: "object",
        properties: {
          vanId: { type: "number" },
          driverName: { type: "string" },
          driverContact: { type: "string" },
          singaporeEnabled: { type: "number", description: "1 = yes, 0 = no" },
          thailandEnabled: { type: "number", description: "1 = yes, 0 = no" },
          maxPaxCapacity: { type: "number" },
          location: { type: "string" },
          vehicleType: { type: "string", description: "van | toyota alphard" },
        },
        required: ["vanId"],
      },
    },
  },
  // ── Scheduling rules ──────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "save_scheduling_rule",
      description: "Save a persistent scheduling rule for future AI van assignments. ALWAYS call this when the user states a preference, constraint, or corrects an assignment.",
      parameters: {
        type: "object",
        properties: {
          rule: { type: "string", description: "Clear, actionable rule e.g. 'Van WXY1234 should not be assigned to Singapore routes'" },
        },
        required: ["rule"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_scheduling_rule",
      description: "Delete a saved scheduling rule by its ID.",
      parameters: {
        type: "object",
        properties: {
          ruleId: { type: "number" },
        },
        required: ["ruleId"],
      },
    },
  },
  // ── Rechecks ──────────────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "trigger_recheck",
      description: "Re-run the AI van assignment for all auto-managed (non-locked) bookings. Use after saving rules or when user asks to redo/reoptimise assignments.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "trigger_rules_recheck",
      description: "Re-run the rules-engine (non-AI) reassignment. Faster than AI recheck. Use when user wants a quick rebalance without AI.",
      parameters: { type: "object", properties: {} },
    },
  },
  // ── Query helpers ─────────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "list_scheduling_rules",
      description: "Return all saved scheduling rules with their IDs. Use when user asks 'what rules do we have' or before deleting a rule.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_booking",
      description: "Fetch full details of a single booking by ID. Use to confirm details before editing or to answer specific questions about one booking.",
      parameters: {
        type: "object",
        properties: {
          bookingId: { type: "number" },
        },
        required: ["bookingId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_vans",
      description: "Return all vans with their IDs, plate numbers, driver names, and capabilities. Use when the user asks about fleet or needs a van ID.",
      parameters: { type: "object", properties: {} },
    },
  },
];

async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  // ── assign_van ─────────────────────────────────────────────────────────────
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

  // ── set_outsource ──────────────────────────────────────────────────────────
  if (name === "set_outsource") {
    const { bookingId, companyName, reason } = args as { bookingId: number; companyName: string; reason?: string };
    await db.update(bookings).set({
      vanId: null,
      vehiclePlate: "",
      driverName: "",
      driverContact: "",
      inHouseOrOutsourced: "O",
      outsourcedCompany: companyName,
      outsourceReason: reason ?? "",
      manualChange: 1,
    }).where(eq(bookings.id, bookingId));
    return `Booking #${bookingId} outsourced to ${companyName}${reason ? ` (${reason})` : ""}`;
  }

  // ── set_inhouse ────────────────────────────────────────────────────────────
  if (name === "set_inhouse") {
    const { bookingId } = args as { bookingId: number };
    await db.update(bookings).set({
      inHouseOrOutsourced: "I",
      outsourcedCompany: "",
      outsourceReason: "",
    }).where(eq(bookings.id, bookingId));
    return `Booking #${bookingId} set back to in-house`;
  }

  // ── edit_booking ───────────────────────────────────────────────────────────
  if (name === "edit_booking") {
    const { bookingId, ...fields } = args as { bookingId: number } & Record<string, unknown>;
    const allowed = [
      "travelDate","fromLocation","toLocation","clientDetails","details","tripType",
      "passengerCount","amount","myrPerVehicle","paidStatus","driverName","driverContact",
      "overtime","introducer","tourGuide","invoiceNo","manualChange",
    ];
    const updates: Record<string, unknown> = {};
    for (const key of allowed) {
      if (fields[key] !== undefined) updates[key] = fields[key];
    }
    // Sync day/month/year if travelDate changes
    if (typeof updates.travelDate === "string") {
      const d = new Date(updates.travelDate);
      if (!isNaN(d.getTime())) {
        updates.day = String(d.getDate());
        updates.month = d.toLocaleString("en-US", { month: "long" });
        updates.year = String(d.getFullYear());
      }
    }
    if (Object.keys(updates).length === 0) return "No valid fields to update";
    await db.update(bookings).set(updates).where(eq(bookings.id, bookingId));
    return `Booking #${bookingId} updated: ${Object.keys(updates).join(", ")}`;
  }

  // ── delete_booking ─────────────────────────────────────────────────────────
  if (name === "delete_booking") {
    const { bookingId } = args as { bookingId: number };
    await db.delete(bookings).where(eq(bookings.id, bookingId));
    return `Booking #${bookingId} deleted`;
  }

  // ── mark_paid ──────────────────────────────────────────────────────────────
  if (name === "mark_paid") {
    const { bookingIds, status } = args as { bookingIds: number[]; status: string };
    await Promise.all(
      bookingIds.map((id) => db.update(bookings).set({ paidStatus: status }).where(eq(bookings.id, id)))
    );
    const label = status === "P" ? "paid" : status === "D" ? "deposit" : "unpaid";
    return `Marked ${bookingIds.length} booking(s) as ${label}: #${bookingIds.join(", #")}`;
  }

  // ── allow_double_book ──────────────────────────────────────────────────────
  if (name === "allow_double_book") {
    const { bookingIds } = args as { bookingIds: number[] };
    await Promise.all(
      bookingIds.map((id) => db.update(bookings).set({ manualChange: 1 }).where(eq(bookings.id, id)))
    );
    return `Marked ${bookingIds.length} bookings as manual — double-booking conflict suppressed`;
  }

  // ── edit_van ───────────────────────────────────────────────────────────────
  if (name === "edit_van") {
    const { vanId, ...fields } = args as { vanId: number } & Record<string, unknown>;
    const allowed = ["driverName","driverContact","singaporeEnabled","thailandEnabled","maxPaxCapacity","location","vehicleType"];
    const updates: Record<string, unknown> = {};
    for (const key of allowed) {
      if (fields[key] !== undefined) updates[key] = fields[key];
    }
    if (Object.keys(updates).length === 0) return "No valid fields to update";
    await db.update(vans).set(updates).where(eq(vans.id, vanId));
    return `Van #${vanId} updated: ${Object.keys(updates).join(", ")}`;
  }

  // ── save_scheduling_rule ───────────────────────────────────────────────────
  if (name === "save_scheduling_rule") {
    const { rule } = args as { rule: string };
    await saveRule(rule);
    return `Rule saved: "${rule}"`;
  }

  // ── delete_scheduling_rule ─────────────────────────────────────────────────
  if (name === "delete_scheduling_rule") {
    const { ruleId } = args as { ruleId: number };
    await db.delete(schedulingRules).where(eq(schedulingRules.id, ruleId));
    return `Scheduling rule #${ruleId} deleted`;
  }

  // ── trigger_recheck ────────────────────────────────────────────────────────
  if (name === "trigger_recheck") {
    const logs: string[] = [];
    await aiRecheckAllVans((msg) => logs.push(msg));
    const last = logs.filter((l) => l.startsWith("✓") || l.startsWith("⚠")).slice(-5).join("; ");
    return `AI recheck complete. ${last || "Done."}`;
  }

  // ── trigger_rules_recheck ──────────────────────────────────────────────────
  if (name === "trigger_rules_recheck") {
    const logs: string[] = [];
    await recheckAllVans((msg) => logs.push(msg));
    const last = logs.slice(-5).join("; ");
    return `Rules recheck complete. ${last || "Done."}`;
  }

  // ── list_scheduling_rules ──────────────────────────────────────────────────
  if (name === "list_scheduling_rules") {
    const rules = await db.select().from(schedulingRules).where(eq(schedulingRules.active, 1));
    if (!rules.length) return "No active scheduling rules saved.";
    return rules.map((r) => `#${r.id}: ${r.ruleText}`).join("\n");
  }

  // ── get_booking ────────────────────────────────────────────────────────────
  if (name === "get_booking") {
    const { bookingId } = args as { bookingId: number };
    const [b] = await db.select().from(bookings).where(eq(bookings.id, bookingId)).limit(1);
    if (!b) return `Booking #${bookingId} not found`;
    return JSON.stringify(b, null, 2);
  }

  // ── list_vans ──────────────────────────────────────────────────────────────
  if (name === "list_vans") {
    const all = await db.select().from(vans);
    return all.map((v) =>
      `#${v.id} | ${v.vanNumber} | ${v.driverName || "no driver"} | SG:${v.singaporeEnabled ? "Y" : "N"} TH:${v.thailandEnabled ? "Y" : "N"} | ${v.vehicleType ?? "van"}`
    ).join("\n");
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
        const chatParsed = ChatSchema.safeParse(await request.json());
        if (!chatParsed.success) {
          send({ choices: [{ delta: { content: `Error: ${JSON.stringify(chatParsed.error.flatten().fieldErrors)}` } }] });
          send("[DONE]");
          controller.close();
          return;
        }
        const { messages, includeContext } = chatParsed.data;

        const apiKey = process.env.OPENROUTER_API_KEY;
        if (!apiKey) throw new Error("OPENROUTER_API_KEY not configured");

        // Load saved rules
        const rules = await getActiveRules();
        const rulesSection = rules.length > 0
          ? `\nSAVED SCHEDULING RULES (always respect these):\n${rules.map((r, i) => `${i + 1}. ${r}`).join("\n")}`
          : "";

        // Always fetch fresh context — needed so AI has current booking IDs for tool calls
        const scheduleContext = includeContext ? await buildScheduleContext() : "";
        const contextSection = scheduleContext
          ? `\nCURRENT SCHEDULE DATA:\n${scheduleContext}\n`
          : "";

        const systemContent = `You are the full-service operations assistant for ${config.company.name}, a Malaysian van transport company. You act like a capable customer support agent who can read AND write — you can look things up AND make changes directly.

YOUR CAPABILITIES:
- Answer any question about bookings, vans, drivers, schedule, conflicts, payment status
- Assign or reassign vans to bookings (assign_van)
- Outsource bookings to external companies (set_outsource) or bring them back in-house (set_inhouse)
- Edit any booking field: client, route, date, amount, pax, paid status, driver, notes (edit_booking)
- Delete bookings (delete_booking) — always confirm the booking details before deleting
- Mark bookings as paid/unpaid/deposit (mark_paid)
- Allow intentional double-booking on a van (allow_double_book)
- Edit van details: driver, contact, SG/TH capability, capacity (edit_van)
- Save or delete scheduling rules (save_scheduling_rule, delete_scheduling_rule, list_scheduling_rules)
- Re-run AI or rules-engine van assignment (trigger_recheck, trigger_rules_recheck)
- Fetch a specific booking's full details (get_booking)
- List all vans (list_vans)

HOW TO BEHAVE:
- Be direct and action-oriented. If the user asks you to do something, DO IT using the tools — don't just tell them how to do it themselves.
- When the user says something is wrong or gives a preference, SAVE IT as a scheduling rule AND fix the current booking.
- When the user says "mark as paid", "change the driver", "outsource to X", etc. — call the tool immediately.
- Always confirm what you did after tool calls, in plain language.
- If you need a booking ID or van ID and don't have it, use get_booking or list_vans first, then proceed.
- Respond in the same language the user writes in (English, Bahasa Malaysia, or Mandarin).
- Be concise. No unnecessary filler.${contextSection}${rulesSection}`;

        type ChatMsg = { role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string };
        const chatMessages: ChatMsg[] = [
          { role: "system", content: systemContent },
          ...messages,
        ];

        const toolLog: Array<{ tool: string; args: Record<string, unknown>; result: string }> = [];
        let MAX_LOOPS = 8;

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

          if (!msg.tool_calls || msg.tool_calls.length === 0) {
            if (toolLog.length > 0) {
              send({ type: "actions", actions: toolLog });
            }
            const text: string = msg.content ?? "";
            const chunks = text.match(/.{1,8}/g) ?? [text];
            for (const chunk of chunks) {
              send({ choices: [{ delta: { content: chunk } }] });
            }
            send("[DONE]");
            break;
          }

          chatMessages.push({ role: "assistant", content: msg.content ?? null, tool_calls: msg.tool_calls });

          for (const tc of msg.tool_calls as Array<{ id: string; function: { name: string; arguments: string } }>) {
            const toolName = tc.function.name;
            let toolArgs: Record<string, unknown> = {};
            try { toolArgs = JSON.parse(tc.function.arguments ?? "{}"); } catch {}

            send({ type: "tool_start", tool: toolName, args: toolArgs });
            const result = await executeTool(toolName, toolArgs);
            send({ type: "tool_done", tool: toolName, result });

            toolLog.push({ tool: toolName, args: toolArgs, result });
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
