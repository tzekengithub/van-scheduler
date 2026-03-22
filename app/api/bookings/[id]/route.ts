import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bookings, vans } from "@/drizzle/schema";
import { eq, and, ne } from "drizzle-orm";
import { recheckAllVans } from "@/lib/recheck";

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

    const body = await request.json();
    console.log("PATCH bookings/", id, body);

    const allowed = [
      "day", "vehiclePlate", "driverName", "driverContact", "paidStatus",
      "inHouseOrOutsourced", "outsourcedCompany", "overtime", "introducer",
      "amount", "clientDetails", "invoiceNo", "details", "passengerCount",
      "myrPerVehicle", "vanId", "manualChange",
      "tripType", "tourGuide", "vehicleIndex", "numberOfVehicles",
    ] as const;

    const updates: Record<string, unknown> = {};
    for (const key of allowed) {
      if (key in body) {
        if (key === "amount" || key === "myrPerVehicle") {
          updates[key] = body[key] != null ? String(body[key]) : null;
        } else {
          updates[key] = body[key];
        }
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

    // Double-booking check: if vanId is being set, ensure the van is free on travelDate
    if ("vanId" in updates && updates.vanId != null) {
      const newVanId = updates.vanId as number;

      const [current] = await db
        .select({ travelDate: bookings.travelDate })
        .from(bookings)
        .where(eq(bookings.id, id))
        .limit(1);

      if (current) {
        const conflict = await db
          .select({ id: bookings.id })
          .from(bookings)
          .where(
            and(
              eq(bookings.vanId, newVanId),
              eq(bookings.travelDate, current.travelDate),
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
            { error: `Van ${plate} is already booked on ${current.travelDate}. Please choose another van.` },
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

    // Recheck the entire van schedule after deletion.
    // A deleted booking may free a van that allows other bookings to move from
    // outsourced back to in-house, or resolves cross-invoice conflicts.
    await recheckAllVans();

    return NextResponse.json({ message: "Booking deleted" });
  } catch (error) {
    console.error("DELETE /api/bookings/[id] error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
