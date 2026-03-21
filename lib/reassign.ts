import { db } from "@/lib/db";
import { bookings, vans } from "@/drizzle/schema";
import { eq, and, isNull, inArray, asc } from "drizzle-orm";
import { smartAssignVan } from "@/lib/van-assignment";

/**
 * Reassign vans to unassigned bookings.
 *
 * @param bookingIds - If provided, only process these specific booking IDs.
 *                     If omitted, process ALL bookings where vanId IS NULL
 *                     and manualChange = 0, in travelDate ASC order.
 *
 * Bookings are processed in date order so that multi-date invoices correctly
 * reuse the same van via Rule 1 (earlier date commits first, later date finds it).
 *
 * Rows with manualChange = 1 are always skipped.
 */
export async function runReassign(
  bookingIds?: number[]
): Promise<{ assigned: number; conflicts: number }> {
  const allVans = await db.select().from(vans);
  const vanMap = new Map(allVans.map((v) => [v.id, v]));

  // ── Fetch target bookings ────────────────────────────────────────────────────
  const targetBookings =
    bookingIds && bookingIds.length > 0
      ? await db
          .select()
          .from(bookings)
          .where(inArray(bookings.id, bookingIds))
          .orderBy(
            asc(bookings.travelDate),
            asc(bookings.invoiceNo),
            asc(bookings.vehicleIndex)
          )
      : await db
          .select()
          .from(bookings)
          .where(and(isNull(bookings.vanId), eq(bookings.manualChange, 0)))
          .orderBy(
            asc(bookings.travelDate),
            asc(bookings.invoiceNo),
            asc(bookings.vehicleIndex)
          );

  let assigned = 0;
  let conflicts = 0;

  for (const b of targetBookings) {
    if (b.manualChange === 1) continue;

    const vanId = await smartAssignVan(
      b.travelDate,
      b.fromLocation,
      b.invoiceNo ?? "",
      b.vehicleIndex ?? 1,
      b.numberOfVehicles ?? 1,
      b.tripType,
    );

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
        `[runReassign] OK    id=${b.id} ${b.invoiceNo ?? "no-inv"} date=${b.travelDate} vi=${b.vehicleIndex} → van ${vanId} (${van?.vanNumber ?? "?"})`
      );
      assigned++;
    } else {
      await db
        .update(bookings)
        .set({ vanId: null, vehiclePlate: "", driverName: "", driverContact: "" })
        .where(eq(bookings.id, b.id));

      console.log(
        `[runReassign] CONFLICT id=${b.id} ${b.invoiceNo ?? "no-inv"} date=${b.travelDate} vi=${b.vehicleIndex} → no free van`
      );
      conflicts++;
    }
  }

  return { assigned, conflicts };
}
