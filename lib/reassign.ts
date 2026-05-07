import { db } from "@/lib/db";
import { bookings, vans } from "@/drizzle/schema";
import { eq, and, isNull, isNotNull, inArray, asc, ne, or } from "drizzle-orm";
import { detectTripRequirements, isVanCapable } from "@/lib/van-assignment";

/**
 * Two priority tiers — the only trip types the system uses:
 *   Tier 1: "trip"         — processed first, can bump one_way_ride
 *   Tier 2: "one_way_ride" — processed last, displaced first
 *
 * Lower number = higher priority.
 */
function priorityRank(tripType: string | null | undefined): number {
  return tripType === "one_way_ride" ? 1 : 0; // everything else is Tier 1
}

/**
 * Returns the trip types a booking may displace.
 *   trip        → may bump one_way_ride
 *   one_way_ride→ may not bump anything
 */
function bumpableTypes(tripType: string | null | undefined): readonly string[] {
  return tripType === "one_way_ride" ? [] : ["one_way_ride"];
}

/**
 * Reassign vans to unassigned bookings.
 *
 * Pure in-memory scheduling — no per-booking DB queries, no AI calls.
 * Loads all vans + assigned bookings once upfront, then runs entirely in memory.
 *
 * @param bookingIds - If provided, only process these specific booking IDs.
 *                     If omitted, process ALL bookings where vanId IS NULL
 *                     and manualChange = 0.
 *
 * Processing order within each date: trip → one_way_ride.
 * Higher-priority bookings claim free vans first.
 *
 * Bumping: if a trip cannot find a free van it MUST displace a same-date
 * one_way_ride. The displaced booking is retried in a second pass (without
 * bumping rights). Only outsource when no van and no bumpable booking exist.
 *
 * Rows with manualChange = 1 are never touched (neither bumped nor reassigned).
 */
