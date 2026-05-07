import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bookings, vans } from "@/drizzle/schema";
import { eq, and, ne } from "drizzle-orm";
import { z } from "zod";

const BookingPatchSchema = z.object({
  day: z.string().max(2).optional(),
  vehiclePlate: z.string().max(20).nullable().optional(),
  driverName: z.string().max(100).nullable().optional(),
  driverContact: z.string().max(50).nullable().optional(),
  paidStatus: z.string().max(1).optional(),
  inHouseOrOutsourced: z.enum(["I", "O"]).optional(),
  outsourcedCompany: z.string().max(200).optional(),
  outsourceReason: z.string().max(500).optional(),
  overtime: z.string().max(100).optional(),
  introducer: z.string().max(100).optional(),
  amount: z.union([z.string().max(50), z.number()]).optional(),
  clientDetails: z.string().max(1000).optional(),
  invoiceNo: z.string().max(100).optional(),
  details: z.string().max(500).optional(),
  passengerCount: z.number().int().min(0).optional(),
  myrPerVehicle: z.union([z.string().max(50), z.number()]).optional(),
  vanId: z.number().int().positive().nullable().optional(),
  manualChange: z.union([z.literal(0), z.literal(1)]).optional(),
  tripType: z.enum(["one_way_ride", "round_trip", "day_trip", "trip", "tpri"]).optional(),
  vehicleCategory: z.enum(["Van", "Alphard", "Car"]).optional(),
  isAlphardTrip: z.union([z.literal(0), z.literal(1)]).optional(),
  tourGuide: z.string().max(100).optional(),
  vehicleIndex: z.number().int().min(1).optional(),
  numberOfVehicles: z.number().int().min(1).optional(),
  travelDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD").optional(),
  month: z.string().max(20).optional(),
  year: z.string().max(4).optional(),
  fromLocation: z.string().max(200).optional(),
  toLocation: z.string().max(200).optional(),
});

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id: idStr } = await context.params;
    const id = parseInt(idStr, 10);
    if (isNaN(id)) {
      return NextResponse.json({ error: "Invalid id" }, { status: 400 });
    }

    const rawBody = await request.json();
    console.log("PATCH bookings/", id, rawBody);

    const validation = BookingPatchSchema.safeParse(rawBody);
    if (!validation.success) return NextResponse.json({ error: "Validation failed", details: validation.error.flatten().fieldErrors }, { status: 400 });
    const body = validation.data;

    const updates: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (key === "amount" || key === "myrPerVehicle") {
        updates[key] = value != null ? String(value) : null;
      } else {
        updates[key] = value;
      }
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
    }

    // Rule: switching to Outsourced ("O" or "outsourced") clears van assignment
    if (updates.inHouseOrOutsourced === "O" || updates.inHouseOrOutsourced === "outsourced") {
      updates.vanId = null;
      updates.vehiclePlate = null;
      updates.driverName = null;
      updates.driverContact = null;
    }

    const isManual = updates.manualChange === 1;

    // Double-booking check — only for non-manual changes.
    // Manual drag-and-drop is the user's explicit decision; let them place it
    // wherever they want without a 409 rejection.
    if (!isManual && "vanId" in updates && updates.vanId != null) {
      const newVanId = updates.vanId as number;

      const [current] = await db
        .select({ travelDate: bookings.travelDate })
        .from(bookings)
        .where(eq(bookings.id, id))
        .limit(1);

      if (current) {
        const checkDate = ("travelDate" in updates && typeof updates.travelDate === "string")
          ? updates.travelDate
          : current.travelDate;

        const conflict = await db
          .select({ id: bookings.id })
          .from(bookings)
          .where(
            and(
              eq(bookings.vanId, newVanId),
              eq(bookings.travelDate, checkDate),
              ne(bookings.id, id),
            )
          )
          .limit(1);

        if (conflict.length > 0) {
          const [van] = await db
            .select({ vanNumber: vans.vanNumber })
            .from(vans)
            .where(eq(vans.id, newVanId))
            .limit(1);
          const plate = van?.vanNumber ?? `#${newVanId}`;
          return NextResponse.json(
            { error: `Van ${plate} is already booked on ${checkDate}. Please choose another van.` },
            { status: 409 }
          );
        }
      }
    }

    const [updated] = await db
      .update(bookings)
      .set(updates)
      .where(eq(bookings.id, id))
      .returning();

    if (!updated) {
      return NextResponse.json({ error: "Booking not found" }, { status: 404 });
    }

    // Manual drag-and-drop: just save this one booking, leave everything else alone.
    // The user explicitly chose where to put it — do not cascade a full recheck.
    // (Use the Recheck button on the dashboard if a full reassignment is needed.)

    return NextResponse.json(updated);
  } catch (error) {
    console.error("PATCH /api/bookings/[id] error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id: idStr } = await context.params;
    const id = parseInt(idStr, 10);
    if (isNaN(id)) {
      return NextResponse.json({ error: "Invalid id" }, { status: 400 });
    }

    await db.delete(bookings).where(eq(bookings.id, id));

    return NextResponse.json({ message: "Booking deleted" });
  } catch (error) {
    console.error("DELETE /api/bookings/[id] error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
