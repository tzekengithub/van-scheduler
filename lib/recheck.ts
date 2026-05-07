import { db } from "@/lib/db";
import { bookings, vans } from "@/drizzle/schema";
import { eq, and, isNull, isNotNull, inArray, asc } from "drizzle-orm";
import { runReassign } from "@/lib/reassign";
import { detectTripRequirements, isVanCapable } from "@/lib/van-assignment";

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

  // ── Snapshot all auto-managed bookings before the destructive reset ──────────
  // neon-http has no interactive transactions, so we implement rollback manually:
  // if any step after the reset throws, we restore these snapshot values.
  const snapshot = await db
    .select({
      id: bookings.id,
      vanId: bookings.vanId,
      vehiclePlate: bookings.vehiclePlate,
      driverName: bookings.driverName,
      driverContact: bookings.driverContact,
      inHouseOrOutsourced: bookings.inHouseOrOutsourced,
      outsourcedCompany: bookings.outsourcedCompany,
      outsourceReason: bookings.outsourceReason,
    })
    .from(bookings)
    .where(eq(bookings.manualChange, 0));

  try {
    // ── Step 2: Batch-reset — clear van + restore to in-house ─────────────────
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

    // ── Step 3: Reassign all cleared bookings ──────────────────────────────────
    log("Step 3/7 — running van reassignment (priority: trip > one_way_ride)…");
    const { assigned, conflicts } = await runReassign(undefined, log);
    log(`  reassignment done — assigned=${assigned} conflicts=${conflicts}`);

    // ── Step 4: Enforce same-invoice-same-van ──────────────────────────────────
    log("Step 4/7 — enforcing same invoice = same van per (invoiceNo, vehicleIndex)…");
    await enforceInvoiceVanConsistency(log);

    // ── Step 5: Same-day same-invoice-slot conflicts → assign any free van ─────
    log("Step 5/7 — assigning free vans to same-invoice/vehicleIndex/date conflicts…");
    await assignFreeVanToSameDayConflicts(log);

    // ── Step 6: HARD GUARANTEE — eliminate every double-booking ───────────────
    log("Step 6/7 — scanning for double-bookings (same van, same date)…");
    await eliminateDoubleBookings(log);

    // ── Step 6b: Rescue bookings incorrectly left unassigned ──────────────────
    log("Step 6b/7 — rescuing any unassigned bookings that have a free or bumpable van…");
    await rescueIncorrectOutsources(log);

    // ── Step 7: Any still-unassigned → mark as outsourced ─────────────────────
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
        .set({ inHouseOrOutsourced: "O", outsourceReason: "No van available after schedule check" })
        .where(inArray(bookings.id, stillUnassigned.map((b) => b.id)));
      log(`  marked ${stillUnassigned.length} booking(s) as outsourced (no van available)`);
    } else {
      log("  all bookings have a van assigned ✓");
    }

    log("━━━ RECHECK COMPLETE ━━━");
  } catch (err) {
    // Restore pre-recheck state so a partial failure doesn't leave the schedule corrupt
    log(`[recheckAllVans] ERROR — rolling back ${snapshot.length} booking(s) to pre-recheck state…`);
    try {
      const ROLLBACK_CHUNK = 100;
      for (let i = 0; i < snapshot.length; i += ROLLBACK_CHUNK) {
        await Promise.all(
          snapshot.slice(i, i + ROLLBACK_CHUNK).map((row) =>
            db.update(bookings)
              .set({
                vanId: row.vanId,
                vehiclePlate: row.vehiclePlate,
                driverName: row.driverName,
                driverContact: row.driverContact,
                inHouseOrOutsourced: row.inHouseOrOutsourced,
                outsourcedCompany: row.outsourcedCompany,
                outsourceReason: row.outsourceReason,
              })
              .where(eq(bookings.id, row.id))
          )
        );
      }
      log("[recheckAllVans] Rollback complete — schedule restored to pre-recheck state");
    } catch (rollbackErr) {
      log(`[recheckAllVans] ROLLBACK FAILED: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)} — DB may be in partial state`);
    }
    throw err;
  }
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

  log("Check 0/5 — enforcing same invoice = same van…");
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
      .set({ inHouseOrOutsourced: "O", outsourceReason: "No van available after schedule check" })
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
    const b15Pax = (b.is15PaxTrip ?? 0) === 1;

    // Iterate in deterministic order (allVans already sorted by id).
    // Removed the previous Math.random() shuffle — randomness caused different
    // van assignments on every run for the same input data.
    let freeVan: typeof allVans[number] | null = null;
    for (const van of allVans) {
      if (!isVanCapable(van, { needsSingapore, needsThailand, isAlphardTrip: isAlphardBooking, is15PaxTrip: b15Pax })) continue;
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
      is15PaxTrip: bookings.is15PaxTrip,
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
    } else if ((b.is15PaxTrip ?? 0) === 1 && (van.maxPaxCapacity ?? 0) < 15) {
      log(
        `[fixCapability] id=${b.id} date=${b.travelDate} inv=${b.invoiceNo ?? "?"}: ` +
        `15-pax trip assigned to van ${van.vanNumber} with capacity ${van.maxPaxCapacity ?? 0} — unassigning`
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
  const vanMap = new Map(allVans.map((v) => [v.id, v]));

  // Load all currently assigned bookings with full info — needed so we can
  // decide which occupants are bumpable (priority or SG/TH override) and
  // filter out victims that themselves need the same SG/TH specialty.
  const allAssigned = await db
    .select({
      id: bookings.id,
      vanId: bookings.vanId,
      travelDate: bookings.travelDate,
      tripType: bookings.tripType,
      fromLocation: bookings.fromLocation,
      toLocation: bookings.toLocation,
      isAlphardTrip: bookings.isAlphardTrip,
      is15PaxTrip: bookings.is15PaxTrip,
      manualChange: bookings.manualChange,
      inHouseOrOutsourced: bookings.inHouseOrOutsourced,
      outsourcedCompany: bookings.outsourcedCompany,
    })
    .from(bookings)
    .where(isNotNull(bookings.vanId));

  type Occupant = {
    id: number;
    tripType: string;
    fromLocation: string;
    toLocation: string;
    isAlphardTrip: number;
    is15PaxTrip: number;
    locked: boolean;
  };
  const occupants = new Map<string, Occupant>();
  for (const r of allAssigned) {
    const locked =
      r.manualChange === 1 ||
      (r.inHouseOrOutsourced === "O" && (r.outsourcedCompany ?? "").trim() !== "");
    occupants.set(`${r.vanId}::${r.travelDate}`, {
      id: r.id,
      tripType: r.tripType ?? "trip",
      fromLocation: r.fromLocation ?? "",
      toLocation: r.toLocation ?? "",
      isAlphardTrip: r.isAlphardTrip ?? 0,
      is15PaxTrip: r.is15PaxTrip ?? 0,
      locked,
    });
  }

  let rescued = 0;
  // Victims displaced by a bump get retried once at the end (free-van only,
  // no further bumping rights) to guarantee termination.
  const bumpedVictimIds: number[] = [];

  for (const b of toRescue) {
    const { needsSingapore, needsThailand } = detectTripRequirements(
      b.fromLocation ?? "",
      b.toLocation ?? "",
    );
    const isAlphardBooking = (b.isAlphardTrip ?? 0) === 1;
    const needs15Pax = (b.is15PaxTrip ?? 0) === 1;

    // ── 1. Free van search ──────────────────────────────────────────────────
    let freeVan: (typeof allVans)[number] | null = null;
    for (const van of allVans) {
      if (!isVanCapable(van, { needsSingapore, needsThailand, isAlphardTrip: isAlphardBooking, is15PaxTrip: needs15Pax })) continue;
      if (!occupants.has(`${van.id}::${b.travelDate}`)) {
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
      occupants.set(`${freeVan.id}::${b.travelDate}`, {
        id: b.id,
        tripType: b.tripType ?? "trip",
        fromLocation: b.fromLocation ?? "",
        toLocation: b.toLocation ?? "",
        isAlphardTrip: b.isAlphardTrip ?? 0,
        is15PaxTrip: b.is15PaxTrip ?? 0,
        locked: false,
      });
      log(
        `[rescue] id=${b.id} date=${b.travelDate} ${b.fromLocation}→${b.toLocation} → van ${freeVan.id} (${freeVan.vanNumber ?? "?"})`,
      );
      rescued++;
      continue;
    }

    // ── 2. No free van — try to bump a lower-priority / non-specialty occupant ─
    // Path 1: priority bump — any non-one_way_ride booking may displace a
    //         same-date one_way_ride on a capability-matching van.
    // Path 2: SG/TH override bump — a booking needing Singapore or Thailand
    //         capability may displace ANY non-SG/TH booking on a capable van,
    //         regardless of the victim's priority tier. Victims that themselves
    //         need the same specialty are never chosen (no zero-sum swap).
    let victimKey: string | null = null;
    let victimInfo: Occupant | null = null;
    let bumpLabel = "";

    if ((b.tripType ?? "trip") !== "one_way_ride") {
      for (const [key, occ] of occupants) {
        if (occ.locked) continue;
        if (occ.tripType !== "one_way_ride") continue;
        const [vanIdStr, date] = key.split("::");
        if (date !== b.travelDate) continue;
        const van = vanMap.get(Number(vanIdStr));
        if (!van) continue;
        if (!isVanCapable(van, { needsSingapore, needsThailand, isAlphardTrip: isAlphardBooking, is15PaxTrip: needs15Pax })) continue;
        victimKey = key;
        victimInfo = occ;
        bumpLabel = "priority bump";
        break;
      }
    }

    if (!victimKey && (needsSingapore || needsThailand)) {
      for (const [key, occ] of occupants) {
        if (occ.locked) continue;
        const [vanIdStr, date] = key.split("::");
        if (date !== b.travelDate) continue;
        const van = vanMap.get(Number(vanIdStr));
        if (!van) continue;
        if (needsSingapore && van.singaporeEnabled !== 1) continue;
        if (needsThailand && van.thailandEnabled !== 1) continue;
        const isVanAlphard = (van.vehicleType ?? "").toLowerCase() === "toyota alphard";
        if (isAlphardBooking && !isVanAlphard) continue;
        if (!isAlphardBooking && isVanAlphard) continue;
        const victimReq = detectTripRequirements(occ.fromLocation, occ.toLocation);
        if (needsSingapore && victimReq.needsSingapore) continue;
        if (needsThailand && victimReq.needsThailand) continue;
        victimKey = key;
        victimInfo = occ;
        bumpLabel = "SG/TH override bump";
        break;
      }
    }

    if (!victimKey && needs15Pax) {
      for (const [key, occ] of occupants) {
        if (occ.locked) continue;
        const [vanIdStr, date] = key.split("::");
        if (date !== b.travelDate) continue;
        const van = vanMap.get(Number(vanIdStr));
        if (!van) continue;
        if ((van.maxPaxCapacity ?? 0) < 15) continue;
        const isVanAlphard = (van.vehicleType ?? "").toLowerCase() === "toyota alphard";
        if (isAlphardBooking && !isVanAlphard) continue;
        if (!isAlphardBooking && isVanAlphard) continue;
        // Only displace non-15-pax occupants — no zero-sum swaps
        if ((occ.is15PaxTrip ?? 0) === 1) continue;
        victimKey = key;
        victimInfo = occ;
        bumpLabel = "15-pax override bump";
        break;
      }
    }

    if (victimKey && victimInfo) {
      const [vanIdStr] = victimKey.split("::");
      const bumpVanId = Number(vanIdStr);
      const bumpVan = vanMap.get(bumpVanId)!;

      await db
        .update(bookings)
        .set({
          vanId: null,
          vehiclePlate: "",
          driverName: "",
          driverContact: "",
          inHouseOrOutsourced: "I",
          outsourcedCompany: "",
        })
        .where(eq(bookings.id, victimInfo.id));

      await db
        .update(bookings)
        .set({
          vanId: bumpVanId,
          vehiclePlate: bumpVan.vanNumber ?? "",
          driverName: bumpVan.driverName ?? "",
          driverContact: bumpVan.driverContact ?? "",
          inHouseOrOutsourced: "I",
          outsourcedCompany: "",
        })
        .where(eq(bookings.id, b.id));

      occupants.set(victimKey, {
        id: b.id,
        tripType: b.tripType ?? "trip",
        fromLocation: b.fromLocation ?? "",
        toLocation: b.toLocation ?? "",
        isAlphardTrip: b.isAlphardTrip ?? 0,
        is15PaxTrip: b.is15PaxTrip ?? 0,
        locked: false,
      });

      log(
        `[rescue] id=${b.id} ${bumpLabel}: displaced ${victimInfo.tripType} id=${victimInfo.id} → van ${bumpVanId} (${bumpVan.vanNumber ?? "?"})`,
      );
      rescued++;
      bumpedVictimIds.push(victimInfo.id);
      continue;
    }

    log(
      `[rescue] id=${b.id} date=${b.travelDate} — all capable vans taken, cannot rescue`,
    );
  }

  // ── Second pass: retry displaced victims with free-van search only ───────
  // No bumping rights in this pass to guarantee termination.
  for (const vid of bumpedVictimIds) {
    const [v] = await db.select().from(bookings).where(eq(bookings.id, vid)).limit(1);
    if (!v || v.vanId != null || v.manualChange === 1) continue;

    const { needsSingapore, needsThailand } = detectTripRequirements(
      v.fromLocation ?? "",
      v.toLocation ?? "",
    );
    const isAlphardBooking = (v.isAlphardTrip ?? 0) === 1;
    const v15Pax = (v.is15PaxTrip ?? 0) === 1;

    let freeVan: (typeof allVans)[number] | null = null;
    for (const van of allVans) {
      if (!isVanCapable(van, { needsSingapore, needsThailand, isAlphardTrip: isAlphardBooking, is15PaxTrip: v15Pax })) continue;
      if (!occupants.has(`${van.id}::${v.travelDate}`)) {
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
        .where(eq(bookings.id, v.id));
      occupants.set(`${freeVan.id}::${v.travelDate}`, {
        id: v.id,
        tripType: v.tripType ?? "trip",
        fromLocation: v.fromLocation ?? "",
        toLocation: v.toLocation ?? "",
        isAlphardTrip: v.isAlphardTrip ?? 0,
        is15PaxTrip: v.is15PaxTrip ?? 0,
        locked: false,
      });
      log(
        `[rescue] RETRY-OK id=${v.id} date=${v.travelDate} → van ${freeVan.id} (${freeVan.vanNumber ?? "?"})`,
      );
      rescued++;
    } else {
      log(
        `[rescue] RETRY-CONFLICT id=${v.id} date=${v.travelDate} — no free van after bump, will be outsourced`,
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
      is15PaxTrip: bookings.is15PaxTrip,
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

    // Detect same-day duplicates: dates with multiple bookings under the same
    // (invoiceNo, vehicleIndex) need separate vans that day and cannot be
    // consolidated. Exclude those dates and consolidate the remaining dates.
    const dateCounts = new Map<string, number>();
    for (const d of dates) dateCounts.set(d, (dateCounts.get(d) ?? 0) + 1);
    const duplicateDates = new Set(
      [...dateCounts.entries()].filter(([, n]) => n > 1).map(([d]) => d)
    );

    const consolidationRows = duplicateDates.size > 0
      ? rows.filter((r) => !duplicateDates.has(r.travelDate))
      : rows;

    if (duplicateDates.size > 0) {
      log(
        `[enforceInvoice] ${slotKey}: ${duplicateDates.size} same-day duplicate date(s) (${[...duplicateDates].join(",")}) excluded — consolidating ${consolidationRows.length} remaining row(s)`
      );
      if (consolidationRows.length <= 1) {
        log(`[enforceInvoice] ${slotKey}: SKIP — no consolidatable rows remain`);
        continue;
      }
      const filteredVanSet = new Set(consolidationRows.map((r) => r.vanId!));
      if (filteredVanSet.size <= 1) {
        log(`[enforceInvoice] ${slotKey}: non-duplicate dates already consistent ✓`);
        continue;
      }
    }

    // Detect mixed Alphard/non-Alphard legs within the same invoice slot.
    // A single van cannot serve both types. Instead of skipping the whole group,
    // split into two sub-groups (Alphard legs / regular legs) and consolidate each
    // independently. This preserves invoice continuity within each vehicle type.
    const alphardCount = consolidationRows.filter((r) => (r.isAlphardTrip ?? 0) === 1).length;
    const isMixedAlphard = alphardCount > 0 && alphardCount < consolidationRows.length;

    const subGroups: Array<{ label: string; subRows: typeof rows }> = isMixedAlphard
      ? [
          { label: `${slotKey}[regular]`, subRows: consolidationRows.filter((r) => (r.isAlphardTrip ?? 0) === 0) },
          { label: `${slotKey}[alphard]`, subRows: consolidationRows.filter((r) => (r.isAlphardTrip ?? 0) === 1) },
        ]
      : [{ label: slotKey, subRows: consolidationRows }];

    if (isMixedAlphard) {
      log(
        `[enforceInvoice] ${slotKey}: mixed Alphard group — splitting into ${consolidationRows.length - alphardCount} regular + ${alphardCount} Alphard sub-group(s) for separate consolidation`
      );
    } else {
      log(
        `[enforceInvoice] ${slotKey}: ${consolidationRows.length} row(s) to consolidate across vans [${[...vanSet].join(",")}]`
      );
    }

    for (const { label, subRows } of subGroups) {
      if (subRows.length <= 1) continue;
      const subVanSet = new Set(subRows.map((r) => r.vanId!));
      if (subVanSet.size <= 1) continue; // already consistent ✓

      const subDates = subRows.map((r) => r.travelDate);
      const subBookingIds = subRows.map((r) => r.id);

      // Check for same-day duplicates within this sub-group
      const subDateSet = new Set(subDates);
      if (subDateSet.size < subDates.length) {
        log(`[enforceInvoice] ${label}: SKIP — same-day duplicates within sub-group`);
        continue;
      }

      // Determine capability requirements across sub-group legs only
      let needsSingapore = false;
      let needsThailand = false;
      for (const r of subRows) {
        const reqs = detectTripRequirements(r.fromLocation ?? "", r.toLocation ?? "");
        if (reqs.needsSingapore) needsSingapore = true;
        if (reqs.needsThailand) needsThailand = true;
      }
      const isAlphardBooking = subRows.some((r) => (r.isAlphardTrip ?? 0) === 1);
      const needs15Pax = subRows.some((r) => (r.is15PaxTrip ?? 0) === 1);

      if (needs15Pax) {
        log(`[enforceInvoice] ${label}: 15-pax required — only considering vans with maxPaxCapacity >= 15`);
      }

      const capableVans = allVans.filter((v) =>
        isVanCapable(v, { needsSingapore, needsThailand, isAlphardTrip: isAlphardBooking, is15PaxTrip: needs15Pax })
      );

      // Prefer vans already used by this sub-group (fewer moves), then all others
      const vanPriority = [
        ...capableVans.filter((v) => subVanSet.has(v.id)),
        ...capableVans.filter((v) => !subVanSet.has(v.id)),
      ];

      const subBookingIdSet = new Set(subBookingIds);

      let targetVan: typeof allVans[number] | null = null;
      for (const van of vanPriority) {
        const blocked = subDates.some((date) => {
          const slotBookingId = occupiedSlots.get(`${van.id}::${date}`);
          return slotBookingId !== undefined && !subBookingIdSet.has(slotBookingId);
        });
        if (!blocked) {
          targetVan = van;
          break;
        }
        log(`  van ${van.id} (${van.vanNumber}) blocked on ≥1 date — trying next`);
      }

      if (!targetVan) {
        log(`[enforceInvoice] ${label}: no single van free on all dates — leaving split`);
        continue;
      }

      // Move all sub-group rows not already on targetVan
      const toMove = subRows.filter((b) => b.vanId !== targetVan!.id);
      if (toMove.length > 0) {
        await db
          .update(bookings)
          .set({
            vanId: targetVan.id,
            vehiclePlate: targetVan.vanNumber ?? "",
            driverName: targetVan.driverName ?? "",
            driverContact: targetVan.driverContact ?? "",
            inHouseOrOutsourced: "I",
            outsourcedCompany: "",
          })
          .where(inArray(bookings.id, toMove.map((b) => b.id)));

        for (const b of toMove) {
          occupiedSlots.delete(`${b.vanId}::${b.travelDate}`);
          occupiedSlots.set(`${targetVan.id}::${b.travelDate}`, b.id);
          log(`[enforceInvoice] ${label} id=${b.id} date=${b.travelDate} → van ${targetVan.id} (${targetVan.vanNumber})`);
        }
      }
      const moved = toMove.length;
      log(`[enforceInvoice] ${label}: consolidated to van ${targetVan.id} (${targetVan.vanNumber ?? "?"}), moved ${moved} booking(s)`);
      fixed += moved;
    }
  }

  // ── Third pass: pull unassigned legs onto their invoice's consistent van ──────
  // After consolidation, some legs may still be unassigned (e.g. outsourced earlier
  // because the van was busy). Re-fetch state and assign them if the consistent van
  // is now free on those dates.
  const freshAssigned = await db
    .select({
      invoiceNo: bookings.invoiceNo,
      vehicleIndex: bookings.vehicleIndex,
      vanId: bookings.vanId,
      travelDate: bookings.travelDate,
    })
    .from(bookings)
    .where(isNotNull(bookings.vanId));

  const freshOccupied = new Set<string>(freshAssigned.map((b) => `${b.vanId}::${b.travelDate}`));

  const consistentSlotVan = new Map<string, number>();
  const freshGroups = new Map<string, typeof freshAssigned>();
  for (const b of freshAssigned) {
    if (!b.invoiceNo) continue;
    const key = `${b.invoiceNo}::${b.vehicleIndex ?? 1}`;
    if (!freshGroups.has(key)) freshGroups.set(key, []);
    freshGroups.get(key)!.push(b);
  }
  for (const [key, rows] of freshGroups) {
    const vanSet = new Set(rows.map((r) => r.vanId!));
    if (vanSet.size === 1) consistentSlotVan.set(key, [...vanSet][0]);
  }

  const unassignedLegs = await db
    .select({
      id: bookings.id,
      invoiceNo: bookings.invoiceNo,
      vehicleIndex: bookings.vehicleIndex,
      travelDate: bookings.travelDate,
      isAlphardTrip: bookings.isAlphardTrip,
    })
    .from(bookings)
    .where(and(isNull(bookings.vanId), eq(bookings.manualChange, 0), isNotNull(bookings.invoiceNo)));

  let continuityFixed = 0;
  for (const leg of unassignedLegs) {
    if (!leg.invoiceNo) continue;
    const key = `${leg.invoiceNo}::${leg.vehicleIndex ?? 1}`;
    const targetVanId = consistentSlotVan.get(key);
    if (targetVanId == null) continue;
    if (freshOccupied.has(`${targetVanId}::${leg.travelDate}`)) continue;

    const van = allVans.find((v) => v.id === targetVanId);
    if (!van) continue;

    const isAlphardBooking = (leg.isAlphardTrip ?? 0) === 1;
    const isVanAlphard_ = (van.vehicleType ?? "").toLowerCase() === "toyota alphard";
    if (isAlphardBooking !== isVanAlphard_) continue;

    await db.update(bookings).set({
      vanId: targetVanId,
      vehiclePlate: van.vanNumber ?? "",
      driverName: van.driverName ?? "",
      driverContact: van.driverContact ?? "",
      inHouseOrOutsourced: "I",
      outsourcedCompany: "",
      outsourceReason: "",
    }).where(eq(bookings.id, leg.id));

    freshOccupied.add(`${targetVanId}::${leg.travelDate}`);
    log(`[enforceInvoice] continuity: unassigned id=${leg.id} date=${leg.travelDate} → van ${targetVanId} (${van.vanNumber ?? "?"}) (${leg.invoiceNo})`);
    continuityFixed++;
  }
  if (continuityFixed > 0) {
    log(`  assigned ${continuityFixed} unassigned leg(s) to invoice's consistent van`);
    fixed += continuityFixed;
  }

  if (inconsistent === 0 && continuityFixed === 0) {
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
      is15PaxTrip: bookings.is15PaxTrip,
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
      const victim15Pax = (victim.is15PaxTrip ?? 0) === 1;
      let freeVan: (typeof allVans)[number] | null = null;
      for (const van of allVans) {
        if (van.id === victim.vanId) continue;
        if (!isVanCapable(van, { needsSingapore, needsThailand, isAlphardTrip: isAlphardBooking, is15PaxTrip: victim15Pax })) continue;
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
            inHouseOrOutsourced: "I",
            outsourcedCompany: "",
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
            outsourceReason: "Double-booking conflict — no free van",
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
    const val15Pax = (b.is15PaxTrip ?? 0) === 1;

    const freeVanExists = allV.some((v) =>
      isVanCapable(v, { needsSingapore, needsThailand, isAlphardTrip: isAlphardBooking, is15PaxTrip: val15Pax }) &&
      !occupiedSlots.has(`${v.id}::${b.travelDate}`)
    );

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
    if ((b.is15PaxTrip ?? 0) === 1 && (van.maxPaxCapacity ?? 0) < 15) {
      log(`[VALIDATION FAIL] #${b.id} is a 15-pax trip but van ${b.vanId} has capacity ${van.maxPaxCapacity ?? 0}`);
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
