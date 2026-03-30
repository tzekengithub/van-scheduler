import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { bookings } from "@/drizzle/schema";
import { aiRecheckAllVans } from "@/lib/ai-scheduler";
import type { ParsedBooking } from "@/lib/pdf-parser";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); } catch {}
      };

      try {
        const { bookings: rows }: { bookings: ParsedBooking[] } = await request.json();

        if (!rows || rows.length === 0) {
          send({ type: "done", inserted: 0 });
          controller.close();
          return;
        }

        send({ type: "parsed", total: rows.length });

        const insertedIds: number[] = [];

        for (let i = 0; i < rows.length; i++) {
          const booking = rows[i];
          const [inserted] = await db.insert(bookings).values({
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
          }).returning({ id: bookings.id });
          insertedIds.push(inserted.id);
          send({ type: "progress", inserted: i + 1, total: rows.length });
        }

        send({ type: "recheck" });

        // Pass the newly inserted IDs so the AI knows which bookings are new.
        // Existing assigned bookings are still visible to the AI (for bumping)
        // but flagged as isNew=false — it won't touch them unless a new
        // higher-priority trip needs their exact van+date slot.
        const { summary, reasoning } = await aiRecheckAllVans((msg) => {
          send({ type: "recheck_log", message: msg });
        }, insertedIds);

        send({ type: "ai_summary", summary, reasoning });
        send({ type: "done", inserted: rows.length });
        controller.close();
      } catch (error: any) {
        console.error("Insert error:", error);
        const send2 = (data: object) => {
          try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); } catch {}
        };
        send2({ type: "error", error: error.message });
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
