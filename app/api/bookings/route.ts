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
    const invoiceNoParam = searchParams.get("invoiceNo");
    const latestFirst = searchParams.get("latestFirst") === "1";
    const recentCountParam = searchParams.get("recentCount");

    const conditions = [];
    if (dayParam) conditions.push(eq(bookings.day, dayParam));
    if (monthParam) conditions.push(eq(bookings.month, monthParam));
    if (yearParam) conditions.push(eq(bookings.year, yearParam));
    if (invoiceNoParam) conditions.push(eq(bookings.invoiceNo, invoiceNoParam));

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
        driverContact: bookings.driverContact,
        paidStatus: bookings.paidStatus,
        overtime: bookings.overtime,
        introducer: bookings.introducer,
        inHouseOrOutsourced: bookings.inHouseOrOutsourced,
        outsourcedCompany: bookings.outsourcedCompany,
        outsourceReason: bookings.outsourceReason,
        day: bookings.day,
        month: bookings.month,
        year: bookings.year,
        tripType: bookings.tripType,
        tourGuide: bookings.tourGuide,
        vehicleIndex: bookings.vehicleIndex,
        numberOfVehicles: bookings.numberOfVehicles,
        vehicleCategory: bookings.vehicleCategory,
        isAlphardTrip: bookings.isAlphardTrip,
        is15PaxTrip: bookings.is15PaxTrip,
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
    } else if (conditions.length > 0) {
      rows = await base.orderBy(asc(bookings.invoiceNo), asc(bookings.amount));
    } else {
      // No date filter (all-jobs) — order by travel date ascending
      rows = await base.orderBy(asc(bookings.travelDate));
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
        passengerCount: null,
        paidStatus: "U",
        inHouseOrOutsourced: "I",
        tripType: "trip",
        vehicleIndex: 1,
        numberOfVehicles: 1,
      })
      .returning();

    return NextResponse.json(inserted, { status: 201 });
  } catch (error) {
    console.error("POST /api/bookings error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const invoiceNo = new URL(request.url).searchParams.get("invoiceNo")?.trim();
    if (!invoiceNo) {
      return NextResponse.json({ error: "invoiceNo query param is required" }, { status: 400 });
    }

    const body = await request.json().catch(() => ({})) as { confirmInvoiceNo?: string };
    if (body.confirmInvoiceNo !== invoiceNo) {
      return NextResponse.json({ error: "Confirmation invoice number does not match" }, { status: 400 });
    }

    const deleted = await db
      .delete(bookings)
      .where(eq(bookings.invoiceNo, invoiceNo))
      .returning({ id: bookings.id });

    if (deleted.length === 0) {
      return NextResponse.json({ error: `No bookings found for invoice ${invoiceNo}` }, { status: 404 });
    }

    return NextResponse.json({ deleted: deleted.length, invoiceNo });
  } catch (error) {
    console.error("DELETE /api/bookings error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
