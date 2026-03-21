import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bookings, vans } from "@/drizzle/schema";
import { eq, asc } from "drizzle-orm";
import { smartAssignVan } from "@/lib/van-assignment";

export const runtime = "nodejs";

/**
 * POST /api/reassign
 *
 * Full re-assignment from scratch. Enforces the golden rule: 1 van = 1 job per day.
 *
 * Algorithm:
 *   1. Clear vanId on all auto-assigned rows (manualChange = 0).
 *   2. Fetch all bookings ordered by travelDate ASC, then invoiceNo, then vehicleIndex.
 *   3. Process one booking at a time in date order.
 *   4. For each: apply RULE 1 → RULE 2 → RULE 3 via smartAssignVan().
 *   5. Commit the van assignment to the DB immediately so the next booking
 *      sees accurate availability (critical for multi-vehicle same-date).
 *   6. Rows with manualChange = 1 are skipped entirely (their vanId is preserved).
 */
export async function POST() {
  try {
    const allVans = await db.select().from(vans);
    const vanMap = new Map(allVans.map((v) => [v.id, v]));

    console.log(
      `[reassign] vans=${allVans.length}:`,
      allVans.map((v) => `${v.id}:${v.vanNumber}`).join(", ")
    );

    // ── Step 1: Clear all auto-assigned vans ────────────────────────────────────
    const cleared = await db
      .update(bookings)
      .set({ vanId: null })
      .where(eq(bookings.manualChange, 0))
      .returning({ id: bookings.id });

    console.log(`[reassign] cleared ${cleared.length} auto-assignments`);

    // ── Step 2: Fetch all bookings in date order ─────────────────────────────────
    const allBookings = await db
      .select()
      .from(bookings)
      .orderBy(
        asc(bookings.travelDate),
        asc(bookings.invoiceNo),
        asc(bookings.vehicleIndex)
      );

    console.log(`[reassign] processing ${allBookings.length} bookings in date order`);

    let assigned = 0;
    let conflicts = 0;
    let skippedManual = 0;

    for (const b of allBookings) {
      // ── Step 6: Preserve manualChange rows ──────────────────────────────────
      if (b.manualChange === 1) {
        console.log(
          `  SKIP  id=${b.id} ${b.invoiceNo ?? "no-inv"} date=${b.travelDate} vi=${b.vehicleIndex} (manualChange=1 → vanId=${b.vanId})`
        );
        skippedManual++;
        continue;
      }

      // ── Steps 3-4: Determine van via rules ──────────────────────────────────
      const vanId = await smartAssignVan(
        b.travelDate,
        b.fromLocation,
        b.invoiceNo ?? "",
        b.vehicleIndex ?? 1,
        b.numberOfVehicles ?? 1,
        b.tripType,
      );

      // ── Step 5: Commit to DB immediately ────────────────────────────────────
      if (vanId != null) {
        const van = vanMap.get(vanId);
        await db
          .update(bookings)
          .set({
            vanId,
            vehiclePlate: van?.vanNumber ?? "",
            driverName: van?.driverName ?? "",
            driverContact: van?.driverContact ?? "",
          })
          .where(eq(bookings.id, b.id));

        console.log(
          `  OK    id=${b.id} ${b.invoiceNo ?? "no-inv"} date=${b.travelDate} vi=${b.vehicleIndex} → van ${vanId} (${van?.vanNumber ?? "?"})`
        );
        assigned++;
      } else {
        await db
          .update(bookings)
          .set({ vanId: null, vehiclePlate: "", driverName: "", driverContact: "" })
          .where(eq(bookings.id, b.id));

        console.log(
          `  CONFLICT id=${b.id} ${b.invoiceNo ?? "no-inv"} date=${b.travelDate} vi=${b.vehicleIndex} → no free van`
        );
        conflicts++;
      }
    }

    console.log(
      `\n[reassign] done — assigned=${assigned} conflicts=${conflicts} skippedManual=${skippedManual}`
    );

    return NextResponse.json({ assigned, conflicts, skippedManual });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[reassign] error:", error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
