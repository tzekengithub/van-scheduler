import { db } from "@/lib/db";
import { bookings, vans } from "@/drizzle/schema";
import { eq, and, isNull, isNotNull, inArray, asc, ne, or } from "drizzle-orm";
import { smartAssignVan, AssignResult, detectTripRequirements } from "@/lib/van-assignment";

/**
 * Priority rank for processing order and bumping.
 * Lower number = higher priority = processed first = harder to bump.
 *
 * Business tiers (highest → lowest):
 *   Tier 1: day_trip
 *   Tier 2: trip, round_trip, tpri  (standard)
 *   Tier 3: one_way_ride            (LOWEST — processed last, bumped first)
 */
function priorityRank(tripType: string | null | undefined): number {
  switch (tripType) {
    case "day_trip":     return 0; // Tier 1 — highest, processed first, can bump others
    case "trip":         return 1; // Tier 2 — standard
    case "round_trip":   return 1; // Tier 2 — standard (same as trip)
    case "tpri":         return 1; // Tier 2 — standard (same as trip)
    case "one_way_ride": return 2; // Tier 3 — LOWEST, processed last, bumped first
    default:             return 1; // unknown → treat as standard tier
  }
}

// Types that can be bumped by a day_trip, ordered LOWEST priority first.
// one_way_ride is bumped first (most disposable per business rules),
// then standard trips (trip/tpri/round_trip).
// tpri is included so it participates in bumping like any other standard trip.
const BUMP_TYPES = ["one_way_ride", "trip", "tpri", "round_trip"] as const;

/**
 * Reassign vans to unassigned bookings.
 *
 * @param bookingIds - If provided, only process these specific booking IDs.
 *                     If omitted, process ALL bookings where vanId IS NULL
 *                     and manualChange = 0.
 *
 * Processing order within each date: day_trip → one_way_ride → round_trip → trip.
 * This ensures Day Trips always get priority access to free vans.
 *
 * Bumping: if a day_trip cannot find a free van, it displaces the lowest-priority
 * already-assigned booking on the same date. The bumped booking is retried in a
 * second pass (without bumping rights).
 *
 * Rows with manualChange = 1 are never touched (neither bumped nor reassigned).
 */
