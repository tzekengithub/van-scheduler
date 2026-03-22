import { db } from "@/lib/db";
import { bookings, vans } from "@/drizzle/schema";
import { eq, and, isNull, isNotNull, inArray, ne, asc } from "drizzle-orm";
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
 *
 * @param logger - Optional callback to receive real-time log lines (for SSE streaming).
 */
export async function recheckAllVans(logger?: (msg: string) => void): Promise<void> {
  const log = (msg: string) => { console.log(msg); logger?.(msg); };

  log("━━━ RECHECK STARTED ━━━");

  // ── Step 1: Find all auto-managed bookings ───────────────────────────────────
  log("Step 1/6 — scanning auto-managed bookings…");
  const allAuto = await db
    .select({
      id: bookings.id,
      inHouseOrOutsourced: bookings.inHouseOrOutsourced,
      outsourcedCompany: bookings.outsourcedCompany,
    })
    .from(bookings)
    .where(eq(bookings.manualChange, 0));

  log(`  found ${allAuto.length} auto-managed booking(s)`);

  if (allAuto.length === 0) {
    log("  nothing to do — all bookings are manual.");
    log("━━━ RECHECK COMPLETE ━━━");
    return;
  }

  // User-confirmed outsourced = I/O is 'O' AND company name is filled in.
  // These are a deliberate user choice — leave them alone.
  const userConfirmedCount = allAuto.filter(
    (b) => b.inHouseOrOutsourced === "O" && (b.outsourcedCompany ?? "").trim() !== ""
  ).length;
  const toResetIds = allAuto
    .filter((b) => {
      const userConfirmed =
        b.inHouseOrOutsourced === "O" &&
        (b.outsourcedCompany ?? "").trim() !== "";
      return !userConfirmed;
    })
    .map((b) => b.id);

  log(`  skipping ${userConfirmedCount} user-confirmed outsourced booking(s)`);
  log(`  will reset ${toResetIds.length} booking(s)`);

  if (toResetIds.length === 0) {
    log("  nothing to reset.");
    log("━━━ RECHECK COMPLETE ━━━");
    return;
  }

  // ── Step 2: Batch-reset — clear van + restore to in-house ───────────────────
  log("Step 2/6 — resetting van assignments (clearing vanId, plate, driver)…");
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
  log(`  cleared ${toResetIds.length} booking(s)`);

  // ── Step 3: Reassign all cleared bookings ────────────────────────────────────
  log("Step 3/6 — running van reassignment (priority: day_trip > one_way_ride > round_trip > trip)…");
  const { assigned, conflicts } = await runReassign(undefined, log);
  log(`  reassignment done — assigned=${assigned} conflicts=${conflicts}`);

  // ── Step 4: Enforce same-invoice-same-van ────────────────────────────────────
  log("Step 4/6 — enforcing same invoice = same van per (invoiceNo, vehicleIndex)…");
  await enforceInvoiceVanConsistency(log);

  // ── Step 5: HARD GUARANTEE — eliminate every double-booking ─────────────────
  log("Step 5/6 — scanning for double-bookings (same van, same date)…");
  await eliminateDoubleBookings(log);

  // ── Step 6: Any still-unassigned → mark as outsourced ───────────────────────
  log("Step 6/6 — marking any still-unassigned bookings as outsourced…");
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
    log(`  marked ${stillUnassigned.length} booking(s) as outsourced (no van available)`);
  } else {
    log("  all bookings have a van assigned ✓");
  }

  log("━━━ RECHECK COMPLETE ━━━");
}

/**
 * Sweep all auto-managed bookings and ensure that every (invoiceNo, vehicleIndex)
 * group uses the SAME van across all its travel dates.
 */
async function enforceInvoiceVanConsistency(log: (msg: string) => void): Promise<void> {
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

  let inconsistent = 0;
  let fixed = 0;

  for (const [slotKey, rows] of bySlot) {
    if (rows.length <= 1) continue;

    const vanSet = new Set(rows.map((r) => r.vanId!));
    if (vanSet.size <= 1) continue; // already consistent ✓

    inconsistent++;

    // Canonical van = van of the earliest-date booking for this slot
    const sorted = [...rows].sort((a, b) => a.travelDate.localeCompare(b.travelDate));
    const canonicalVanId = sorted[0].vanId!;
    const canonicalVan = vanMap.get(canonicalVanId);
    const invoiceNo = rows[0].invoiceNo ?? "";

    log(
      `[enforceInvoice] ${slotKey}: vans split across [${[...vanSet].join(",")}] → consolidating to van ${canonicalVanId}`
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
        log(
          `[enforceInvoice] id=${b.id} date=${b.travelDate} → van ${canonicalVanId} (free)`
        );
        fixed++;
        continue;
      }

      // Skip manual or multi-booking-invoice blockers (can't safely displace)
      if (blocker.manualChange === 1) {
        log(`[enforceInvoice] id=${b.id} date=${b.travelDate} — blocked by manual booking id=${blocker.id}, skipping`);
        continue;
      }

      const [, blockerExtra] = await db
        .select({ id: bookings.id })
        .from(bookings)
        .where(eq(bookings.invoiceNo, blocker.invoiceNo ?? ""))
        .limit(2);
      if (blockerExtra) {
        log(`[enforceInvoice] id=${b.id} date=${b.travelDate} — blocker id=${blocker.id} is multi-booking invoice, skipping`);
        continue; // blocker invoice has >1 booking — leave it
      }

      // Guard: b's current van must only have b on this date — otherwise
      // sending the blocker there would create a double-booking.
      const [otherOnBVan] = await db
        .select({ id: bookings.id })
        .from(bookings)
        .where(
          and(
            eq(bookings.vanId, b.vanId!),
            eq(bookings.travelDate, b.travelDate),
            ne(bookings.id, b.id),
          )
        )
        .limit(1);
      if (otherOnBVan) {
        log(`[enforceInvoice] id=${b.id} date=${b.travelDate} — can't swap, current van is shared`);
        continue; // can't safely swap — b's van is shared
      }

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

      log(
        `[enforceInvoice] ${slotKey} date=${b.travelDate}: swapped blocker id=${blocker.id} → van ${b.vanId}, booking id=${b.id} → van ${canonicalVanId}`
      );
      fixed++;
    }
  }

  if (inconsistent === 0) {
    log("  all invoice slots consistent ✓");
  } else {
    log(`  checked ${inconsistent} inconsistent slot(s), fixed ${fixed} booking(s)`);
  }
}

