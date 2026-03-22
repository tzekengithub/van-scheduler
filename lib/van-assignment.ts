import { db } from "@/lib/db";
import { bookings, vans } from "@/drizzle/schema";
import { eq, and, ne, desc } from "drizzle-orm";

/**
 * Smart van assignment.
 *
 * GOLDEN RULE: 1 van = maximum 1 job per day. No exceptions. No sharing. Ever.
 *
 * RULE 1 — Same invoice → same van.
 *   Find the van already assigned to any in-house booking with this invoiceNo.
 *   Step A: Does the preferred van have ANY booking on this travelDate?
 *     - No conflict → assign preferred van.
 *     - Same-invoice conflict (multi-vehicle) → fall through to Rule 2.
 *     - Different-invoice conflict → bump logic:
 *         Blocker is multi-day (invoiceNo appears > 1 time) → outsource current.
 *         Blocker is single → bump to free van (or outsource blocker),
 *         then assign preferred van to current booking.
 *
 * RULE 2 — Find any van with zero bookings on travelDate (strict — no exclusions).
 *   Among free vans, prefer route continuity for non-day-trip bookings.
 *
 * RULE 3 — No free van → return { outsource: true }. NEVER null. NEVER force-assign.
 */
export type AssignResult = number | { outsource: true };

export async function smartAssignVan(
  travelDate: string,
  fromLocation: string,
  invoiceNo: string,
  _vehicleIndex: number,
  _numberOfVehicles: number,
  tripType?: string | null,
): Promise<AssignResult> {
  const allVans = await db.select().from(vans).orderBy(vans.id);
  if (allVans.length === 0) return { outsource: true };

  // ── RULE 1 ───────────────────────────────────────────────────────────────────
  // Match by invoiceNo only. Exclude outsourced bookings.
  if (invoiceNo && invoiceNo.trim() !== "") {
    const existing = await db
      .select({ vanId: bookings.vanId })
      .from(bookings)
      .where(
        and(
          eq(bookings.invoiceNo, invoiceNo),
          ne(bookings.inHouseOrOutsourced, "O"),
        )
      )
      .limit(1);

    if (existing.length > 0 && existing[0].vanId != null) {
      const preferredVanId = existing[0].vanId;

      // Step A: Does the preferred van have ANY booking on this travelDate?
      const anyConflict = await db
        .select({ id: bookings.id, invoiceNo: bookings.invoiceNo })
        .from(bookings)
        .where(
          and(
            eq(bookings.vanId, preferredVanId),
            eq(bookings.travelDate, travelDate),
          )
        )
        .limit(1);

      if (anyConflict.length === 0) {
        // Van is completely free on this date → assign it.
        return preferredVanId;
      }

      // Step B: Identify conflict type.
      if (anyConflict[0].invoiceNo === invoiceNo) {
        // Same invoice + same date = multi-vehicle booking.
        // Each vehicle needs its own van → fall through to Rule 2.
      } else {
        // Different invoice is blocking → apply bump logic.
        const blockerBookingId = anyConflict[0].id;
        const blockerInvoiceNo = anyConflict[0].invoiceNo ?? "";

        // Fetch up to 2 rows for the blocker invoice to determine multi-day.
        const blockerInvoiceRows = await db
          .select({ id: bookings.id })
          .from(bookings)
          .where(eq(bookings.invoiceNo, blockerInvoiceNo))
          .limit(2);
        const isMultiDay = blockerInvoiceRows.length > 1;

        if (isMultiDay) {
          // Do NOT bump a multi-day trip — outsource the current booking instead.
          return { outsource: true };
        }

        // Single blocking booking — bump it.
        // Find any other van free on travelDate (excluding the preferred van).
        const freeVansForBump: typeof allVans = [];
        for (const van of allVans) {
          if (van.id === preferredVanId) continue;
          const conflict = await db
            .select({ id: bookings.id })
            .from(bookings)
            .where(and(eq(bookings.vanId, van.id), eq(bookings.travelDate, travelDate)))
            .limit(1);
          if (conflict.length === 0) freeVansForBump.push(van);
        }

        if (freeVansForBump.length > 0) {
          // Reassign blocker to a free van.
          const newVan = freeVansForBump[0];
          await db.update(bookings).set({
            vanId: newVan.id,
            vehiclePlate: newVan.vanNumber,
            driverName: newVan.driverName ?? "",
            driverContact: newVan.driverContact ?? "",
          }).where(eq(bookings.id, blockerBookingId));
        } else {
          // No free van — outsource the blocker.
          await db.update(bookings).set({
            inHouseOrOutsourced: "O",
            vanId: null,
            vehiclePlate: null,
            driverName: null,
            driverContact: null,
          }).where(eq(bookings.id, blockerBookingId));
        }

        // Preferred van is now free on travelDate → assign to current booking.
        return preferredVanId;
      }
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
  if (freeVans.length === 0) return { outsource: true };

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
