import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bookings, vans } from "@/drizzle/schema";
import { eq } from "drizzle-orm";
import { runReassign } from "@/lib/reassign";

export const runtime = "nodejs";

/**
 * POST /api/bookings/[id]/reassign
 *
 * Trigger smart van assignment for a single booking.
 * Called when a row is switched back from Outsourced ("O") to In-house ("I").
 * The booking must already have manualChange = 0 and vanId = null before calling.
 *
 * Returns the updated booking row (same shape as GET /api/bookings).
 */
export async function POST(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id: idStr } = await context.params;
    const id = parseInt(idStr, 10);
    if (isNaN(id)) {
      return NextResponse.json({ error: "Invalid id" }, { status: 400 });
    }

    await runReassign([id]);

    // Return the updated row with the same JOIN shape as GET /api/bookings
    const [updated] = await db
      .select({
        id: bookings.id,
        travelDate: bookings.travelDate,
        fromLocation: bookings.fromLocation,
        toLocation: bookings.toLocation,
        isRoundTrip: bookings.isRoundTrip,
        details: bookings.details,
        vanId: bookings.vanId,
        vanNumber: vans.vanNumber,
        manualChange: bookings.manualChange,
        invoiceNo: bookings.invoiceNo,
        clientDetails: bookings.clientDetails,
        amount: bookings.amount,
        passengerCount: bookings.passengerCount,
        myrPerVehicle: bookings.myrPerVehicle,
        vehiclePlate: bookings.vehiclePlate,
        driverName: bookings.driverName,
        driverContact: bookings.driverContact,
        paidStatus: bookings.paidStatus,
        overtime: bookings.overtime,
        introducer: bookings.introducer,
        inHouseOrOutsourced: bookings.inHouseOrOutsourced,
        outsourcedCompany: bookings.outsourcedCompany,
        day: bookings.day,
        month: bookings.month,
        year: bookings.year,
        tripType: bookings.tripType,
        tourGuide: bookings.tourGuide,
        vehicleIndex: bookings.vehicleIndex,
        numberOfVehicles: bookings.numberOfVehicles,
      })
      .from(bookings)
      .leftJoin(vans, eq(bookings.vanId, vans.id))
      .where(eq(bookings.id, id))
      .limit(1);

    if (!updated) {
      return NextResponse.json({ error: "Booking not found" }, { status: 404 });
    }

    return NextResponse.json(updated);
  } catch (error) {
    console.error(`POST /api/bookings/[id]/reassign error:`, error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
