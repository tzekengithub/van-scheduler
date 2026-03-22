import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bookings } from "@/drizzle/schema";
import { extractTravelBookings, parseRawText } from "@/lib/pdf-parser";
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

    const pythonServiceUrl = process.env.PDF_SERVICE_URL;
    if (!pythonServiceUrl) {
      return NextResponse.json({ error: "PDF_SERVICE_URL not configured" }, { status: 500 });
    }

    // Parse all files, collect all bookings — with per-file diagnostics
    const allParsed: Awaited<ReturnType<typeof extractTravelBookings>> = [];
    const fileErrors: string[] = [];

    for (const entry of files) {
      if (typeof entry === "string") continue;
      const fileName = (entry as File).name ?? "unknown";
      try {
        const arrayBuffer = await entry.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        console.log(`[upload] ${fileName}: buffer size=${buffer.length}`);

        // Call Python service directly so we can log the raw text
        const response = await fetch(`${pythonServiceUrl}/parse`, {
          method: "POST",
          headers: { "Content-Type": "application/pdf" },
          body: new Uint8Array(buffer),
        });

        if (!response.ok) {
          const errBody = await response.text();
          const msg = `PDF service returned ${response.status} for ${fileName}: ${errBody.slice(0, 200)}`;
          console.error(`[upload] ${msg}`);
          fileErrors.push(msg);
          continue;
        }

        const json = await response.json();
        const text: string = json.text ?? "";
        console.log(`[upload] ${fileName}: text length=${text.length}, first 200 chars: ${text.slice(0, 200)}`);

        if (!text || text.trim().length < 10) {
          const msg = `PDF service returned empty text for ${fileName} (length=${text.length})`;
          console.error(`[upload] ${msg}`);
          fileErrors.push(msg);
          continue;
        }

        const parsed = parseRawText(text);
        console.log(`[upload] ${fileName}: parsed ${parsed.length} bookings`);
        allParsed.push(...parsed);
      } catch (fileErr: any) {
        const msg = `Error processing ${fileName}: ${fileErr.message}`;
        console.error(`[upload] ${msg}`);
        fileErrors.push(msg);
      }
    }

    if (fileErrors.length > 0 && allParsed.length === 0) {
      // All files had hard errors (service down, bad response, etc.)
      return NextResponse.json(
        { error: fileErrors[0], details: fileErrors },
        { status: 422 }
      );
    }

    if (allParsed.length === 0) {
      // No bookings found but no hard errors — file just has no parseable rows (e.g. overtime-only)
      return NextResponse.json({ inserted: 0 });
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