export async function runReassign(
  bookingIds?: number[],
  logger?: (msg: string) => void,
): Promise<{ assigned: number; conflicts: number }> {
  const log = (msg: string) => { console.log(msg); logger?.(msg); };
  const allVans = await db.select().from(vans);
  const vanMap = new Map(allVans.map((v) => [v.id, v]));

  // ── Fetch target bookings (Car trips are always outsourced — skip them) ──────
  const notCarTrip = or(isNull(bookings.vehicleCategory), ne(bookings.vehicleCategory, "Car"));
  const raw =
    bookingIds && bookingIds.length > 0
      ? await db
          .select()
          .from(bookings)
          .where(and(inArray(bookings.id, bookingIds), notCarTrip))
      : await db
          .select()
          .from(bookings)
          .where(and(isNull(bookings.vanId), eq(bookings.manualChange, 0), notCarTrip));

  // Sort: date ASC, then priority (day_trip first within each date), then invoice/vehicleIndex
  const targetBookings = [...raw].sort((a, b) => {
    if (a.travelDate !== b.travelDate)
      return a.travelDate.localeCompare(b.travelDate);
    const pa = priorityRank(a.tripType);
    const pb = priorityRank(b.tripType);
    if (pa !== pb) return pa - pb;
    if ((a.invoiceNo ?? "") !== (b.invoiceNo ?? ""))
      return (a.invoiceNo ?? "").localeCompare(b.invoiceNo ?? "");
    return (a.vehicleIndex ?? 1) - (b.vehicleIndex ?? 1);
  });

  // Pre-load all currently assigned bookings for bump candidate lookup.
  // Keyed by "travelDate::tripType" → [{id, vanId}]. Updated as the loop runs.
  const existingAssigned = await db
    .select({ id: bookings.id, vanId: bookings.vanId, travelDate: bookings.travelDate, tripType: bookings.tripType })
    .from(bookings)
    .where(and(isNotNull(bookings.vanId), eq(bookings.manualChange, 0)));

  const bumpIndex = new Map<string, Array<{ id: number; vanId: number }>>();
  for (const b of existingAssigned) {
    const key = `${b.travelDate}::${b.tripType ?? "trip"}`;
    if (!bumpIndex.has(key)) bumpIndex.set(key, []);
    bumpIndex.get(key)!.push({ id: b.id, vanId: b.vanId! });
  }

  let assigned = 0;
  let conflicts = 0;
  const bumpedIds: number[] = []; // bookings displaced by a day_trip — need a retry

  // ── Main pass ────────────────────────────────────────────────────────────────
  for (const b of targetBookings) {
    if (b.manualChange === 1) continue;

    const assignResult: AssignResult = await smartAssignVan(
      b.travelDate,
      b.fromLocation,
      b.toLocation,
      b.invoiceNo ?? "",
      b.vehicleIndex ?? 1,
      b.numberOfVehicles ?? 1,
      b.tripType,
      b.isAlphardTrip === 1,
      b.vehicleCategory,
    );
    const vanId = typeof assignResult === "number" ? assignResult : null;

    if (vanId != null) {
      // ── Normal assignment ──────────────────────────────────────────────────
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

      // Track in bump index so later day_trips can see this assignment
      const assignKey = `${b.travelDate}::${b.tripType ?? "trip"}`;
      if (!bumpIndex.has(assignKey)) bumpIndex.set(assignKey, []);
      bumpIndex.get(assignKey)!.push({ id: b.id, vanId });

      log(
        `[runReassign] OK      id=${b.id} ${b.invoiceNo ?? "no-inv"} date=${b.travelDate} vi=${b.vehicleIndex} (${b.tripType ?? "?"}) → van ${vanId} (${van?.vanNumber ?? "?"})`
      );
      assigned++;
    } else if (b.tripType === "day_trip") {
      // ── Day Trip: try to bump a lower-priority booking on the same date ────
      let bumped = false;
      const { needsSingapore, needsThailand } = detectTripRequirements(
        b.fromLocation, b.toLocation,
      );

      for (const bumpType of BUMP_TYPES) {
        // Use in-memory index instead of DB query
        const candidates = (bumpIndex.get(`${b.travelDate}::${bumpType}`) ?? [])
          .filter((c) => c.id !== b.id && c.vanId != null);

        // Only bump if the victim's van is capable and matches Alphard eligibility
        const isDayTripAlphard = b.isAlphardTrip === 1;
        const victim = candidates.find((c) => {
          const van = vanMap.get(c.vanId!);
          if (!van) return false;
          if (needsSingapore && van.singaporeEnabled !== 1) return false;
          if (needsThailand && van.thailandEnabled !== 1) return false;
          const isVanAlphard = (van.vehicleType ?? "").toLowerCase() === "toyota alphard";
          if (isDayTripAlphard && !isVanAlphard) return false;
          if (!isDayTripAlphard && isVanAlphard) return false;
          return true;
        }) ?? null;

        if (victim && victim.vanId != null) {
          const bumpedVanId = victim.vanId;
          const van = vanMap.get(bumpedVanId);

          // Displace the victim
          await db
            .update(bookings)
            .set({ vanId: null, vehiclePlate: "", driverName: "", driverContact: "" })
            .where(eq(bookings.id, victim.id));

          // Assign that van to this Day Trip
          await db
            .update(bookings)
            .set({
              vanId: bumpedVanId,
              vehiclePlate: van?.vanNumber ?? "",
              driverName: van?.driverName ?? "",
              driverContact: van?.driverContact ?? "",
            })
            .where(eq(bookings.id, b.id));

          // Update bump index: remove victim, add day_trip
          const victimKey = `${b.travelDate}::${bumpType}`;
          bumpIndex.set(victimKey, (bumpIndex.get(victimKey) ?? []).filter((c) => c.id !== victim.id));
          const dayTripKey = `${b.travelDate}::day_trip`;
          if (!bumpIndex.has(dayTripKey)) bumpIndex.set(dayTripKey, []);
          bumpIndex.get(dayTripKey)!.push({ id: b.id, vanId: bumpedVanId });

          log(
            `[runReassign] BUMP    day_trip id=${b.id} date=${b.travelDate} displaced ${bumpType} id=${victim.id} → van ${bumpedVanId} (${van?.vanNumber ?? "?"})`
          );

          bumpedIds.push(victim.id);
          assigned++;
          bumped = true;
          break;
        }
      }

      if (!bumped) {
        // All same-date bookings are day_trips or manual — Day Trip is itself a conflict
        await db
          .update(bookings)
          .set({ vanId: null, vehiclePlate: "", driverName: "", driverContact: "" })
          .where(eq(bookings.id, b.id));

        log(
          `[runReassign] CONFLICT day_trip id=${b.id} date=${b.travelDate} → no bumpable booking found`
        );
        conflicts++;
      }
    } else {
      // ── Standard trip (trip/round_trip/tpri): bump one_way_ride if a
      //    Singapore- or Thailand-capable van is needed and all capable vans
      //    are occupied by lower-priority one-way rides. ────────────────────
      const { needsSingapore, needsThailand } = detectTripRequirements(
        b.fromLocation, b.toLocation,
      );

      let bumped = false;

      if (needsSingapore || needsThailand) {
        const candidates = (bumpIndex.get(`${b.travelDate}::one_way_ride`) ?? [])
          .filter((c) => c.id !== b.id && c.vanId != null);

        const isAlphard = b.isAlphardTrip === 1;
        const victim = candidates.find((c) => {
          const van = vanMap.get(c.vanId!);
          if (!van) return false;
          if (needsSingapore && van.singaporeEnabled !== 1) return false;
          if (needsThailand && van.thailandEnabled !== 1) return false;
          const isVanAlphard = (van.vehicleType ?? "").toLowerCase() === "toyota alphard";
          if (isAlphard && !isVanAlphard) return false;
          if (!isAlphard && isVanAlphard) return false;
          return true;
        }) ?? null;

        if (victim && victim.vanId != null) {
          const bumpedVanId = victim.vanId;
          const van = vanMap.get(bumpedVanId);

          // Displace the victim
          await db
            .update(bookings)
            .set({ vanId: null, vehiclePlate: "", driverName: "", driverContact: "" })
            .where(eq(bookings.id, victim.id));

          // Assign that van to this trip
          await db
            .update(bookings)
            .set({
              vanId: bumpedVanId,
              vehiclePlate: van?.vanNumber ?? "",
              driverName: van?.driverName ?? "",
              driverContact: van?.driverContact ?? "",
            })
            .where(eq(bookings.id, b.id));

          // Update bump index
          const victimKey = `${b.travelDate}::one_way_ride`;
          bumpIndex.set(victimKey, (bumpIndex.get(victimKey) ?? []).filter((c) => c.id !== victim.id));
          const tripKey = `${b.travelDate}::${b.tripType ?? "trip"}`;
          if (!bumpIndex.has(tripKey)) bumpIndex.set(tripKey, []);
          bumpIndex.get(tripKey)!.push({ id: b.id, vanId: bumpedVanId });

          log(
            `[runReassign] BUMP    ${b.tripType} id=${b.id} date=${b.travelDate} (sg=${needsSingapore} th=${needsThailand}) displaced one_way_ride id=${victim.id} → van ${bumpedVanId} (${van?.vanNumber ?? "?"})`
          );

          bumpedIds.push(victim.id);
          assigned++;
          bumped = true;
        }
      }

      if (!bumped) {
        await db
          .update(bookings)
          .set({ vanId: null, vehiclePlate: "", driverName: "", driverContact: "" })
          .where(eq(bookings.id, b.id));

        log(
          `[runReassign] CONFLICT id=${b.id} ${b.invoiceNo ?? "no-inv"} date=${b.travelDate} vi=${b.vehicleIndex} (${b.tripType ?? "?"}) → no free van`
        );
        conflicts++;
      }
    }
  }

  // ── Second pass: retry bumped bookings (no bumping rights) ──────────────────
  if (bumpedIds.length > 0) {
    log(
      `[runReassign] second pass: retrying ${bumpedIds.length} bumped booking(s)`
    );

    for (const bumpedId of bumpedIds) {
      const [b] = await db
        .select()
        .from(bookings)
        .where(eq(bookings.id, bumpedId))
        .limit(1);

      // Skip if already reassigned, manual, or missing
      if (!b || b.manualChange === 1 || b.vanId != null) continue;

      const retryResult: AssignResult = await smartAssignVan(
        b.travelDate,
        b.fromLocation,
        b.toLocation,
        b.invoiceNo ?? "",
        b.vehicleIndex ?? 1,
        b.numberOfVehicles ?? 1,
        b.tripType,
        b.isAlphardTrip === 1,
        b.vehicleCategory,
      );
      const vanId = typeof retryResult === "number" ? retryResult : null;

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

        log(
          `[runReassign] RETRY-OK id=${b.id} ${b.invoiceNo ?? "no-inv"} date=${b.travelDate} → van ${vanId} (${van?.vanNumber ?? "?"})`
        );
        assigned++;
      } else {
        log(
          `[runReassign] RETRY-CONFLICT id=${b.id} ${b.invoiceNo ?? "no-inv"} date=${b.travelDate} → no free van (outsourced)`
        );
        conflicts++;
      }
    }
  }

  log(`[runReassign] done — assigned=${assigned} conflicts=${conflicts}`);
  return { assigned, conflicts };
}
