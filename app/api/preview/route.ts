import { NextRequest, NextResponse } from "next/server";
import { extractTravelBookings } from "@/lib/pdf-parser";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const files = formData.getAll("file");
    if (files.length === 0) {
      return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
    }

    const allParsed: import("@/lib/pdf-parser").ParsedBooking[] = [];
    const allSkipped: import("@/lib/pdf-parser").SkippedRow[] = [];
    for (const entry of files) {
      if (typeof entry === "string") continue;
      const arrayBuffer = await entry.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const { bookings: parsed, skipped } = await extractTravelBookings(buffer);
      allParsed.push(...parsed);
      allSkipped.push(...skipped);
    }

    return NextResponse.json({ bookings: allParsed, skipped: allSkipped });
  } catch (error: unknown) {
    console.error("POST /api/preview error:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 422 });
  }
}
