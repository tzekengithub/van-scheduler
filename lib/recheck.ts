import { db } from "@/lib/db";
import { bookings, vans } from "@/drizzle/schema";
import { eq, and, isNull, isNotNull, inArray, ne } from "drizzle-orm";
import { runReassign } from "@/lib/reassign";

/**
 * Full van schedule recheck.
 *
 * Resets ALL auto-managed bookings (manualChange = 0) and reassigns vans from
 * scratch using the current DB state. Run this after any mutation that could
 * affect van availability (upload, delete).
 *
 * User-confirmed outsourced bookings (inHouseOrOutsourced = 'O' with a company
 * name filled in) are treated as a manual decision and are never reset.
 *
 * After reassignment, any booking that still could not get a van is marked as
 * inHouseOrOutsourced = 'O' with no company name — this creates a visible
 * conflict in the UI ("OUTSOURCE COMPANY NEEDED") until the user fills in
 * the outsourced company name.
 */
export async function recheckAllVans(): Promise<void> {
  // ── Step 1: Find all auto-managed bookings ───────────────────────────────────
  const allAuto = await db
    .select({
      id: bookings.id,
      inHouseOrOutsourced: bookings.inHouseOrOutsourced,
      outsourcedCompany: bookings.outsourcedCompany,
    })
    .from(bookings)
    .where(eq(bookings.manualChange, 0));

  if (allAuto.length === 0) return;

  // User-confirmed outsourced = I/O is 'O' AND company name is filled in.
  // These are a deliberate user choice — leave them alone.
  const toResetIds = allAuto
    .filter((b) => {
      const userConfirmed =
        b.inHouseOrOutsourced === "O" &&
        (b.outsourcedCompany ?? "").trim() !== "";
      return !userConfirmed;
    })
    .map((b) => b.id);

  if (toResetIds.length === 0) return;

  // ── Step 2: Batch-reset — clear van + restore to in-house ───────────────────
  await db
    .update(bookings)
    .set({
      vanId: null,
      vehiclePlate: null,
      driverName: null,
      driverContact: null,
      inHouseOrOutsourced: "I",
    })
    .where(inArray(bookings.id, toResetIds));

  // ── Step 3: Reassign all cleared bookings ────────────────────────────────────
  // runReassign() with no args picks up all vanId=null, manualChange=0 rows.
  await runReassign();

  // ── Step 4: Enforce same-invoice-same-van ────────────────────────────────────
  // After the main pass, consolidate any invoice whose bookings ended up split
  // across multiple vans (e.g. because the preferred van was blocked mid-pass).
  await enforceInvoiceVanConsistency();

  // ── Step 5: Any still-unassigned → mark as outsourced ───────────────────────
  // This creates the "OUTSOURCE COMPANY NEEDED" conflict in the UI.
  const stillUnassigned = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(
        isNull(bookings.vanId),
        eq(bookings.manualChange, 0),
        eq(bookings.inHouseOrOutsourced, "I"),
      )
    );

  if (stillUnassigned.length > 0) {
    await db
      .update(bookings)
      .set({ inHouseOrOutsourced: "O" })
      .where(inArray(bookings.id, stillUnassigned.map((b) => b.id)));
  }
}

/**
 * Sweep all auto-managed bookings and ensure that every (invoiceNo, vehicleIndex)
 * group uses the SAME van across all its travel dates.
 *
 * Strategy per mismatched booking:
 *   1. If canonical van is free on that date → directly reassign.
 *   2. If canonical van is blocked by a single-booking auto-managed invoice →
 *      swap: blocker takes the mismatched booking's current van, mismatched
 *      booking moves to canonical van.  No van is lost — just shuffled.
 *   3. If blocker is manual or belongs to another multi-booking invoice →
 *      skip (can't safely displace it).
 *
 * Grouping by (invoiceNo, vehicleIndex) ensures multi-vehicle same-day invoices
 * (e.g. 2 vans needed) correctly get different vans per vehicleIndex slot while
 * each slot stays on the same van across multiple dates.
 */
