import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { bookings } from '@/drizzle/schema'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  try {
    const { bookings: pendingBookings } = await request.json()

    for (const booking of pendingBookings) {
      await db.insert(bookings).values({
        travelDate: booking.travelDate,
        fromLocation: booking.fromLocation,
        toLocation: booking.toLocation,
        isRoundTrip: booking.isRoundTrip,
        details: booking.details,
        vanId: booking.vanId || null,
        manualChange: 0,
        invoiceNo: booking.invoiceNo,
        clientDetails: booking.clientDetails,
        day: booking.day,
        month: booking.month,
        year: booking.year,
        passengerCount: booking.passengerCount || 1,
        myrPerVehicle: String(booking.myrPerVehicle || 0),
        amount: String(booking.amount || 0),
        vehiclePlate: booking.vehiclePlate || '',
        driverName: booking.driverName || '',
        paidStatus: 'U',
        inHouseOrOutsourced: 'I',
        outsourcedCompany: '',
        overtime: '',
        introducer: '',
      })
    }

    return NextResponse.json({
      success: true,
      inserted: pendingBookings.length,
    })
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message },
      { status: 500 }
    )
  }
}
