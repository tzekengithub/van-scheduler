import { db } from "@/lib/db";
import { bookings, vans } from "@/drizzle/schema";
import { eq, and, ne, desc } from "drizzle-orm";

/**
 * Smart van assignment.
 *
 * GOLDEN RULE: 1 van = maximum 1 job per day. No exceptions. No sharing. Ever.
 *
 * RULE 1 — Same invoice + same vehicleIndex → same van across different dates.
 *   Find existing assigned van for (invoiceNo, vehicleIndex).
 *   If found, reuse it ONLY IF that van has zero bookings from OTHER invoices on travelDate.
 *   (Own-invoice rows on other dates are not a conflict.)
 *   If the preferred van is busy with another invoice → fall through to RULE 2.
 *
 * RULE 2 — Find any van with zero bookings on travelDate (strict — no exclusions).
 *   A van with even 1 booking that day is skipped, no exceptions.
 *   Among free vans, prefer route continuity for non-day-trip bookings.
 *   Multi-vehicle same-date: naturally handled — vehicleIndex 1's van already has a
 *   booking after it's committed, so vehicleIndex 2 will see it as busy and pick another.
 *
 * RULE 3 — No free van → return null (conflict / outsourced).
 */
export async function smartAssignVan(
  travelDate: string,
  fromLocation: string,
  invoiceNo: string,
  vehicleIndex: number,
  _numberOfVehicles: number,
  tripType?: string | null,
): Promise<number | null> {
  const allVans = await db.select().from(vans).orderBy(vans.id);
  if (allVans.length === 0) return null;

  // ── RULE 1 ───────────────────────────────────────────────────────────────────
  // Same (invoiceNo, vehicleIndex) → try to reuse the same van for consistency.
  if (invoiceNo && invoiceNo.trim() !== "") {
    const existing = await db
      .select({ vanId: bookings.vanId })
      .from(bookings)
      .where(
        and(
          eq(bookings.invoiceNo, invoiceNo),
          eq(bookings.vehicleIndex, vehicleIndex),
        )
      )
      .limit(1);

    if (existing.length > 0 && existing[0].vanId != null) {
      const preferredVanId = existing[0].vanId;

      // Check strictly: any booking from a DIFFERENT invoice on this date?
      const otherConflict = await db
        .select({ id: bookings.id })
        .from(bookings)
        .where(
          and(
            eq(bookings.vanId, preferredVanId),
            eq(bookings.travelDate, travelDate),
            ne(bookings.invoiceNo, invoiceNo),
          )
        )
        .limit(1);

      if (otherConflict.length === 0) {
        // Preferred van is free for this date → assign it.
        return preferredVanId;
      }
      // Preferred van is busy with another invoice → fall through to RULE 2.
    }
  }

  // ── RULE 2 ───────────────────────────────────────────────────────────────────
  // Find vans with zero bookings on travelDate (strict — any booking disqualifies).
  const freeVans: typeof allVans = [];
  for (const van of allVans) {
    const conflict = await db
      .select({ id: bookings.id })
      .from(bookings)
      .where(and(eq(bookings.vanId, van.id), eq(bookings.travelDate, travelDate)))
      .limit(1);
    if (conflict.length === 0) freeVans.push(van);
  }

  // ── RULE 3 ───────────────────────────────────────────────────────────────────
  if (freeVans.length === 0) return null;

  // Day trips: just pick first free van (no continuity preference needed).
  if (tripType === "day_trip") return freeVans[0].id;

  // Non-day-trip: prefer van whose last booking ended at fromLocation (continuity).
  for (const van of freeVans) {
    const lastRows = await db
      .select({ toLocation: bookings.toLocation })
      .from(bookings)
      .where(eq(bookings.vanId, van.id))
      .orderBy(desc(bookings.travelDate))
      .limit(1);

    if (
      lastRows.length > 0 &&
      lastRows[0].toLocation?.toLowerCase().trim() === fromLocation.toLowerCase().trim()
    ) {
      return van.id;
    }
  }

  // Fallback: first free van.
  return freeVans[0].id;
}
