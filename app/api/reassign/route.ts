import { recheckAllVans } from "@/lib/recheck";

export const runtime = "nodejs";

/**
 * POST /api/reassign
 *
 * Streams real-time log lines as Server-Sent Events while running the full
 * recheck from scratch:
 *   1. Reset all auto-managed bookings
 *   2. Reassign vans with priority ordering (day_trip > one_way > round_trip > trip)
 *   3. Enforce same-invoice-same-van per (invoiceNo, vehicleIndex) slot
 *   4. Eliminate any remaining double-bookings
 *   5. Mark still-unassigned as outsourced
 *
 * SSE event format:
 *   data: <log line>\n\n          — a log message
 *   data: [DONE]\n\n              — recheck finished successfully
 *   data: [ERROR] <message>\n\n  — recheck failed
 */
export async function POST() {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (msg: string) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(msg)}\n\n`));
      };

      try {
        await recheckAllVans(send);
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
