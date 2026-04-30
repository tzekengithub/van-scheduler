import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bookings } from "@/drizzle/schema";
import { inArray, and, eq, or, isNull } from "drizzle-orm";

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

    // Safety guard: only delete auto-managed bookings (manualChange = 0) with no
    // confirmed outsource company, preventing stale/replayed requests from touching
    // user-locked or confirmed-outsourced rows.
    const { rowCount } = await db
      .delete(bookings)
      .where(
        and(
          inArray(bookings.id, ids),
          eq(bookings.manualChange, 0),
          or(
            isNull(bookings.outsourcedCompany),
            eq(bookings.outsourcedCompany, "")
          )
        )
      ) as unknown as { rowCount: number };

    return NextResponse.json({ deleted: rowCount ?? ids.length });
  } catch (err: unknown) {
    console.error("[cancel-insert]", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
