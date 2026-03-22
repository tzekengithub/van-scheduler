import { db } from "@/lib/db";
import { bookings, vans } from "@/drizzle/schema";
import { eq, and, desc, isNotNull, asc, ne } from "drizzle-orm";

/**
 * Smart van assignment.
 *
 * GOLDEN RULE: 1 van = maximum 1 job per day. No exceptions. No sharing. Ever.
 *
 * Priority 1 — Multi-day invoice (invoiceNo appears > 1 time across all dates).
 *   Find the van already assigned to this invoice (any date).
 *   If preferred van is free on travelDate → assign it.
 *   If blocked by a different single-booking invoice → bump the blocker to a free van
 *     (or outsource the blocker), then assign preferred van.
 *   If blocked by a multi-day invoice (cannot bump) → outsource current booking.
 *   If no existing van for this invoice → fall through to Priority 2/3.
 *
 * Priority 2 — Normal trip (tripType = "trip" or anything except "one_way").
 *   Find first free van on travelDate.
 *   Prefer continuity: van whose last booking ended at fromLocation.
 *
 * Priority 3 — One-way trip (tripType = "one_way").
 *   Find first free van on travelDate. No continuity preference.
 *
 * RULE 3 — No free van → return { outsource: true }. NEVER null. NEVER force-assign.
 */
export type AssignResult = number | { outsource: true };

export async function smartAssignVan(
  travelDate: string,
  fromLocation: string,
  invoiceNo: string,
  vehicleIndex: number,
  _numberOfVehicles: number,
  tripType?: string | null,
): Promise<AssignResult> {
  const allVans = await db.select().from(vans).orderBy(vans.id);
  if (allVans.length === 0) return { outsource: true };

  // ── PRIORITY 1: Same-slot continuity ─────────────────────────────────────────
  // For a multi-date invoice, every booking with the same (invoiceNo, vehicleIndex)
  // must land on the SAME van. Look for any already-assigned booking for this
  // EXACT slot on a DIFFERENT date to find the canonical van.
  if (invoiceNo && invoiceNo.trim() !== "") {
    const [priorSlot] = await db
      .select({ vanId: bookings.vanId })
      .from(bookings)
      .where(
        and(
          eq(bookings.invoiceNo, invoiceNo),
          eq(bookings.vehicleIndex, vehicleIndex),
          isNotNull(bookings.vanId),
          ne(bookings.travelDate, travelDate), // a different date = already processed
        )
      )
      .orderBy(asc(bookings.travelDate))
      .limit(1);

    if (priorSlot?.vanId != null) {
      const preferredVanId = priorSlot.vanId;

      // Check if preferred van has ANY booking on this travelDate
      const [conflict] = await db
        .select({ id: bookings.id, invoiceNo: bookings.invoiceNo })
        .from(bookings)
        .where(
          and(
            eq(bookings.vanId, preferredVanId),
            eq(bookings.travelDate, travelDate),
          )
        )
        .limit(1);

      if (!conflict) {
        // Van is completely free on this date → assign it.
        return preferredVanId;
      }

      if (conflict.invoiceNo === invoiceNo) {
        // Same invoice blocking the preferred van (a different vehicleIndex on same date).
        // Each vehicleIndex needs its own van → fall through to Priority 2/3.
      } else {
        // Different invoice is blocking → check if blocker is multi-booking
        const blockerInvoiceNo = conflict.invoiceNo ?? "";
        const [, blockerExtra] = await db
          .select({ id: bookings.id })
          .from(bookings)
          .where(eq(bookings.invoiceNo, blockerInvoiceNo))
          .limit(2);
        const blockerIsMultiDay = !!blockerExtra;

        if (!blockerIsMultiDay) {
          // Single blocker → bump it to a free van, then claim preferred van
          const blockerBookingId = conflict.id;
          const freeVansForBump: typeof allVans = [];
          for (const van of allVans) {
            if (van.id === preferredVanId) continue;
            const [c] = await db
              .select({ id: bookings.id })
              .from(bookings)
              .where(and(eq(bookings.vanId, van.id), eq(bookings.travelDate, travelDate)))
              .limit(1);
            if (!c) freeVansForBump.push(van);
          }

          if (freeVansForBump.length > 0) {
            const newVan = freeVansForBump[0];
            await db.update(bookings).set({
              vanId: newVan.id,
              vehiclePlate: newVan.vanNumber,
              driverName: newVan.driverName ?? "",
              driverContact: newVan.driverContact ?? "",
            }).where(eq(bookings.id, blockerBookingId));
          } else {
            // No free van for bump → outsource the blocker
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
        // Multi-day blocker: cannot bump → fall through to Priority 2/3.
      }
    }
  }

  // ── PRIORITY 2 & 3: Find a free van ──────────────────────────────────────────
  const freeVans: typeof allVans = [];
  for (const van of allVans) {
    const conflict = await db
      .select({ id: bookings.id })
      .from(bookings)
      .where(and(eq(bookings.vanId, van.id), eq(bookings.travelDate, travelDate)))
      .limit(1);
    if (conflict.length === 0) freeVans.push(van);
  }

  if (freeVans.length === 0) return { outsource: true };

  // Priority 3 — one-way: no continuity check, just first free van
  if (tripType === "one_way_ride") return freeVans[0].id;

  // Priority 2 — trip: prefer continuity (van last ended at fromLocation)
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
