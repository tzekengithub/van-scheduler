import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bookings, vans } from "@/drizzle/schema";
import { eq, and, desc, asc } from "drizzle-orm";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const dayParam = searchParams.get("day");
    const monthParam = searchParams.get("month");
    const yearParam = searchParams.get("year");
    const latestFirst = searchParams.get("latestFirst") === "1";
    const recentCountParam = searchParams.get("recentCount");

    const conditions = [];
    if (dayParam) conditions.push(eq(bookings.day, dayParam));
    if (monthParam) conditions.push(eq(bookings.month, monthParam));
    if (yearParam) conditions.push(eq(bookings.year, yearParam));

    const base = db
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
        paidStatus: bookings.paidStatus,
        overtime: bookings.overtime,
        introducer: bookings.introducer,
        inHouseOrOutsourced: bookings.inHouseOrOutsourced,
        outsourcedCompany: bookings.outsourcedCompany,
        day: bookings.day,
        month: bookings.month,
        year: bookings.year,
      })
      .from(bookings)
      .leftJoin(vans, eq(bookings.vanId, vans.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined);

    let rows;
    if (latestFirst) {
      rows = await base.orderBy(desc(bookings.id)).limit(1);
    } else if (recentCountParam) {
      const n = Math.max(1, parseInt(recentCountParam, 10) || 1);
      rows = await base.orderBy(desc(bookings.id)).limit(n);
    } else {
      rows = await base.orderBy(asc(bookings.invoiceNo), asc(bookings.amount));
    }

    return NextResponse.json(rows);
  } catch (error) {
    console.error("GET /api/bookings error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { day, month, year } = body;

    const monthNames: Record<string, string> = {
      January: "01", February: "02", March: "03", April: "04",
      May: "05", June: "06", July: "07", August: "08",
      September: "09", October: "10", November: "11", December: "12",
    };
    const monthNum = monthNames[month] ?? "01";
    const dayPadded = day ? String(day).padStart(2, "0") : "01";
    const travelDate = `${year}-${monthNum}-${dayPadded}`;

    const [inserted] = await db
      .insert(bookings)
      .values({
        travelDate,
        fromLocation: "",
        toLocation: "",
        isRoundTrip: 0,
        manualChange: 0,
        day: day ? String(day) : "",
        month: month ?? "",
        year: year ?? "",
        paidStatus: "U",
        inHouseOrOutsourced: "I",
      })
      .returning();

    return NextResponse.json(inserted, { status: 201 });
  } catch (error) {
    console.error("POST /api/bookings error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
