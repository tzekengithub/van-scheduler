import { db } from "@/lib/db";
import { bookings, vans } from "@/drizzle/schema";
import { eq, and, isNull, isNotNull, inArray, notInArray, ne, asc } from "drizzle-orm";
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
    })
    .from(bookings)
    .where(and(isNotNull(bookings.vanId), eq(bookings.manualChange, 0)));

  const allVans = await db.select().from(vans);

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

    // Determine capability requirements from this group's bookings
    const anyRow = rows[0];
    const { needsSingapore, needsThailand } = detectTripRequirements(
      anyRow.fromLocation ?? "",
      anyRow.toLocation ?? "",
    );
    const capableVans = allVans.filter((v) => {
      if (needsSingapore && v.singaporeEnabled !== 1) return false;
      if (needsThailand && v.thailandEnabled !== 1) return false;
      return true;
    });

    // Prefer vans already used by this group (fewer moves), then try all others
    const vanPriority = [
      ...capableVans.filter((v) => vanSet.has(v.id)),
      ...capableVans.filter((v) => !vanSet.has(v.id)),
    ];

    let targetVan: typeof allVans[number] | null = null;
    for (const van of vanPriority) {
      // Check if this van has ANY other booking on ANY of the group's dates
      const [blocker] = await db
        .select({ id: bookings.id })
        .from(bookings)
        .where(
          and(
            eq(bookings.vanId, van.id),
            inArray(bookings.travelDate, dates),
            notInArray(bookings.id, bookingIds),
          )
        )
        .limit(1);

      if (!blocker) {
        targetVan = van;
        break;
      }
      log(`  van ${van.id} (${van.vanNumber}) blocked on ≥1 date — trying next`);
    }

    if (!targetVan) {
      log(`[enforceInvoice] ${slotKey}: no single van free on all dates — leaving split`);
      continue;
    }

    // Move all rows not already on targetVan
    let moved = 0;
    for (const b of rows) {
      if (b.vanId === targetVan.id) continue;
      await db
        .update(bookings)
        .set({
          vanId: targetVan.id,
          vehiclePlate: targetVan.vanNumber ?? "",
          driverName: targetVan.driverName ?? "",
          driverContact: targetVan.driverContact ?? "",
        })
        .where(eq(bookings.id, b.id));
      log(`[enforceInvoice] ${slotKey} id=${b.id} date=${b.travelDate} → van ${targetVan.id} (${targetVan.vanNumber})`);
      moved++;
    }
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
      fromLocation: bookings.fromLocation,
      toLocation: bookings.toLocation,
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

      // Find a free, capability-matching van for the victim
      const { needsSingapore, needsThailand } = detectTripRequirements(
        victim.fromLocation ?? "",
        victim.toLocation ?? "",
      );
      let freeVan: (typeof allVans)[number] | null = null;
      for (const van of allVans) {
        if (van.id === victim.vanId) continue;
        if (needsSingapore && van.singaporeEnabled !== 1) continue;
        if (needsThailand && van.thailandEnabled !== 1) continue;
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
