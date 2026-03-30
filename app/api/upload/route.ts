import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bookings } from "@/drizzle/schema";
import { extractTravelBookings, parseRawText } from "@/lib/pdf-parser";
import { recheckAllVans } from "@/lib/recheck";

// pdf-parse requires Node.js built-ins (Buffer, fs, path) — not available in Edge runtime
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); } catch {}
      };

      try {
        const formData = await request.formData();
        const files = formData.getAll("file");

        if (files.length === 0) {
          send({ type: "error", error: "No file uploaded" });
          controller.close();
          return;
        }

        const pythonServiceUrl = process.env.PDF_SERVICE_URL;
        if (!pythonServiceUrl) {
          send({ type: "error", error: "PDF_SERVICE_URL not configured" });
          controller.close();
          return;
        }

        // Parse all files, collect all bookings — with per-file diagnostics
        const allParsed: Awaited<ReturnType<typeof extractTravelBookings>> = [];
        const fileErrors: string[] = [];

        for (const entry of files) {
          if (typeof entry === "string") continue;
          const fileName = (entry as File).name ?? "unknown";
          try {
            const arrayBuffer = await entry.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            console.log(`[upload] ${fileName}: buffer size=${buffer.length}`);

            const response = await fetch(`${pythonServiceUrl}/parse`, {
              method: "POST",
              headers: { "Content-Type": "application/pdf" },
              body: new Uint8Array(buffer),
            });

            if (!response.ok) {
              const errBody = await response.text();
              const msg = `PDF service returned ${response.status} for ${fileName}: ${errBody.slice(0, 200)}`;
              console.error(`[upload] ${msg}`);
              fileErrors.push(msg);
              continue;
            }

            const json = await response.json();
            const text: string = json.text ?? "";
            console.log(`[upload] ${fileName}: text length=${text.length}, first 200 chars: ${text.slice(0, 200)}`);

            if (!text || text.trim().length < 10) {
              const msg = `PDF service returned empty text for ${fileName} (length=${text.length})`;
              console.error(`[upload] ${msg}`);
              fileErrors.push(msg);
              continue;
            }

            const parsed = parseRawText(text);
            console.log(`[upload] ${fileName}: parsed ${parsed.length} bookings`);
            allParsed.push(...parsed);
          } catch (fileErr: any) {
            const msg = `Error processing ${fileName}: ${fileErr.message}`;
            console.error(`[upload] ${msg}`);
            fileErrors.push(msg);
          }
        }

        if (fileErrors.length > 0 && allParsed.length === 0) {
          send({ type: "error", error: fileErrors[0], details: fileErrors });
          controller.close();
          return;
        }

        if (allParsed.length === 0) {
          send({ type: "done", inserted: 0 });
          controller.close();
          return;
        }

        // Signal how many rows are about to be inserted
        send({ type: "parsed", total: allParsed.length });

        // Insert bookings one-by-one, streaming progress after each insert
        for (let i = 0; i < allParsed.length; i++) {
          const booking = allParsed[i];
          await db.insert(bookings).values({
            travelDate: booking.travelDate,
            fromLocation: booking.fromLocation,
            toLocation: booking.toLocation,
            isRoundTrip: booking.isRoundTrip,
            details: booking.details,
            vanId: null,
            manualChange: 0,
            invoiceNo: booking.invoiceNo,
            clientDetails: booking.clientDetails,
            day: booking.day,
            month: booking.month,
            year: booking.year,
            passengerCount: 0,
            myrPerVehicle: String(booking.myrPerVehicle),
            amount: String(booking.myrPerVehicle),
            vehiclePlate: null,
            driverName: null,
            driverContact: null,
            paidStatus: booking.paidStatus,
            overtime: booking.overtime,
            introducer: booking.introducer,
            inHouseOrOutsourced: booking.inHouseOrOutsourced,
            outsourcedCompany: booking.outsourcedCompany,
            tripType: booking.tripType,
            isAlphardTrip: booking.isAlphardTrip,
            vehicleCategory: booking.vehicleCategory,
            vehicleIndex: booking.vehicleIndex,
            numberOfVehicles: booking.numberOfVehicles,
          });
          send({ type: "progress", inserted: i + 1, total: allParsed.length });
        }

        // Run a full van schedule recheck — assigns vans to all unassigned bookings
        send({ type: "recheck" });
        await recheckAllVans();

        send({ type: "done", inserted: allParsed.length });
        controller.close();
      } catch (error: any) {
        console.error("Upload error:", error);
        console.error("Error stack:", error.stack);
        send({ type: "error", error: error.message });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
