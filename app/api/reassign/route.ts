import { aiRecheckAllVans } from "@/lib/ai-scheduler";

export const runtime = "nodejs";

/**
 * POST /api/reassign
 *
 * Streams real-time log lines as Server-Sent Events while running the full
 * AI-powered recheck from scratch. Falls back to the rules engine if AI fails.
 *
 * SSE event format:
 *   data: <log line>\n\n               — a log message (JSON-encoded string)
 *   data: "[AI_SUMMARY]{...}"\n\n      — JSON payload with summary + reasoning
 *   data: "[DONE]"\n\n                 — recheck finished successfully
 *   data: "[ERROR] <message>"\n\n      — recheck failed
 */
export async function POST() {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (msg: string) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(msg)}\n\n`));
      };

      try {
        const result = await aiRecheckAllVans(send);
        send(`[AI_SUMMARY]${JSON.stringify({ summary: result.summary, reasoning: result.reasoning })}`);
        send("[DONE]");
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error("[reassign] error:", error);
        send(`[ERROR] ${msg}`);
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
