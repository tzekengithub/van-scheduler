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

    // Support single or multiple files under the "file" key
    const files = formData.getAll("file");
    if (files.length === 0) {
      return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
    }

    let totalInserted = 0;

    for (const entry of files) {
      if (typeof entry === "string") continue;

      // Convert File/Blob to Buffer in memory — no disk writes (Vercel compatible)
      const arrayBuffer = await entry.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      const parsed = await extractTravelBookings(buffer);

      if (parsed.length === 0) continue;

      // Insert in document order so smart assign sees prior insertions
      for (const booking of parsed) {
        const vanId = await smartAssignVan(booking.travelDate, booking.fromLocation);

        // Fetch the assigned van to auto-fill plate and driver name
        let vehiclePlate = booking.vehiclePlate;
        let driverName = booking.driverName;
        if (vanId != null) {
          const [van] = await db.select().from(vans).where(eq(vans.id, vanId)).limit(1);
          if (van) {
            vehiclePlate = van.vanNumber;
            driverName = van.driverName ?? "";
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
          amount: String(booking.amount),
          vehiclePlate,
          driverName,
          paidStatus: booking.paidStatus,
          overtime: booking.overtime,
          introducer: booking.introducer,
          inHouseOrOutsourced: booking.inHouseOrOutsourced,
          outsourcedCompany: booking.outsourcedCompany,
        });

        totalInserted++;
      }
    }

    if (totalInserted === 0) {
      return NextResponse.json(
        { error: "No bookings found in the uploaded PDF(s). Check the file format." },
        { status: 422 }
      );
    }

    return NextResponse.json({
      message: `Inserted ${totalInserted} booking${totalInserted !== 1 ? "s" : ""}`,
      count: totalInserted,
    });
  } catch (error) {
    console.error("POST /api/upload error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