async function enforceInvoiceVanConsistency(): Promise<void> {
  // Snapshot: all auto-managed bookings that already have a van
  const assigned = await db
    .select({
      id: bookings.id,
      invoiceNo: bookings.invoiceNo,
      vehicleIndex: bookings.vehicleIndex,
      vanId: bookings.vanId,
      travelDate: bookings.travelDate,
    })
    .from(bookings)
    .where(and(isNotNull(bookings.vanId), eq(bookings.manualChange, 0)));

  const allVans = await db.select().from(vans);
  const vanMap = new Map(allVans.map((v) => [v.id, v]));

  // Group by (invoiceNo, vehicleIndex)
  const bySlot = new Map<string, typeof assigned>();
  for (const b of assigned) {
    const inv = b.invoiceNo ?? "";
    if (!inv) continue;
    const key = `${inv}::${b.vehicleIndex ?? 1}`;
    if (!bySlot.has(key)) bySlot.set(key, []);
    bySlot.get(key)!.push(b);
  }

  for (const [slotKey, rows] of bySlot) {
    if (rows.length <= 1) continue;

    const vanSet = new Set(rows.map((r) => r.vanId!));
    if (vanSet.size <= 1) continue; // already consistent ✓

    // Canonical van = van of the earliest-date booking for this slot
    const sorted = [...rows].sort((a, b) => a.travelDate.localeCompare(b.travelDate));
    const canonicalVanId = sorted[0].vanId!;
    const canonicalVan = vanMap.get(canonicalVanId);
    const invoiceNo = rows[0].invoiceNo ?? "";

    console.log(
      `[enforceInvoice] ${slotKey}: vans [${[...vanSet].join(",")}] → consolidating to van ${canonicalVanId}`
    );

    for (const b of rows) {
      if (b.vanId === canonicalVanId) continue;

      // Is canonical van blocked on this date by a DIFFERENT invoice?
      const [blocker] = await db
        .select({
          id: bookings.id,
          invoiceNo: bookings.invoiceNo,
          manualChange: bookings.manualChange,
        })
        .from(bookings)
        .where(
          and(
            eq(bookings.vanId, canonicalVanId),
            eq(bookings.travelDate, b.travelDate),
            ne(bookings.invoiceNo, invoiceNo),
          )
        )
        .limit(1);

      if (!blocker) {
        // Canonical van free on this date — just move b to it
        await db
          .update(bookings)
          .set({
            vanId: canonicalVanId,
            vehiclePlate: canonicalVan?.vanNumber ?? "",
            driverName: canonicalVan?.driverName ?? "",
            driverContact: canonicalVan?.driverContact ?? "",
          })
          .where(eq(bookings.id, b.id));
        console.log(
          `[enforceInvoice] id=${b.id} date=${b.travelDate} → van ${canonicalVanId} (free)`
        );
        continue;
      }

      // Skip manual or multi-booking-invoice blockers (can't safely displace)
      if (blocker.manualChange === 1) continue;

      const [, blockerExtra] = await db
        .select({ id: bookings.id })
        .from(bookings)
        .where(eq(bookings.invoiceNo, blocker.invoiceNo ?? ""))
        .limit(2);
      if (blockerExtra) continue; // blocker invoice has >1 booking — leave it

      // Safe to swap: blocker takes b's current van, b takes canonical van
      const bVan = vanMap.get(b.vanId!);
      await db
        .update(bookings)
        .set({
          vanId: b.vanId,
          vehiclePlate: bVan?.vanNumber ?? "",
          driverName: bVan?.driverName ?? "",
          driverContact: bVan?.driverContact ?? "",
        })
        .where(eq(bookings.id, blocker.id));

      await db
        .update(bookings)
        .set({
          vanId: canonicalVanId,
          vehiclePlate: canonicalVan?.vanNumber ?? "",
          driverName: canonicalVan?.driverName ?? "",
          driverContact: canonicalVan?.driverContact ?? "",
        })
        .where(eq(bookings.id, b.id));

      console.log(
        `[enforceInvoice] ${slotKey} date=${b.travelDate}: swapped blocker id=${blocker.id} → van ${b.vanId}, booking id=${b.id} → van ${canonicalVanId}`
      );
    }
  }
}
