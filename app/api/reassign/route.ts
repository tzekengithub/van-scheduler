import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bookings, vans } from "@/drizzle/schema";
import { eq } from "drizzle-orm";
import { smartAssignVan } from "@/lib/van-assignment";

export const runtime = "nodejs";

/**
 * POST /api/reassign
 *
 * Force-reassigns vans to all unassigned (or inconsistently assigned) invoice groups.
 *
 * Logic per invoice group:
 *   1. Find the dominant vanId (most common non-null vanId in the group).
 *   2. If none exists yet, call smartAssignVan() once for the first row and use that result.
 *   3. Force-UPDATE every row in the group to the dominant vanId.
 *      — Rows with manualChange = 1 are skipped.
 *      — No free-van check: same invoice overrides double-booking detection.
 */
export async function POST() {
  try {
    // ── Fetch everything ────────────────────────────────────────────────────────
    const allBookings = await db.select().from(bookings);
    const allVans = await db.select().from(vans);
    const vanMap = new Map(allVans.map((v) => [v.id, v]));

    console.log(
      `[reassign] bookings=${allBookings.length} vans=${allVans.length}`,
      allVans.map((v) => `${v.id}:${v.vanNumber}`).join(", ")
    );

    // ── Group by invoiceNo ───────────────────────────────────────────────────────
    const groups = new Map<string, typeof allBookings>();
    for (const b of allBookings) {
      const key = b.invoiceNo ?? "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(b);
    }
    console.log(`[reassign] invoice groups: ${groups.size}`);

    let updatedCount = 0;
    let skippedManual = 0;
    let conflicts = 0;

    for (const [invoiceNo, rows] of groups) {
      // Skip bookings with no invoice (manual / legacy entries)
      if (!invoiceNo) continue;

      console.log(
        `\n[reassign] ${invoiceNo}: ${rows.length} rows —`,
        rows
          .map(
            (r) =>
              `id=${r.id} date=${r.travelDate} vi=${r.vehicleIndex} vanId=${r.vanId} manual=${r.manualChange}`
          )
          .join(" | ")
      );

      // ── Find dominant vanId ────────────────────────────────────────────────────
      const vanCounts = new Map<number, number>();
      for (const r of rows) {
        if (r.vanId != null) {
          vanCounts.set(r.vanId, (vanCounts.get(r.vanId) ?? 0) + 1);
        }
      }

      let dominantVanId: number | null = null;
      if (vanCounts.size > 0) {
        // Most-frequent non-null vanId
        dominantVanId = [...vanCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
        console.log(`  dominant vanId from existing assignments: ${dominantVanId}`);
      } else {
        // No van assigned yet — use smartAssignVan on the first row
        const first = rows[0];
        dominantVanId = await smartAssignVan(
          first.travelDate,
          first.fromLocation,
          first.invoiceNo ?? "",
          first.vehicleIndex ?? 1,
          first.numberOfVehicles ?? 1
        );
        console.log(`  smartAssignVan returned: ${dominantVanId}`);
      }

      if (dominantVanId == null) {
        console.log(`  CONFLICT: no available van for ${invoiceNo}`);
        conflicts++;
        continue;
      }

      const van = vanMap.get(dominantVanId);
      console.log(
        `  assigning vanId=${dominantVanId} (${van?.vanNumber ?? "?"}) to all ${rows.length} rows`
      );

      // ── Force-update every row (skip manualChange=1) ───────────────────────────
      for (const r of rows) {
        if (r.manualChange === 1) {
          console.log(`  skip id=${r.id} (manualChange=1)`);
          skippedManual++;
          continue;
        }
        await db
          .update(bookings)
          .set({
            vanId: dominantVanId,
            vehiclePlate: van?.vanNumber ?? "",
            driverName: van?.driverName ?? "",
            driverContact: van?.driverContact ?? "",
          })
          .where(eq(bookings.id, r.id));
        console.log(`  updated id=${r.id} → vanId=${dominantVanId}`);
        updatedCount++;
      }
    }

    // ── Debug: re-query the specific invoice mentioned in the bug report ─────────
    const debugRows = await db
      .select({ id: bookings.id, vanId: bookings.vanId, travelDate: bookings.travelDate })
      .from(bookings)
      .where(eq(bookings.invoiceNo, "INV2025120078"));
    if (debugRows.length > 0) {
      console.log(`\n[reassign] INV2025120078 after update:`, debugRows);
    }

    console.log(
      `\n[reassign] done — updated=${updatedCount} skippedManual=${skippedManual} conflicts=${conflicts}`
    );

    return NextResponse.json({ updated: updatedCount, skippedManual, conflicts });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[reassign] error:", error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
