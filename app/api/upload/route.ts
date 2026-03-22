import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bookings } from "@/drizzle/schema";
import { extractTravelBookings } from "@/lib/pdf-parser";
import { recheckAllVans } from "@/lib/recheck";

// pdf-parse requires Node.js built-ins (Buffer, fs, path) — not available in Edge runtime
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();

    const files = formData.getAll("file");
    if (files.length === 0) {
      return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
    }

    // Parse all files, collect all bookings
    const allParsed: Awaited<ReturnType<typeof extractTravelBookings>> = [];
    for (const entry of files) {
      if (typeof entry === "string") continue;
      const arrayBuffer = await entry.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const parsed = await extractTravelBookings(buffer);
      allParsed.push(...parsed);
    }

    if (allParsed.length === 0) {
      return NextResponse.json(
        { error: "No bookings found in the uploaded PDF(s). Check the file format." },
        { status: 422 }
      );
    }

    // Insert all parsed bookings without van assignment.
    // recheckAllVans() below will assign vans to everything in one pass.
    for (const booking of allParsed) {
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
        inHouseOrOutsourced: "I",
        outsourcedCompany: booking.outsourcedCompany,
        tripType: booking.tripType,
        vehicleIndex: booking.vehicleIndex,
        numberOfVehicles: booking.numberOfVehicles,
      });
    }

    // Run a full van schedule recheck — assigns vans to all unassigned bookings,
    // and marks any that still can't get a van as outsourced (I/O = 'O').
    await recheckAllVans();

    return NextResponse.json({ inserted: allParsed.length });
  } catch (error: any) {
    console.error("Upload error:", error);
    console.error("Error stack:", error.stack);
    return NextResponse.json({ error: error.message, stack: error.stack }, { status: 422 });
  }
}
