import { NextResponse } from "next/server";
import { recheckAllVans } from "@/lib/recheck";

export const runtime = "nodejs";

/**
 * POST /api/reassign
 *
 * Full recheck from scratch — runs every step in order:
 *   1. Reset all auto-managed bookings
 *   2. Reassign vans with priority ordering (day_trip > one_way > round_trip > trip)
 *   3. Enforce same-invoice-same-van per (invoiceNo, vehicleIndex) slot
 *   4. Eliminate any remaining double-bookings
 *   5. Mark still-unassigned as outsourced
 */
export async function POST() {
  try {
    await recheckAllVans();
    return NextResponse.json({ ok: true });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[reassign] error:", error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
