import { db } from "@/lib/db";
import { bookings, vans } from "@/drizzle/schema";
import { eq, and, isNull, isNotNull, inArray, ne, asc, sql } from "drizzle-orm";
import { runReassign } from "@/lib/reassign";
import { detectTripRequirements } from "@/lib/van-assignment";

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
  log("Step 1/7 — scanning auto-managed bookings…");
  const allAuto = await db
    .select({
      id: bookings.id,
      inHouseOrOutsourced: bookings.inHouseOrOutsourced,
      outsourcedCompany: bookings.outsourcedCompany,
      vehicleCategory: bookings.vehicleCategory,
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
  // Car trips (vehicleCategory = "Car") are always outsourced — never reset them.
  const userConfirmedCount = allAuto.filter(
    (b) => b.inHouseOrOutsourced === "O" && (b.outsourcedCompany ?? "").trim() !== ""
  ).length;
  const carTripCount = allAuto.filter((b) => b.vehicleCategory === "Car").length;
  const toResetIds = allAuto
    .filter((b) => {
      const userConfirmed =
        b.inHouseOrOutsourced === "O" &&
        (b.outsourcedCompany ?? "").trim() !== "";
      const isCarTrip = b.vehicleCategory === "Car";
      return !userConfirmed && !isCarTrip;
    })
    .map((b) => b.id);

  log(`  skipping ${userConfirmedCount} user-confirmed outsourced booking(s)`);
  log(`  skipping ${carTripCount} Car trip(s) (always outsourced — 5/7-Seater Car)`);
  log(`  will reset ${toResetIds.length} booking(s)`);

  if (toResetIds.length === 0) {
    log("  nothing to reset.");
    log("━━━ RECHECK COMPLETE ━━━");
    return;
  }

  // ── Step 2: Batch-reset — clear van + restore to in-house ───────────────────
  log("Step 2/7 — resetting van assignments (clearing vanId, plate, driver)…");
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
  log("Step 3/7 — running van reassignment (priority: trip > one_way_ride)…");
  const { assigned, conflicts } = await runReassign(undefined, log);
  log(`  reassignment done — assigned=${assigned} conflicts=${conflicts}`);

  // ── Step 3b: Remove duplicate (invoiceNo, vehicleIndex, travelDate) rows ─────
  log("Step 3b/7 — removing duplicate invoice-slot rows from re-uploads…");
  await deduplicateSameDaySlots(log);

  // ── Step 4: Enforce same-invoice-same-van ────────────────────────────────────
  log("Step 4/7 — enforcing same invoice = same van per (invoiceNo, vehicleIndex)…");
  await enforceInvoiceVanConsistency(log);

  // ── Step 5: Same-day same-invoice-slot conflicts → assign any free van ───────
  log("Step 5/7 — assigning free vans to same-invoice/vehicleIndex/date conflicts…");
  await assignFreeVanToSameDayConflicts(log);

  // ── Step 6: HARD GUARANTEE — eliminate every double-booking ─────────────────
  log("Step 6/7 — scanning for double-bookings (same van, same date)…");
  await eliminateDoubleBookings(log);

  // ── Step 7: Any still-unassigned → mark as outsourced ───────────────────────
  log("Step 7/7 — marking any still-unassigned bookings as outsourced…");
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
 * Mid-layer rescan — runs after each AI scheduling layer commits its results,
 * BEFORE the next layer starts.
 *
 * Corrects any mistakes the AI made within the just-completed layer WITHOUT
 * touching bookings that haven't been scheduled yet (i.e. layers still to run).
 * Specifically it does NOT mark unassigned bookings as outsourced — those are
 * still waiting for a later layer to claim them.
 *
 * Three guarantees per layer:
 *  1. Invoice continuity  — all legs of the same (invoiceNo, vehicleIndex) use the same van
 *  2. Van-type match      — Alphard bookings → Alphard vans; SG/TH trips → capable vans
 *  3. No phantom outsources — if a booking was outsourced but a free capable van exists, rescue it
 */
export async function runMidLayerChecks(layerLabel: string, logger?: (msg: string) => void): Promise<void> {
  const log = (msg: string) => { console.log(msg); logger?.(msg); };

  log(`━━━ MID-LAYER RESCAN (${layerLabel}) ━━━`);

  log("  [1/4] Invoice continuity — same (invoiceNo, vehicleIndex) → same van…");
  await enforceInvoiceVanConsistency(log);

  log("  [2/4] Double-booking elimination…");
  await eliminateDoubleBookings(log);

  log("  [3/4] Van-type match — Alphard exclusivity + SG/TH capability…");
  await fixAlphardViolations(log);
  await fixCapabilityViolations(log);

  log("  [4/4] Rescue incorrectly outsourced bookings (free capable van exists)…");
  await rescueIncorrectOutsources(log);

  log(`━━━ MID-LAYER RESCAN COMPLETE ━━━`);
}

/**
 * Run only the constraint-enforcement steps (4–7) without resetting assignments.
 *
 * Called after the AI scheduler writes its results to guarantee hard rules are met:
 * - Same invoice → same van
 * - No double-bookings
 * - All still-unassigned in-house bookings marked as outsourced
 *
 * Safe to run after any external scheduler (AI) that may have left inconsistencies.
 */
export async function runConstraintChecks(logger?: (msg: string) => void): Promise<void> {
  const log = (msg: string) => { console.log(msg); logger?.(msg); };

  log("━━━ CONSTRAINT CHECK STARTED ━━━");

  log("Check 0/5 — removing duplicate invoice-slot rows from re-uploads…");
  await deduplicateSameDaySlots(log);

  log("Check 1/5 — enforcing same invoice = same van…");
  await enforceInvoiceVanConsistency(log);

  log("Check 2/5 — assigning free vans to same-day same-invoice conflicts…");
  await assignFreeVanToSameDayConflicts(log);

  log("Check 3/5 — eliminating double-bookings…");
  await eliminateDoubleBookings(log);

  log("Check 4/5 — fixing Alphard exclusivity violations…");
  await fixAlphardViolations(log);

  log("Check 4b/5 — fixing Singapore/Thailand capability violations…");
  await fixCapabilityViolations(log);

  log("Check 5/5 — rescuing any booking incorrectly outsourced when a free van exists…");
  await rescueIncorrectOutsources(log);

  log("Check 6/6 — marking still-unassigned bookings as outsourced…");
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
    log(`  marked ${stillUnassigned.length} booking(s) as outsourced`);
  } else {
    log("  all bookings assigned ✓");
  }

  log("Check 7/7 — final validation (double-bookings, unnecessary outsources, capability rules)…");
  await validateFinalSchedule(log);

  log("━━━ CONSTRAINT CHECK COMPLETE ━━━");
}

/**
 * For unassigned auto-managed in-house bookings that share the same
 * (invoiceNo, vehicleIndex, travelDate) with an already-assigned booking,
 * try to assign any randomly-selected free capable van instead of falling
 * through to outsource.  This handles the "same-day same-invoice-slot"
 * multi-vehicle scenario where the preferred invoice van is already taken.
 *
 * Only outsources if every van is booked on that date.
 */
async function assignFreeVanToSameDayConflicts(log: (msg: string) => void): Promise<void> {
  const unassigned = await db
    .select()
    .from(bookings)
    .where(
      and(
        isNull(bookings.vanId),
        eq(bookings.manualChange, 0),
        eq(bookings.inHouseOrOutsourced, "I"),
      )
    );

  if (unassigned.length === 0) {
    log("  no unassigned in-house bookings — nothing to do");
    return;
  }

  const allVans = await db.select().from(vans).orderBy(vans.id);

  // Pre-load all assigned bookings once to build in-memory lookup structures.
  // This replaces O(N×M) per-booking DB queries with a single fetch + Set lookups.
  const allAssigned = await db
    .select({ id: bookings.id, vanId: bookings.vanId, travelDate: bookings.travelDate, invoiceNo: bookings.invoiceNo, vehicleIndex: bookings.vehicleIndex })
    .from(bookings)
    .where(isNotNull(bookings.vanId));

  // "vanId::date" → true — for checking if a van is free on a date
  const occupiedSlots = new Set<string>(allAssigned.map((b) => `${b.vanId}::${b.travelDate}`));
  // "invoiceNo::vehicleIndex::date" — keys where a sibling with a van already exists
  const assignedSiblingKeys = new Set<string>(
    allAssigned
      .filter((b) => b.invoiceNo)
      .map((b) => `${b.invoiceNo}::${b.vehicleIndex ?? 1}::${b.travelDate}`)
  );

  let fixed = 0;

  for (const b of unassigned) {
    if (!b.invoiceNo) continue;

    // Is there another booking with the same (invoiceNo, vehicleIndex, travelDate)
    // that already has a van?  Check in-memory instead of querying DB.
    const siblingKey = `${b.invoiceNo}::${b.vehicleIndex ?? 1}::${b.travelDate}`;
    if (!assignedSiblingKeys.has(siblingKey)) continue; // leave for step 7

    log(
      `[assignFreeVan] ${b.invoiceNo} vi=${b.vehicleIndex ?? 1} date=${b.travelDate} id=${b.id} — same-day conflict with assigned sibling, picking random free van…`
    );

    const { needsSingapore, needsThailand } = detectTripRequirements(
      b.fromLocation ?? "",
      b.toLocation ?? "",
    );

    const isAlphardBooking = (b.isAlphardTrip ?? 0) === 1;

    // Iterate in deterministic order (allVans already sorted by id).
    // Removed the previous Math.random() shuffle — randomness caused different
    // van assignments on every run for the same input data.
    let freeVan: typeof allVans[number] | null = null;
    for (const van of allVans) {
      if (needsSingapore && van.singaporeEnabled !== 1) continue;
      if (needsThailand && van.thailandEnabled !== 1) continue;
      const isVanAlphard = (van.vehicleType ?? "").toLowerCase() === "toyota alphard";
      if (isAlphardBooking && !isVanAlphard) continue;
      if (!isAlphardBooking && isVanAlphard) continue;
      if (!occupiedSlots.has(`${van.id}::${b.travelDate}`)) {
        freeVan = van;
        break;
      }
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
        .where(eq(bookings.id, b.id));
      occupiedSlots.add(`${freeVan.id}::${b.travelDate}`);
      log(
        `[assignFreeVan] id=${b.id} → van ${freeVan.id} (${freeVan.vanNumber ?? "?"})`
      );
      fixed++;
    } else {
      log(
        `[assignFreeVan] id=${b.id} — all vans fully booked on ${b.travelDate}, will outsource in step 7`
      );
    }
  }

  if (fixed > 0) {
    log(`  resolved ${fixed} same-day conflict(s) by assigning free van(s)`);
  } else {
    log("  no same-day conflict resolutions needed ✓");
  }
}

/**
 * Scan all assigned auto-managed bookings and fix any Alphard exclusivity
 * violations:
 *   - isAlphardTrip=1 assigned to a non-Alphard van → unassign it
 *   - isAlphardTrip=0 assigned to a Toyota Alphard van → unassign it
 *
 * Unassigned bookings are picked up by rescueIncorrectOutsources (which
 * respects Alphard rules) and, if still unassigned, by the final outsource
 * step.  Manual-change bookings are never touched.
 */
async function fixAlphardViolations(log: (msg: string) => void): Promise<void> {
  const allAssigned = await db
    .select({
      id: bookings.id,
      vanId: bookings.vanId,
      travelDate: bookings.travelDate,
      invoiceNo: bookings.invoiceNo,
      isAlphardTrip: bookings.isAlphardTrip,
      manualChange: bookings.manualChange,
    })
    .from(bookings)
    .where(and(isNotNull(bookings.vanId), eq(bookings.manualChange, 0)));

  if (allAssigned.length === 0) {
    log("  no assigned auto-managed bookings to check ✓");
    return;
  }

  const allVans = await db.select().from(vans);
  const vanMap = new Map(allVans.map((v) => [v.id, v]));

  const violations: number[] = [];
  for (const b of allAssigned) {
    const van = vanMap.get(b.vanId!);
    if (!van) continue;
    const isVanAlphard = (van.vehicleType ?? "").toLowerCase() === "toyota alphard";
    const isAlphardBooking = (b.isAlphardTrip ?? 0) === 1;
    if (isAlphardBooking !== isVanAlphard) {
      log(
        `[fixAlphard] id=${b.id} date=${b.travelDate} inv=${b.invoiceNo ?? "?"}: ` +
        `${isAlphardBooking ? "Alphard booking" : "regular booking"} incorrectly assigned to ` +
        `${isVanAlphard ? "Alphard" : "regular"} van ${van.vanNumber} — unassigning`
      );
      violations.push(b.id);
    }
  }

  if (violations.length === 0) {
    log("  no Alphard violations found ✓");
    return;
  }

  await db
    .update(bookings)
    .set({
      vanId: null,
      vehiclePlate: null,
      driverName: null,
      driverContact: null,
      inHouseOrOutsourced: "I",
    })
    .where(inArray(bookings.id, violations));

  log(`  cleared ${violations.length} Alphard violation(s) — will be re-assigned or outsourced`);
}

/**
 * Scan all auto-managed bookings and fix Singapore / Thailand capability violations:
 *   - booking needs Singapore but van.singaporeEnabled != 1 → unassign
 *   - booking needs Thailand but van.thailandEnabled != 1  → unassign
 *
 * Unassigned bookings are picked up by rescueIncorrectOutsources and, if still
 * unassigned, by the final outsource step.  Manual-change bookings are never touched.
 */
async function fixCapabilityViolations(log: (msg: string) => void): Promise<void> {
  const allAssigned = await db
    .select({
      id: bookings.id,
      vanId: bookings.vanId,
      travelDate: bookings.travelDate,
      invoiceNo: bookings.invoiceNo,
      fromLocation: bookings.fromLocation,
      toLocation: bookings.toLocation,
      manualChange: bookings.manualChange,
    })
    .from(bookings)
    .where(and(isNotNull(bookings.vanId), eq(bookings.manualChange, 0)));

  if (allAssigned.length === 0) {
    log("  no assigned auto-managed bookings to check ✓");
    return;
  }

  const allVans = await db.select().from(vans);
  const vanMap = new Map(allVans.map((v) => [v.id, v]));

  const violations: number[] = [];
  for (const b of allAssigned) {
    const van = vanMap.get(b.vanId!);
    if (!van) continue;
    const { needsSingapore, needsThailand } = detectTripRequirements(
      b.fromLocation ?? "",
      b.toLocation ?? "",
    );
    if (needsSingapore && van.singaporeEnabled !== 1) {
      log(
        `[fixCapability] id=${b.id} date=${b.travelDate} inv=${b.invoiceNo ?? "?"}: ` +
        `Singapore trip assigned to non-SG van ${van.vanNumber} — unassigning`
      );
      violations.push(b.id);
    } else if (needsThailand && van.thailandEnabled !== 1) {
      log(
        `[fixCapability] id=${b.id} date=${b.travelDate} inv=${b.invoiceNo ?? "?"}: ` +
        `Thailand trip assigned to non-TH van ${van.vanNumber} — unassigning`
      );
      violations.push(b.id);
    }
  }

  if (violations.length === 0) {
    log("  no Singapore/Thailand capability violations found ✓");
    return;
  }

  await db
    .update(bookings)
    .set({
      vanId: null,
      vehiclePlate: null,
      driverName: null,
      driverContact: null,
      inHouseOrOutsourced: "I",
    })
    .where(inArray(bookings.id, violations));

  log(`  cleared ${violations.length} capability violation(s) — will be re-assigned or outsourced`);
}

/**
 * Safety net: finds every unprotected booking that has no van assigned and is
 * NOT a confirmed outsource (outsourcedCompany filled) or a Car trip, then
 * tries to assign a free capable van.
 *
 * This catches cases where the AI scheduler incorrectly outsourced a booking
 * when a free van was actually available. The function is idempotent — if a
 * booking genuinely cannot be assigned (all capable vans are taken), it is
 * left untouched so the final "mark as outsourced" step handles it.
 */
async function rescueIncorrectOutsources(log: (msg: string) => void): Promise<void> {
  // Unprotected = manualChange=0, no confirmed outsource company, not a Car trip
  // ORDER BY id for deterministic processing — same input → same result every run.
  const candidates = await db.select().from(bookings).where(
    and(
      isNull(bookings.vanId),
      eq(bookings.manualChange, 0),
    )
  ).orderBy(asc(bookings.id));

  const toRescue = candidates.filter((b) => {
    if ((b.vehicleCategory ?? "Van") === "Car") return false; // always outsourced
    if (b.inHouseOrOutsourced === "O" && (b.outsourcedCompany ?? "").trim() !== "") return false; // confirmed
    return true;
  });

  if (toRescue.length === 0) {
    log("  no incorrectly-outsourced bookings found ✓");
    return;
  }

  log(`  found ${toRescue.length} unprotected unassigned booking(s) — checking for free vans…`);

  const allVans = await db.select().from(vans).orderBy(vans.id);

  // Build occupied-slot index from currently assigned bookings (single query)
  const allAssigned = await db
    .select({ vanId: bookings.vanId, travelDate: bookings.travelDate })
    .from(bookings)
    .where(isNotNull(bookings.vanId));

  const occupiedSlots = new Set<string>(allAssigned.map((b) => `${b.vanId}::${b.travelDate}`));

  let rescued = 0;

  for (const b of toRescue) {
    const { needsSingapore, needsThailand } = detectTripRequirements(
      b.fromLocation ?? "",
      b.toLocation ?? "",
    );
    const isAlphardBooking = (b.isAlphardTrip ?? 0) === 1;

    let freeVan: (typeof allVans)[number] | null = null;
    for (const van of allVans) {
      if (needsSingapore && van.singaporeEnabled !== 1) continue;
      if (needsThailand && van.thailandEnabled !== 1) continue;
      const isVanAlphard = (van.vehicleType ?? "").toLowerCase() === "toyota alphard";
      if (isAlphardBooking && !isVanAlphard) continue;
      if (!isAlphardBooking && isVanAlphard) continue;
      if (!occupiedSlots.has(`${van.id}::${b.travelDate}`)) {
        freeVan = van;
        break;
      }
    }

    if (freeVan) {
      await db
        .update(bookings)
        .set({
          vanId: freeVan.id,
          vehiclePlate: freeVan.vanNumber ?? "",
          driverName: freeVan.driverName ?? "",
          driverContact: freeVan.driverContact ?? "",
          inHouseOrOutsourced: "I",
          outsourcedCompany: "",
        })
        .where(eq(bookings.id, b.id));
      occupiedSlots.add(`${freeVan.id}::${b.travelDate}`);
      log(
        `[rescue] id=${b.id} date=${b.travelDate} ${b.fromLocation}→${b.toLocation} → van ${freeVan.id} (${freeVan.vanNumber ?? "?"})`,
      );
      rescued++;
    } else {
      log(
        `[rescue] id=${b.id} date=${b.travelDate} — all capable vans taken, cannot rescue`,
      );
    }
  }

  if (rescued > 0) {
    log(`  rescued ${rescued} booking(s) from incorrect outsource`);
  } else {
    log("  no rescuable bookings — all outsources are genuine ✓");
  }
}

/**
 * Remove duplicate booking rows that share the same (invoiceNo, vehicleIndex, travelDate).
 *
 * Duplicates arise when the same PDF is uploaded more than once, or when a
 * price-revised PDF is re-uploaded.  Only one booking per slot makes sense —
 * keep the row with the lowest id (first inserted) and delete the rest.
 *
 * Only non-manual bookings (manualChange = 0) are candidates for deletion so
 * that user-locked entries are never touched.
 */
async function deduplicateSameDaySlots(log: (msg: string) => void): Promise<void> {
  // Use a window function to rank rows within each (invoiceNo, vehicleIndex, travelDate)
  // group by id ASC — keep rank=1, delete rank>1.
  const result = await db.execute(sql`
    DELETE FROM bookings
    WHERE id IN (
      SELECT id FROM (
        SELECT id,
          ROW_NUMBER() OVER (
            PARTITION BY invoice_no, vehicle_index, travel_date
            ORDER BY id ASC
          ) AS rn
        FROM bookings
        WHERE invoice_no IS NOT NULL
          AND manual_change = 0
      ) ranked
      WHERE rn > 1
    )
  `);

  const deleted = (result as unknown as { rowCount?: number })?.rowCount ?? 0;
  if (deleted > 0) {
    log(`[dedup] removed ${deleted} duplicate booking row(s) (same invoiceNo + vehicleIndex + travelDate)`);
  } else {
    log("  no duplicate invoice-slot rows found ✓");
  }
}

/**
 * Sweep all auto-managed bookings and ensure that every (invoiceNo, vehicleIndex)
 * group uses the SAME van across all its travel dates.
 *
 * Strategy: for each inconsistent group, find ANY van that has zero conflicts
 * on ALL dates of the group (ignoring the group's own bookings). Prefer vans
 * already used by the group to minimise displacement. Move all bookings in the
 * group to that van.
 *
 * If no single van is free on every date, leave the group as-is (logged).
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
      fromLocation: bookings.fromLocation,
      toLocation: bookings.toLocation,
      isAlphardTrip: bookings.isAlphardTrip,
    })
    .from(bookings)
    .where(and(isNotNull(bookings.vanId), eq(bookings.manualChange, 0)));

  const allVans = await db.select().from(vans);

  // In-memory occupied slot map: "vanId::date" → bookingId
  // Used to check van availability without extra DB queries per candidate van.
  const occupiedSlots = new Map<string, number>();
  for (const b of assigned) {
    occupiedSlots.set(`${b.vanId}::${b.travelDate}`, b.id);
  }

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

    const dates = rows.map((r) => r.travelDate);
    const bookingIds = rows.map((r) => r.id);

    // Detect same-day duplicates within this group: two bookings on the same date
    // means the invoice genuinely needs 2 vans that day (multi-vehicle same-day).
    // We cannot put them on the same van, so skip consolidation for this group.
    const dateSet = new Set(dates);
    if (dateSet.size < dates.length) {
      log(
        `[enforceInvoice] ${slotKey}: SKIP — group has ${dates.length - dateSet.size} same-day duplicate(s) (multi-vehicle same-day booking, cannot consolidate)`
      );
      continue;
    }

    log(
      `[enforceInvoice] ${slotKey}: ${rows.length} bookings split across vans [${[...vanSet].join(",")}] on dates [${dates.join(",")}]`
    );

    // Determine capability requirements across ALL legs of the group.
    // A multi-day tour where the last leg goes to Singapore still requires
    // a Singapore-capable van for the entire invoice — not just the first leg.
    let needsSingapore = false;
    let needsThailand = false;
    for (const r of rows) {
      const reqs = detectTripRequirements(r.fromLocation ?? "", r.toLocation ?? "");
      if (reqs.needsSingapore) needsSingapore = true;
      if (reqs.needsThailand) needsThailand = true;
    }
    const isAlphardBooking = rows.some((r) => (r.isAlphardTrip ?? 0) === 1);
    const capableVans = allVans.filter((v) => {
      if (needsSingapore && v.singaporeEnabled !== 1) return false;
      if (needsThailand && v.thailandEnabled !== 1) return false;
      const isVanAlphard = (v.vehicleType ?? "").toLowerCase() === "toyota alphard";
      if (isAlphardBooking && !isVanAlphard) return false;
      if (!isAlphardBooking && isVanAlphard) return false;
      return true;
    });

    // Prefer vans already used by this group (fewer moves), then try all others
    const vanPriority = [
      ...capableVans.filter((v) => vanSet.has(v.id)),
      ...capableVans.filter((v) => !vanSet.has(v.id)),
    ];

    const bookingIdSet = new Set(bookingIds);

    let targetVan: typeof allVans[number] | null = null;
    for (const van of vanPriority) {
      // Check in-memory: does this van have any other booking on any of the group's dates?
      const blocked = dates.some((date) => {
        const slotBookingId = occupiedSlots.get(`${van.id}::${date}`);
        return slotBookingId !== undefined && !bookingIdSet.has(slotBookingId);
      });

      if (!blocked) {
        targetVan = van;
        break;
      }
      log(`  van ${van.id} (${van.vanNumber}) blocked on ≥1 date — trying next`);
    }

    if (!targetVan) {
      log(`[enforceInvoice] ${slotKey}: no single van free on all dates — leaving split`);
      continue;
    }

    // Move all rows not already on targetVan — single batch UPDATE
    const toMove = rows.filter((b) => b.vanId !== targetVan!.id);
    if (toMove.length > 0) {
      await db
        .update(bookings)
        .set({
          vanId: targetVan.id,
          vehiclePlate: targetVan.vanNumber ?? "",
          driverName: targetVan.driverName ?? "",
          driverContact: targetVan.driverContact ?? "",
        })
        .where(inArray(bookings.id, toMove.map((b) => b.id)));

      for (const b of toMove) {
        occupiedSlots.delete(`${b.vanId}::${b.travelDate}`);
        occupiedSlots.set(`${targetVan.id}::${b.travelDate}`, b.id);
        log(`[enforceInvoice] ${slotKey} id=${b.id} date=${b.travelDate} → van ${targetVan.id} (${targetVan.vanNumber})`);
      }
    }
    const moved = toMove.length;
    log(`[enforceInvoice] ${slotKey}: consolidated to van ${targetVan.id} (${targetVan.vanNumber ?? "?"}), moved ${moved} booking(s)`);
    fixed += moved;
  }

  if (inconsistent === 0) {
    log("  all invoice slots consistent ✓");
  } else {
    log(`  checked ${inconsistent} inconsistent slot(s), moved ${fixed} booking(s) to consolidate`);
  }
}

/**
 * HARD GUARANTEE: scan every (vanId, travelDate) pair in the DB and fix any
 * that have more than one booking assigned.
 */
async function eliminateDoubleBookings(log: (msg: string) => void): Promise<void> {
  // Lower number = higher priority = keeps the van when two bookings conflict.
  // Two tiers: trip (0) beats one_way_ride (1). manualChange always wins.
  function slotPriority(tripType: string | null | undefined, manualChange: number): number {
    if (manualChange === 1) return -1; // manual/protected always wins
    return tripType === "one_way_ride" ? 1 : 0;
  }

  // Load every booking that has a van assigned
  const allAssigned = await db
    .select({
      id: bookings.id,
      vanId: bookings.vanId,
      travelDate: bookings.travelDate,
      tripType: bookings.tripType,
      manualChange: bookings.manualChange,
      fromLocation: bookings.fromLocation,
      toLocation: bookings.toLocation,
      isAlphardTrip: bookings.isAlphardTrip,
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

  // In-memory occupied slot index — avoids per-van DB queries inside the loop.
  // Keys: "vanId::date". Pre-seed from allAssigned; update as victims are moved.
  const occupiedSlots = new Set<string>(
    allAssigned.map((b) => `${b.vanId}::${b.travelDate}`)
  );

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

      // Find a free, capability-matching van for the victim using in-memory index
      const { needsSingapore, needsThailand } = detectTripRequirements(
        victim.fromLocation ?? "",
        victim.toLocation ?? "",
      );
      const isAlphardBooking = (victim.isAlphardTrip ?? 0) === 1;
      let freeVan: (typeof allVans)[number] | null = null;
      for (const van of allVans) {
        if (van.id === victim.vanId) continue;
        if (needsSingapore && van.singaporeEnabled !== 1) continue;
        if (needsThailand && van.thailandEnabled !== 1) continue;
        const isVanAlphard = (van.vehicleType ?? "").toLowerCase() === "toyota alphard";
        if (isAlphardBooking && !isVanAlphard) continue;
        if (!isAlphardBooking && isVanAlphard) continue;
        if (!occupiedSlots.has(`${van.id}::${date}`)) { freeVan = van; break; }
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
        // sorted[0] still holds victim.vanId::date — only add freeVan's new slot
        occupiedSlots.add(`${freeVan.id}::${date}`);
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

/**
 * Read-only final validation pass.
 *
 * Checks the DB state after all scheduling passes complete and logs any
 * remaining violations. Does NOT modify data — violations here indicate
 * a scheduling bug that should be investigated.
 *
 * Checks:
 *   1. No van double-booked on the same date
 *   2. No unprotected booking outsourced when a free capable van exists
 *   3. All assigned vans satisfy capability/exclusivity rules (SG/TH/Alphard)
 */
export async function validateFinalSchedule(log: (msg: string) => void): Promise<void> {
  const allB = await db.select().from(bookings).orderBy(asc(bookings.id));
  const allV = await db.select().from(vans).orderBy(vans.id);

  let violations = 0;

  // ── Check 1: double-bookings ────────────────────────────────────────────────
  const vanDateMap = new Map<string, number[]>();
  for (const b of allB) {
    if (!b.vanId) continue;
    const key = `${b.vanId}::${b.travelDate}`;
    if (!vanDateMap.has(key)) vanDateMap.set(key, []);
    vanDateMap.get(key)!.push(b.id);
  }
  let doubleBookings = 0;
  for (const [key, ids] of vanDateMap) {
    if (ids.length > 1) {
      log(`[VALIDATION FAIL] double-booking: ${key} → ids=[${ids.join(",")}]`);
      doubleBookings++;
      violations++;
    }
  }
  if (doubleBookings === 0) log("  ✓ no double-bookings");

  // ── Check 2: outsourced when a free capable van existed ─────────────────────
  // Build occupied-slot set from assigned bookings
  const occupiedSlots = new Set<string>(
    allB.filter((b) => b.vanId).map((b) => `${b.vanId}::${b.travelDate}`)
  );
  const needlessOutsources: number[] = [];
  for (const b of allB) {
    if (b.manualChange === 1) continue;
    if ((b.vehicleCategory ?? "Van") === "Car") continue;
    if (b.inHouseOrOutsourced !== "O") continue;
    if ((b.outsourcedCompany ?? "").trim() !== "") continue; // confirmed outsource

    const { needsSingapore, needsThailand } = detectTripRequirements(
      b.fromLocation ?? "",
      b.toLocation ?? "",
    );
    const isAlphardBooking = (b.isAlphardTrip ?? 0) === 1;

    const freeVanExists = allV.some((v) => {
      if (needsSingapore && v.singaporeEnabled !== 1) return false;
      if (needsThailand && v.thailandEnabled !== 1) return false;
      const isVanAlphard = (v.vehicleType ?? "").toLowerCase() === "toyota alphard";
      if (isAlphardBooking && !isVanAlphard) return false;
      if (!isAlphardBooking && isVanAlphard) return false;
      return !occupiedSlots.has(`${v.id}::${b.travelDate}`);
    });

    if (freeVanExists) {
      log(`[VALIDATION WARN] #${b.id} (${b.travelDate} ${b.fromLocation}→${b.toLocation}) outsourced unnecessarily — a free capable van exists`);
      needlessOutsources.push(b.id);
      violations++;
    }
  }
  if (needlessOutsources.length === 0) log("  ✓ no unnecessary outsourcing");

  // ── Check 3: capability violations on assigned bookings ─────────────────────
  let capViolations = 0;
  for (const b of allB) {
    if (!b.vanId) continue;
    const van = allV.find((v) => v.id === b.vanId);
    if (!van) {
      log(`[VALIDATION FAIL] #${b.id} assigned to non-existent van ${b.vanId}`);
      capViolations++;
      violations++;
      continue;
    }
    const { needsSingapore, needsThailand } = detectTripRequirements(
      b.fromLocation ?? "",
      b.toLocation ?? "",
    );
    if (needsSingapore && van.singaporeEnabled !== 1) {
      log(`[VALIDATION FAIL] #${b.id} needs Singapore-capable van but van ${b.vanId} is not enabled`);
      capViolations++;
      violations++;
    }
    if (needsThailand && van.thailandEnabled !== 1) {
      log(`[VALIDATION FAIL] #${b.id} needs Thailand-capable van but van ${b.vanId} is not enabled`);
      capViolations++;
      violations++;
    }
    const isVanAlphard = (van.vehicleType ?? "").toLowerCase() === "toyota alphard";
    const isAlphardBooking = (b.isAlphardTrip ?? 0) === 1;
    if (isAlphardBooking && !isVanAlphard) {
      log(`[VALIDATION FAIL] #${b.id} is an Alphard trip but assigned to regular van ${b.vanId}`);
      capViolations++;
      violations++;
    }
    if (!isAlphardBooking && isVanAlphard) {
      log(`[VALIDATION FAIL] #${b.id} is not an Alphard trip but assigned to Alphard van ${b.vanId}`);
      capViolations++;
      violations++;
    }
  }
  if (capViolations === 0) log("  ✓ all capability rules satisfied");

  if (violations === 0) {
    log("  ✓ final schedule validation passed — no violations");
  } else {
    log(`[VALIDATION] ${violations} violation(s) found — see above`);
  }
}
