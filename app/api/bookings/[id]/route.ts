import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bookings } from "@/drizzle/schema";
import { eq } from "drizzle-orm";

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
    return NextResponse.json({ message: "Booking deleted" });
  } catch (error) {
    console.error("DELETE /api/bookings/[id] error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
