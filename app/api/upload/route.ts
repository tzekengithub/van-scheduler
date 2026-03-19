import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bookings } from "@/drizzle/schema";
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

        await db.insert(bookings).values({
          travelDate: booking.travelDate,
          fromLocation: booking.fromLocation,
          toLocation: booking.toLocation,
          isRoundTrip: booking.isRoundTrip,
          details: booking.details,
          vanId,
          manualChange: 0,
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
