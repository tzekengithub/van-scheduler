import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bookings, vans } from "@/drizzle/schema";
import { eq, and } from "drizzle-orm";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const monthParam = searchParams.get("month");
    const yearParam = searchParams.get("year");

    const conditions = [];
    if (monthParam) conditions.push(eq(bookings.month, monthParam));
    if (yearParam) conditions.push(eq(bookings.year, yearParam));

    const rows = await db
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
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(bookings.travelDate, bookings.id);

    return NextResponse.json(rows);
  } catch (error) {
    console.error("GET /api/bookings error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { month, year } = body;

    // Derive travelDate from year+month
    const monthNames: Record<string, string> = {
      January: "01", February: "02", March: "03", April: "04",
      May: "05", June: "06", July: "07", August: "08",
      September: "09", October: "10", November: "11", December: "12",
    };
    const monthNum = monthNames[month] ?? "01";
    const travelDate = `${year}-${monthNum}-01`;

    const [inserted] = await db
      .insert(bookings)
      .values({
        travelDate,
        fromLocation: "",
        toLocation: "",
        isRoundTrip: 0,
        manualChange: 0,
        month: month ?? "",
        year: year ?? "",
        day: "",
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
