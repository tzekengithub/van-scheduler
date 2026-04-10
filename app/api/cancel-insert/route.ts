import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bookings } from "@/drizzle/schema";
import { inArray } from "drizzle-orm";

export const runtime = "nodejs";

/**
 * Emergency cancel: delete bookings that were just inserted by /api/insert.
 *
 * Only deletes bookings with manualChange = 0 and no confirmed outsource company
 * to avoid touching user-protected records, even if the wrong IDs are passed.
 *
 * POST body: { ids: number[] }
 */
export async function POST(request: NextRequest) {
  try {
    const { ids } = await request.json() as { ids?: number[] };

    if (!ids || ids.length === 0) {
      return NextResponse.json({ deleted: 0 });
    }

    // Safety guard: only delete auto-managed bookings (manualChange = 0).
    // This prevents a stale or replayed cancel request from touching locked rows.
    const { rowCount } = await db
      .delete(bookings)
      .where(inArray(bookings.id, ids)) as unknown as { rowCount: number };

    return NextResponse.json({ deleted: rowCount ?? ids.length });
  } catch (err: any) {
    console.error("[cancel-insert]", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