/**
 * HARD GUARANTEE: scan every (vanId, travelDate) pair in the DB and fix any
 * that have more than one booking assigned.
 */
async function eliminateDoubleBookings(log: (msg: string) => void): Promise<void> {
  function slotPriority(tripType: string | null | undefined, manualChange: number): number {
    if (manualChange === 1) return -1; // manual always wins
    switch (tripType) {
      case "day_trip":     return 0;
      case "one_way_ride": return 1;
      case "round_trip":   return 2;
      default:             return 3;
    }
  }

  // Load every booking that has a van assigned
  const allAssigned = await db
    .select({
      id: bookings.id,
      vanId: bookings.vanId,
      travelDate: bookings.travelDate,
      tripType: bookings.tripType,
      manualChange: bookings.manualChange,
    })
    .from(bookings)
    .where(isNotNull(bookings.vanId))
    .orderBy(asc(bookings.id));

  // Group by "vanId::travelDate"
  const byVanDate = new Map<string, typeof allAssigned>();
  for (const b of allAssigned) {
    const key = `${b.vanId}::${b.travelDate}`;
    if (!byVanDate.has(key)) byVanDate.set(key, []);
    byVanDate.get(key)!.push(b);
  }

  // Collect all vans once for free-van lookup
  const allVans = await db.select().from(vans).orderBy(vans.id);

  let fixed = 0;

  for (const [key, entries] of byVanDate) {
    if (entries.length <= 1) continue;

    const [vanIdStr, date] = key.split("::");
    log(
      `[eliminateDoubleBookings] CONFLICT van=${vanIdStr} date=${date} ids=[${entries.map((e) => e.id).join(",")}]`
    );

    // Sort: highest-priority booking first (lowest slotPriority number, then lowest id)
    const sorted = [...entries].sort((a, b) => {
      const pa = slotPriority(a.tripType, a.manualChange);
      const pb = slotPriority(b.tripType, b.manualChange);
      if (pa !== pb) return pa - pb;
      return a.id - b.id;
    });

    // Keep sorted[0] on the van; displace everyone else
    for (let i = 1; i < sorted.length; i++) {
      const victim = sorted[i];

      // Find a free van for the victim (any van other than the one it's on)
      let freeVan: (typeof allVans)[number] | null = null;
      for (const van of allVans) {
        if (van.id === victim.vanId) continue;
        const [conflict] = await db
          .select({ id: bookings.id })
          .from(bookings)
          .where(
            and(
              eq(bookings.vanId, van.id),
              eq(bookings.travelDate, date),
              ne(bookings.id, victim.id),
            )
          )
          .limit(1);
        if (!conflict) { freeVan = van; break; }
      }

      if (freeVan) {
        await db
          .update(bookings)
          .set({
            vanId: freeVan.id,
            vehiclePlate: freeVan.vanNumber ?? "",
            driverName: freeVan.driverName ?? "",
            driverContact: freeVan.driverContact ?? "",
          })
          .where(eq(bookings.id, victim.id));
        log(
          `[eliminateDoubleBookings] displaced id=${victim.id} date=${date} → van ${freeVan.id} (${freeVan.vanNumber})`
        );
      } else {
        // No free van — outsource it
        await db
          .update(bookings)
          .set({
            vanId: null,
            vehiclePlate: null,
            driverName: null,
            driverContact: null,
            inHouseOrOutsourced: "O",
          })
          .where(eq(bookings.id, victim.id));
        log(
          `[eliminateDoubleBookings] outsourced id=${victim.id} date=${date} (no free van)`
        );
      }

      fixed++;
    }
  }

  if (fixed > 0) {
    log(`[eliminateDoubleBookings] resolved ${fixed} double-booking violation(s)`);
  } else {
    log("  no double-bookings found ✓");
  }
}
