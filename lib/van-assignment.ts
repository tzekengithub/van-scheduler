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
 * Ports Flask's smart_assign_van().
 *
 * Pass 1 — Continuity: find a van whose last booking ended where this one
 * starts, on the day before travelDate, and has no booking yet on travelDate.
 *
 * Pass 2 — Fallback: first van that has no booking on travelDate.
 *
 * Returns the van's database id.
 */
export async function smartAssignVan(
  travelDate: string,
  fromLocation: string
): Promise<number> {
  const allVans = await db.select().from(vans).orderBy(vans.id);

  if (allVans.length === 0) {
    throw new Error("No vans in database. Call POST /api/seed first.");
  }

  // Pass 1: continuity check
  for (const van of allVans) {
    const lastRows = await db
      .select({ travelDate: bookings.travelDate, toLocation: bookings.toLocation })
      .from(bookings)
      .where(eq(bookings.vanId, van.id))
      .orderBy(desc(bookings.travelDate))
      .limit(1);

    if (lastRows.length === 0) continue; // no history — skip in this pass

    const last = lastRows[0];
    const gap = daysBetween(last.travelDate, travelDate);

    if (
      gap === 1 &&
      last.toLocation.toLowerCase().trim() === fromLocation.toLowerCase().trim()
    ) {
      // Van is a route continuation — check it's free on the new date
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

  // All vans booked on this date — assign the first van anyway
  return allVans[0].id;
}
