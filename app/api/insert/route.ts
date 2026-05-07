import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { bookings } from "@/drizzle/schema";
import { recheckAllVans } from "@/lib/recheck";
import { z } from "zod";

const InsertRowSchema = z.object({
  travelDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD"),
  fromLocation: z.string().min(1).max(200),
  toLocation: z.string().max(200).default(""),
  invoiceNo: z.string().max(100).default(""),
  tripType: z.enum(["one_way_ride", "round_trip", "day_trip", "trip"]),
  vehicleCategory: z.enum(["Van", "Alphard", "Car"]),
  isAlphardTrip: z.union([z.literal(0), z.literal(1)]),
  is15PaxTrip: z.union([z.literal(0), z.literal(1)]),
  vehicleIndex: z.number().int().min(1),
  numberOfVehicles: z.number().int().min(1),
  isRoundTrip: z.union([z.literal(0), z.literal(1)]).default(0),
  details: z.string().max(500).default(""),
  clientDetails: z.string().max(1000).default(""),
  day: z.string().max(2).default(""),
  month: z.string().max(20).default(""),
  year: z.string().max(4).default(""),
  myrPerVehicle: z.number().default(0),
  amount: z.number().default(0),
  vehiclePlate: z.string().max(20).default(""),
  driverName: z.string().max(100).default(""),
  paidStatus: z.string().max(1).default("U"),
  inHouseOrOutsourced: z.enum(["I", "O"]).default("I"),
  outsourcedCompany: z.string().max(200).default(""),
  overtime: z.string().max(100).default(""),
  introducer: z.string().max(100).default(""),
});

const InsertSchema = z.object({
  bookings: z.array(InsertRowSchema).min(1),
});

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); } catch {}
      };

      try {
        const parsed = InsertSchema.safeParse(await request.json());
        if (!parsed.success) {
          send({ type: "error", error: "Validation failed", details: parsed.error.flatten().fieldErrors });
          controller.close();
          return;
        }
        const rows = parsed.data.bookings;

        send({ type: "parsed", total: rows.length });

        const inserted = await db.insert(bookings).values(
          rows.map((booking) => ({
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
            amount: String(booking.amount),
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
            is15PaxTrip: booking.is15PaxTrip,
            vehicleCategory: booking.vehicleCategory,
            vehicleIndex: booking.vehicleIndex,
            numberOfVehicles: booking.numberOfVehicles,
          }))
        ).returning({ id: bookings.id });
        const insertedIds = inserted.map((r) => r.id);
        // Include insertedIds so the client can call /api/cancel-insert if needed
        send({ type: "progress", inserted: rows.length, total: rows.length, insertedIds });

        send({ type: "recheck" });

        await recheckAllVans((msg) => {
          send({ type: "recheck_log", message: msg });
        });

        send({ type: "done", inserted: rows.length });
        controller.close();
      } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.error("Insert error:", err);
        const send2 = (data: object) => {
          try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); } catch {}
        };
        send2({ type: "error", error: err.message });
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
