import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { sql } from 'drizzle-orm'

export async function DELETE() {
  try {
    await db.execute(sql`
      DELETE FROM bookings
      WHERE id IN (
        SELECT id FROM (
          SELECT id,
            ROW_NUMBER() OVER (
              PARTITION BY
                invoice_no,
                vehicle_index,
                travel_date,
                from_location,
                to_location,
                amount,
                client_details
              ORDER BY id ASC
            ) AS rn
          FROM bookings
          WHERE invoice_no IS NOT NULL
        ) ranked
        WHERE rn > 1
      )
    `)

    return NextResponse.json({
      success: true,
      message: 'Duplicates removed',
    })
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message },
      { status: 500 }
    )
  }
}
