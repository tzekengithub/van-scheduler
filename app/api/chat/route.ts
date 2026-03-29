import { NextRequest } from "next/server";
import { buildScheduleContext } from "@/lib/chat-context";

export const runtime = "nodejs";

const SYSTEM_PROMPT_TEMPLATE = (scheduleContext: string) => `You are the scheduling assistant for Excellent Travel, a Malaysian van transport company. You have full visibility into the current van schedule and booking system.

CURRENT SCHEDULE DATA:
${scheduleContext}

YOUR ROLE:
- Answer questions about the schedule, bookings, vans, and drivers
- Identify conflicts, problems, and optimization opportunities
- Suggest actions the user should take manually when needed
- Be concise and direct — this is an operational tool, not a general assistant
- Always respond in the same language the user writes in (English, Bahasa Malaysia, or Mandarin)
- When you identify something the user needs to do manually, format it clearly as:
    ACTION NEEDED: [what to do] → [where in the app to do it]

THINGS YOU CAN TELL THE USER TO DO MANUALLY:
- Assign a specific van to a booking → Daily Jobs or All Jobs page
- Fill in outsourced company name → Van Schedule page conflict banner or All Jobs page
- Mark a booking as paid → Daily Jobs or All Jobs page
- Reset a manually-changed booking to auto → click Reset to auto on the booking row
- Remove duplicate bookings → Dashboard → Remove Duplicates
- Add or remove a van → Dashboard → Van Management

THINGS YOU CANNOT DO:
- You cannot make changes to the database directly
- You cannot trigger a recheck or upload
- Always be clear about this when relevant`;

export async function POST(request: NextRequest) {
  try {
    const { messages } = await request.json();

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "OPENROUTER_API_KEY not configured" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const scheduleContext = await buildScheduleContext();
    const systemPrompt = SYSTEM_PROMPT_TEMPLATE(scheduleContext);

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://van-scheduler.vercel.app",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash-preview",
        temperature: 0.3,
        stream: true,
        messages: [{ role: "system", content: systemPrompt }, ...messages],
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      return new Response(
        JSON.stringify({ error: `AI service error: ${response.status} ${errText.slice(0, 200)}` }),
        { status: 502, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(response.body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });
  } catch (err) {
    console.error("[/api/chat] error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