export async function runReassign(
  bookingIds?: number[],
  logger?: (msg: string) => void,
): Promise<{ assigned: number; conflicts: number }> {
  const log = (msg: string) => { console.log(msg); logger?.(msg); };
  const allVans = await db.select().from(vans).orderBy(vans.id);
  const vanMap = new Map(allVans.map((v) => [v.id, v]));

  // ── Fetch target bookings (Car trips are always outsourced — skip them) ──────
  const notCarTrip = or(isNull(bookings.vehicleCategory), ne(bookings.vehicleCategory, "Car"));
  // Exclude confirmed outsources (inHouseOrOutsourced='O' with company filled in)
  // — those are deliberate user decisions and must never be auto-assigned.
  const notConfirmedOutsource = or(
    ne(bookings.inHouseOrOutsourced, "O"),
    isNull(bookings.outsourcedCompany),
    eq(bookings.outsourcedCompany, ""),
  );
  const raw =
    bookingIds && bookingIds.length > 0
      ? await db
          .select()
          .from(bookings)
          .where(and(inArray(bookings.id, bookingIds), notCarTrip))
      : await db
          .select()
          .from(bookings)
          .where(and(isNull(bookings.vanId), eq(bookings.manualChange, 0), notCarTrip, notConfirmedOutsource));

  // Sort: date ASC, then priority (trip first within each date), then invoice/vehicleIndex
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

  // Pre-load all currently assigned bookings — used for both bump candidates and
  // in-memory scheduling. Fetched once; never re-queried per booking.
  const existingAssigned = await db
    .select({
      id: bookings.id,
      vanId: bookings.vanId,
      travelDate: bookings.travelDate,
      tripType: bookings.tripType,
      fromLocation: bookings.fromLocation,
      toLocation: bookings.toLocation,
      is15PaxTrip: bookings.is15PaxTrip,
      invoiceNo: bookings.invoiceNo,
      vehicleIndex: bookings.vehicleIndex,
      isAlphardTrip: bookings.isAlphardTrip,
    })
    .from(bookings)
    .where(and(isNotNull(bookings.vanId), eq(bookings.manualChange, 0)));

  type BumpEntry = { id: number; vanId: number; fromLocation: string; toLocation: string; is15PaxTrip: number };
  const bumpIndex = new Map<string, Array<BumpEntry>>();
  for (const b of existingAssigned) {
    const key = `${b.travelDate}::${b.tripType ?? "trip"}`;
    if (!bumpIndex.has(key)) bumpIndex.set(key, []);
    bumpIndex.get(key)!.push({
      id: b.id,
      vanId: b.vanId!,
      fromLocation: b.fromLocation ?? "",
      toLocation: b.toLocation ?? "",
      is15PaxTrip: b.is15PaxTrip ?? 0,
    });
  }

  // ── In-memory scheduling structures ──────────────────────────────────────────
  // Replaces 3 DB queries + 1 AI call that smartAssignVan made per booking.

  // "vanId::travelDate" → occupied; updated as we assign
  const occupiedSlots = new Set<string>(
    existingAssigned.map((b) => `${b.vanId}::${b.travelDate}`)
  );

  // "invoiceNo::vehicleIndex" → preferred vanId (for multi-day continuity)
  const invoiceVanPreference = new Map<string, number>();
  for (const b of existingAssigned) {
    if (b.invoiceNo) {
      const key = `${b.invoiceNo}::${b.vehicleIndex ?? 1}`;
      if (!invoiceVanPreference.has(key)) invoiceVanPreference.set(key, b.vanId!);
    }
  }

  // vanId → last toLocation (routing continuity hint); most-recent-date wins
  const vanLastDropOff = new Map<number, string | null>();
  const sortedByDateDesc = [...existingAssigned].sort((a, b) =>
    b.travelDate.localeCompare(a.travelDate)
  );
  for (const b of sortedByDateDesc) {
    if (b.vanId != null && !vanLastDropOff.has(b.vanId))
      vanLastDropOff.set(b.vanId, b.toLocation ?? null);
  }
  for (const van of allVans) {
    if (!vanLastDropOff.has(van.id)) vanLastDropOff.set(van.id, null);
  }

  // Lookup map for bumped victim data (avoids per-ID DB query in second pass)
  const existingById = new Map(existingAssigned.map((b) => [b.id, b]));

  // Track which bumped victims are still unassigned (vanId cleared in DB)
  const bumpedAndUnassigned = new Set<number>();

  // ── Pure in-memory van selection ───────────────────────────────────────────
  // Mirrors smartAssignVan's decision logic without any DB/AI calls.
  function findBestVan(
    travelDate: string,
    fromLocation: string | null,
    toLocation: string | null,
    invoiceNo: string,
    vehicleIndex: number,
    isAlphardTrip: boolean,
    is15PaxTrip: boolean,
  ): number | null {
    const { needsSingapore, needsThailand } = detectTripRequirements(
      fromLocation ?? "", toLocation ?? ""
    );

    // allVans already sorted by id — lowest id wins ties
    const eligible = allVans.filter((van) =>
      isVanCapable(van, { needsSingapore, needsThailand, isAlphardTrip, is15PaxTrip })
    );

    const free = eligible.filter((v) => !occupiedSlots.has(`${v.id}::${travelDate}`));
    if (free.length === 0) return null;

    // 1. Prefer van already used by this invoice+vehicleIndex (multi-day continuity)
    const preferredVanId = invoiceVanPreference.get(`${invoiceNo}::${vehicleIndex}`);
    if (preferredVanId) {
      const pref = free.find((v) => v.id === preferredVanId);
      if (pref) return pref.id;
    }

    // 2. Prefer van whose last drop-off matches fromLocation (routing continuity)
    if (fromLocation) {
      const locationMatch = free.find((v) => vanLastDropOff.get(v.id) === fromLocation);
      if (locationMatch) return locationMatch.id;
    }

    // 3. Lowest id
    return free[0].id;
  }

  let assigned = 0;
  let conflicts = 0;
  const bumpedIds: number[] = [];

  // ── Main pass ────────────────────────────────────────────────────────────────
  for (const b of targetBookings) {
    if (b.manualChange === 1) continue;

    const vanId = findBestVan(
      b.travelDate,
      b.fromLocation,
      b.toLocation,
      b.invoiceNo ?? "",
      b.vehicleIndex ?? 1,
      b.isAlphardTrip === 1,
      (b.is15PaxTrip ?? 0) === 1,
    );

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
          inHouseOrOutsourced: "I",
          outsourcedCompany: "",
        })
        .where(eq(bookings.id, b.id));

      // Update in-memory state
      occupiedSlots.add(`${vanId}::${b.travelDate}`);
      if (b.invoiceNo) {
        const invKey = `${b.invoiceNo}::${b.vehicleIndex ?? 1}`;
        if (!invoiceVanPreference.has(invKey)) invoiceVanPreference.set(invKey, vanId);
      }
      vanLastDropOff.set(vanId, b.toLocation ?? null);

      const assignKey = `${b.travelDate}::${b.tripType ?? "trip"}`;
      if (!bumpIndex.has(assignKey)) bumpIndex.set(assignKey, []);
      bumpIndex.get(assignKey)!.push({
        id: b.id,
        vanId,
        fromLocation: b.fromLocation ?? "",
        toLocation: b.toLocation ?? "",
        is15PaxTrip: b.is15PaxTrip ?? 0,
      });

      log(`[runReassign] OK      id=${b.id} ${b.invoiceNo ?? "no-inv"} date=${b.travelDate} vi=${b.vehicleIndex} (${b.tripType ?? "?"}) → van ${vanId} (${van?.vanNumber ?? "?"})`);
      assigned++;
    } else {
      // ── No free van: attempt to bump a lower-priority booking ─────────────
      const { needsSingapore, needsThailand } = detectTripRequirements(b.fromLocation, b.toLocation);
      const isAlphard = b.isAlphardTrip === 1;
      const needs15Pax = (b.is15PaxTrip ?? 0) === 1;
      const allowedBumpTypes = bumpableTypes(b.tripType);

      let bumped = false;

      for (const bumpType of allowedBumpTypes) {
        const candidates = (bumpIndex.get(`${b.travelDate}::${bumpType}`) ?? [])
          .filter((c) => c.id !== b.id && c.vanId != null);

        const victim = candidates.find((c) => {
          const van = vanMap.get(c.vanId!);
          if (!van) return false;
          return isVanCapable(van, { needsSingapore, needsThailand, isAlphardTrip: isAlphard, is15PaxTrip: needs15Pax });
        }) ?? null;

        if (victim && victim.vanId != null) {
          const bumpedVanId = victim.vanId;
          const van = vanMap.get(bumpedVanId);

          await db.update(bookings)
            .set({ vanId: null, vehiclePlate: "", driverName: "", driverContact: "", inHouseOrOutsourced: "I", outsourcedCompany: "" })
            .where(eq(bookings.id, victim.id));

          await db.update(bookings)
            .set({
              vanId: bumpedVanId,
              vehiclePlate: van?.vanNumber ?? "",
              driverName: van?.driverName ?? "",
              driverContact: van?.driverContact ?? "",
              inHouseOrOutsourced: "I",
              outsourcedCompany: "",
            })
            .where(eq(bookings.id, b.id));

          // Slot stays occupied (now by b). Update invoice preference for b.
          if (b.invoiceNo) {
            const invKey = `${b.invoiceNo}::${b.vehicleIndex ?? 1}`;
            if (!invoiceVanPreference.has(invKey)) invoiceVanPreference.set(invKey, bumpedVanId);
          }

          const victimKey = `${b.travelDate}::${bumpType}`;
          bumpIndex.set(victimKey, (bumpIndex.get(victimKey) ?? []).filter((c) => c.id !== victim.id));
          const winnerKey = `${b.travelDate}::${b.tripType ?? "trip"}`;
          if (!bumpIndex.has(winnerKey)) bumpIndex.set(winnerKey, []);
          bumpIndex.get(winnerKey)!.push({
            id: b.id,
            vanId: bumpedVanId,
            fromLocation: b.fromLocation ?? "",
            toLocation: b.toLocation ?? "",
            is15PaxTrip: b.is15PaxTrip ?? 0,
          });

          log(`[runReassign] BUMP    ${b.tripType} id=${b.id} date=${b.travelDate} displaced ${bumpType} id=${victim.id} → van ${bumpedVanId} (${van?.vanNumber ?? "?"})`);

          bumpedIds.push(victim.id);
          bumpedAndUnassigned.add(victim.id);
          assigned++;
          bumped = true;
          break;
        }
      }

      // ── SG/TH override bump ─────────────────────────────────────────────
      if (!bumped && (needsSingapore || needsThailand)) {
        const allSameDate: Array<BumpEntry & { tripType: string }> = [];
        for (const [key, entries] of bumpIndex.entries()) {
          const [date, tripType] = key.split("::");
          if (date !== b.travelDate) continue;
          for (const e of entries) {
            if (e.id === b.id) continue;
            allSameDate.push({ ...e, tripType });
          }
        }

        const victim = allSameDate.find((c) => {
          const van = vanMap.get(c.vanId);
          if (!van) return false;
          if (needsSingapore && van.singaporeEnabled !== 1) return false;
          if (needsThailand && van.thailandEnabled !== 1) return false;
          const isVanAlphard = (van.vehicleType ?? "").toLowerCase() === "toyota alphard";
          if (isAlphard && !isVanAlphard) return false;
          if (!isAlphard && isVanAlphard) return false;
          const victimReq = detectTripRequirements(c.fromLocation, c.toLocation);
          if (needsSingapore && victimReq.needsSingapore) return false;
          if (needsThailand && victimReq.needsThailand) return false;
          return true;
        });

        if (victim) {
          const bumpedVanId = victim.vanId;
          const van = vanMap.get(bumpedVanId);

          await db
            .update(bookings)
            .set({ vanId: null, vehiclePlate: "", driverName: "", driverContact: "", inHouseOrOutsourced: "I", outsourcedCompany: "" })
            .where(eq(bookings.id, victim.id));

          await db
            .update(bookings)
            .set({
              vanId: bumpedVanId,
              vehiclePlate: van?.vanNumber ?? "",
              driverName: van?.driverName ?? "",
              driverContact: van?.driverContact ?? "",
              inHouseOrOutsourced: "I",
              outsourcedCompany: "",
            })
            .where(eq(bookings.id, b.id));

          if (b.invoiceNo) {
            const invKey = `${b.invoiceNo}::${b.vehicleIndex ?? 1}`;
            if (!invoiceVanPreference.has(invKey)) invoiceVanPreference.set(invKey, bumpedVanId);
          }

          const victimKey = `${b.travelDate}::${victim.tripType}`;
          bumpIndex.set(
            victimKey,
            (bumpIndex.get(victimKey) ?? []).filter((c) => c.id !== victim.id),
          );
          const winnerKey = `${b.travelDate}::${b.tripType ?? "trip"}`;
          if (!bumpIndex.has(winnerKey)) bumpIndex.set(winnerKey, []);
          bumpIndex.get(winnerKey)!.push({
            id: b.id,
            vanId: bumpedVanId,
            fromLocation: b.fromLocation ?? "",
            toLocation: b.toLocation ?? "",
            is15PaxTrip: b.is15PaxTrip ?? 0,
          });

          log(
            `[runReassign] SG/TH OVERRIDE BUMP id=${b.id} (needs${needsSingapore ? "SG" : "TH"}) displaced ${victim.tripType} id=${victim.id} → van ${bumpedVanId} (${van?.vanNumber ?? "?"})`,
          );

          bumpedIds.push(victim.id);
          bumpedAndUnassigned.add(victim.id);
          assigned++;
          bumped = true;
        }
      }

      // ── 15-pax override bump ─────────────────────────────────────────────
      if (!bumped && needs15Pax) {
        const allSameDate: Array<BumpEntry & { tripType: string }> = [];
        for (const [key, entries] of bumpIndex.entries()) {
          const [date, tripType] = key.split("::");
          if (date !== b.travelDate) continue;
          for (const e of entries) {
            if (e.id === b.id) continue;
            allSameDate.push({ ...e, tripType });
          }
        }

        const victim = allSameDate.find((c) => {
          const van = vanMap.get(c.vanId);
          if (!van) return false;
          if ((van.maxPaxCapacity ?? 0) < 15) return false;
          const isVanAlphard = (van.vehicleType ?? "").toLowerCase() === "toyota alphard";
          if (isAlphard && !isVanAlphard) return false;
          if (!isAlphard && isVanAlphard) return false;
          if ((c.is15PaxTrip ?? 0) === 1) return false;
          return true;
        });

        if (victim) {
          const bumpedVanId = victim.vanId;
          const van = vanMap.get(bumpedVanId);

          await db
            .update(bookings)
            .set({ vanId: null, vehiclePlate: "", driverName: "", driverContact: "", inHouseOrOutsourced: "I", outsourcedCompany: "" })
            .where(eq(bookings.id, victim.id));

          await db
            .update(bookings)
            .set({
              vanId: bumpedVanId,
              vehiclePlate: van?.vanNumber ?? "",
              driverName: van?.driverName ?? "",
              driverContact: van?.driverContact ?? "",
              inHouseOrOutsourced: "I",
              outsourcedCompany: "",
            })
            .where(eq(bookings.id, b.id));

          if (b.invoiceNo) {
            const invKey = `${b.invoiceNo}::${b.vehicleIndex ?? 1}`;
            if (!invoiceVanPreference.has(invKey)) invoiceVanPreference.set(invKey, bumpedVanId);
          }

          const victimKey = `${b.travelDate}::${victim.tripType}`;
          bumpIndex.set(victimKey, (bumpIndex.get(victimKey) ?? []).filter((c) => c.id !== victim.id));
          const winnerKey = `${b.travelDate}::${b.tripType ?? "trip"}`;
          if (!bumpIndex.has(winnerKey)) bumpIndex.set(winnerKey, []);
          bumpIndex.get(winnerKey)!.push({
            id: b.id,
            vanId: bumpedVanId,
            fromLocation: b.fromLocation ?? "",
            toLocation: b.toLocation ?? "",
            is15PaxTrip: b.is15PaxTrip ?? 0,
          });

          log(
            `[runReassign] 15-PAX OVERRIDE BUMP id=${b.id} displaced ${victim.tripType} id=${victim.id} on 15-seater → van ${bumpedVanId} (${van?.vanNumber ?? "?"})`,
          );

          bumpedIds.push(victim.id);
          bumpedAndUnassigned.add(victim.id);
          assigned++;
          bumped = true;
        }
      }

      if (!bumped) {
        await db.update(bookings)
          .set({ vanId: null, vehiclePlate: "", driverName: "", driverContact: "" })
          .where(eq(bookings.id, b.id));

        log(`[runReassign] CONFLICT id=${b.id} ${b.invoiceNo ?? "no-inv"} date=${b.travelDate} vi=${b.vehicleIndex} (${b.tripType ?? "?"}) → no free van and no bumpable booking`);
        conflicts++;
      }
    }
  }

  // ── Second pass: retry bumped bookings (no bumping rights, no DB queries) ────
  if (bumpedIds.length > 0) {
    log(
      `[runReassign] second pass: retrying ${bumpedIds.length} bumped booking(s)`
    );

    for (const bumpedId of bumpedIds) {
      if (!bumpedAndUnassigned.has(bumpedId)) continue; // already re-assigned

      const b = existingById.get(bumpedId);
      if (!b) continue;

      const vanId = findBestVan(
        b.travelDate,
        b.fromLocation ?? null,
        b.toLocation ?? null,
        b.invoiceNo ?? "",
        b.vehicleIndex ?? 1,
        (b.isAlphardTrip ?? 0) === 1,
        (b.is15PaxTrip ?? 0) === 1,
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
            inHouseOrOutsourced: "I",
            outsourcedCompany: "",
          })
          .where(eq(bookings.id, b.id));

        occupiedSlots.add(`${vanId}::${b.travelDate}`);
        if (b.invoiceNo) {
          const invKey = `${b.invoiceNo}::${b.vehicleIndex ?? 1}`;
          if (!invoiceVanPreference.has(invKey)) invoiceVanPreference.set(invKey, vanId);
        }
        bumpedAndUnassigned.delete(bumpedId);

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
