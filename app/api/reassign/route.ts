import { recheckAllVans } from "@/lib/recheck";

export const runtime = "nodejs";

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
