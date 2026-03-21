import { db } from "@/lib/db";
import { bookings, vans } from "@/drizzle/schema";
import { eq, and, desc } from "drizzle-orm";

/** Returns the number of whole calendar days between two YYYY-MM-DD strings. */
function daysBetween(dateA: string, dateB: string): number {
  const a = new Date(dateA + "T00:00:00Z").getTime();
  const b = new Date(dateB + "T00:00:00Z").getTime();
  return Math.round(Math.abs(a - b) / (1000 * 60 * 60 * 24));
}

/**
 * Smart van assignment with rules:
 *
 * RULE 1 — Same invoice, same vehicleIndex, same van:
 *   If any existing booking for this invoiceNo + vehicleIndex already has a van,
 *   reuse it (so all rows for invoice X vehicle 1 go to the same van).
 *
 * RULE 2 — Multi-vehicle: different vans per vehicleIndex:
 *   vehicleIndex 2 must get a different van than vehicleIndex 1, etc.
 *
 * RULE 3 — No double-booking on same date.
 *
 * RULE 4 — Return null if no suitable van can be found (conflict).
 *
 * RULE 5 — manualChange respected (checked by caller; we only auto-assign new rows).
 *
 * Returns the van's database id, or null if none available.
 */
export async function smartAssignVan(
  travelDate: string,
  fromLocation: string,
  invoiceNo: string,
  vehicleIndex: number,
  numberOfVehicles: number,
): Promise<number | null> {
  const allVans = await db.select().from(vans).orderBy(vans.id);
  if (allVans.length === 0) return null;

  // ── Invoice-based assignment (Rules 1 & 2) ─────────────────────────────────
  if (invoiceNo && invoiceNo.trim() !== "") {
    // Check if this (invoiceNo, vehicleIndex) already has an assigned van
    const existingForThisIndex = await db
      .select({ vanId: bookings.vanId })
      .from(bookings)
      .where(
        and(
          eq(bookings.invoiceNo, invoiceNo),
          eq(bookings.vehicleIndex, vehicleIndex)
        )
      )
      .limit(1);

    if (existingForThisIndex.length > 0 && existingForThisIndex[0].vanId != null) {
      const existingVanId = existingForThisIndex[0].vanId;
      // Verify no double-booking on this date before reusing
      const conflict = await db
        .select({ id: bookings.id })
        .from(bookings)
        .where(and(eq(bookings.vanId, existingVanId), eq(bookings.travelDate, travelDate)))
        .limit(1);
      if (conflict.length === 0) return existingVanId;
      // Van already booked on this date — fall through to find another
    }

    // Get all vans already used by OTHER vehicleIndices of this invoice
    const existingForInvoice = await db
      .select({ vanId: bookings.vanId })
      .from(bookings)
      .where(eq(bookings.invoiceNo, invoiceNo));

    const usedByInvoice = new Set(
      existingForInvoice.map((e) => e.vanId).filter((v): v is number => v != null)
    );

    // Pass A: find a free van not already used by this invoice
    for (const van of allVans) {
      if (usedByInvoice.has(van.id)) continue;
      const conflict = await db
        .select({ id: bookings.id })
        .from(bookings)
        .where(and(eq(bookings.vanId, van.id), eq(bookings.travelDate, travelDate)))
        .limit(1);
      if (conflict.length === 0) return van.id;
    }

    // Pass B: all unused vans are booked on this date — return null (Rule 4)
    return null;
  }

  // ── No invoice: classic continuity + fallback ───────────────────────────────

  // Pass 1: continuity check
  for (const van of allVans) {
    const lastRows = await db
      .select({ travelDate: bookings.travelDate, toLocation: bookings.toLocation })
      .from(bookings)
      .where(eq(bookings.vanId, van.id))
      .orderBy(desc(bookings.travelDate))
      .limit(1);

    if (lastRows.length === 0) continue;

    const last = lastRows[0];
    const gap = daysBetween(last.travelDate, travelDate);

    if (
      gap === 1 &&
      last.toLocation.toLowerCase().trim() === fromLocation.toLowerCase().trim()
    ) {
      const conflict = await db
        .select({ id: bookings.id })
        .from(bookings)
        .where(and(eq(bookings.vanId, van.id), eq(bookings.travelDate, travelDate)))
        .limit(1);

      if (conflict.length === 0) return van.id;
    }
  }

  // Pass 2: fallback — first free van on travelDate
  for (const van of allVans) {
    const conflict = await db
      .select({ id: bookings.id })
      .from(bookings)
      .where(and(eq(bookings.vanId, van.id), eq(bookings.travelDate, travelDate)))
      .limit(1);

    if (conflict.length === 0) return van.id;
  }

  // All vans booked — conflict
  return null;
}
