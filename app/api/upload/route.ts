import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bookings, vans } from "@/drizzle/schema";
import { eq } from "drizzle-orm";
import { extractTravelBookings } from "@/lib/pdf-parser";
import { smartAssignVan } from "@/lib/van-assignment";

// pdf-parse requires Node.js built-ins (Buffer, fs, path) — not available in Edge runtime
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();

    const files = formData.getAll("file");
    if (files.length === 0) {
      return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
    }

    // Parse all files first, collect all bookings
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

    // Insert all with van assignment
    let totalInserted = 0;

    for (const booking of allParsed) {
      const assignResult = await smartAssignVan(
        booking.travelDate,
        booking.fromLocation,
        booking.invoiceNo,
        booking.vehicleIndex,
        booking.numberOfVehicles,
        booking.tripType,
      );

      // Determine if this booking should be outsourced
      const isOutsourced = typeof assignResult === "object" && "outsource" in assignResult;
      const vanId = isOutsourced ? null : (assignResult as number);

      let vehiclePlate: string | null = null;
      let driverName: string | null = null;
      let driverContact: string | null = null;

      if (!isOutsourced && vanId != null) {
        const [van] = await db.select().from(vans).where(eq(vans.id, vanId)).limit(1);
        if (van) {
          vehiclePlate = van.vanNumber;
          driverName = van.driverName ?? "";
          driverContact = van.driverContact ?? "";
        }
      }

      await db.insert(bookings).values({
        travelDate: booking.travelDate,
        fromLocation: booking.fromLocation,
        toLocation: booking.toLocation,
        isRoundTrip: booking.isRoundTrip,
        details: booking.details,
        vanId,
        manualChange: 0,
        invoiceNo: booking.invoiceNo,
        clientDetails: booking.clientDetails,
        day: booking.day,
        month: booking.month,
        year: booking.year,
        passengerCount: booking.numberOfVehicles,
        myrPerVehicle: String(booking.myrPerVehicle),
        // Store per-vehicle price as the row amount (not the invoice total)
        amount: String(booking.myrPerVehicle),
        vehiclePlate,
        driverName,
        driverContact,
        paidStatus: booking.paidStatus,
        overtime: booking.overtime,
        introducer: booking.introducer,
        inHouseOrOutsourced: isOutsourced ? "O" : (booking.inHouseOrOutsourced ?? "I"),
        outsourcedCompany: booking.outsourcedCompany,
        tripType: booking.tripType,
        vehicleIndex: booking.vehicleIndex,
        numberOfVehicles: booking.numberOfVehicles,
      });

      totalInserted++;
    }

    return NextResponse.json({ inserted: totalInserted });
  } catch (error: any) {
    console.error("Upload error:", error);
    console.error("Error stack:", error.stack);
    return NextResponse.json({ error: error.message, stack: error.stack }, { status: 422 });
  }
}
