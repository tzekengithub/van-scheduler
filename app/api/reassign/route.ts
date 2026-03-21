import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bookings } from "@/drizzle/schema";
import { eq } from "drizzle-orm";
import { runReassign } from "@/lib/reassign";

export const runtime = "nodejs";

/**
 * POST /api/reassign
 *
 * Full re-assignment from scratch. Enforces the golden rule: 1 van = 1 job per day.
 *
 *   1. Clear vanId on ALL auto-assigned rows (manualChange = 0).
 *   2. Call runReassign() to re-process all now-null bookings in date order.
 *   3. Rows with manualChange = 1 are never touched.
 */
export async function POST() {
  try {
    // Clear all auto-assigned vans so we start fresh
    const cleared = await db
      .update(bookings)
      .set({ vanId: null })
      .where(eq(bookings.manualChange, 0))
      .returning({ id: bookings.id });

    console.log(`[reassign] cleared ${cleared.length} auto-assignments`);

    const result = await runReassign();

    console.log(
      `[reassign] done — assigned=${result.assigned} conflicts=${result.conflicts}`
    );

    return NextResponse.json({ ...result, skippedManual: cleared.length - result.assigned - result.conflicts });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[reassign] error:", error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
