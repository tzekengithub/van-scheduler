import { db } from "@/lib/db";
import { bookings, vans } from "@/drizzle/schema";
import { eq, and, isNull, isNotNull, inArray, asc, ne, or } from "drizzle-orm";
import { smartAssignVan, AssignResult, detectTripRequirements } from "@/lib/van-assignment";

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
  // Keyed by "travelDate::tripType" → [{id, vanId, from, to}]. Updated as the loop runs.
  // fromLocation/toLocation are needed so the SG/TH override bump can skip victims
  // that themselves need the same specialty (no zero-sum swaps).
  const existingAssigned = await db
    .select({
      id: bookings.id,
      vanId: bookings.vanId,
      travelDate: bookings.travelDate,
      tripType: bookings.tripType,
      fromLocation: bookings.fromLocation,
      toLocation: bookings.toLocation,
    })
    .from(bookings)
    .where(and(isNotNull(bookings.vanId), eq(bookings.manualChange, 0)));

  type BumpEntry = { id: number; vanId: number; fromLocation: string; toLocation: string };
  const bumpIndex = new Map<string, Array<BumpEntry>>();
  for (const b of existingAssigned) {
    const key = `${b.travelDate}::${b.tripType ?? "trip"}`;
    if (!bumpIndex.has(key)) bumpIndex.set(key, []);
    bumpIndex.get(key)!.push({
      id: b.id,
      vanId: b.vanId!,
      fromLocation: b.fromLocation ?? "",
      toLocation: b.toLocation ?? "",
    });
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
          inHouseOrOutsourced: "I",
          outsourcedCompany: "",
        })
        .where(eq(bookings.id, b.id));

      const assignKey = `${b.travelDate}::${b.tripType ?? "trip"}`;
      if (!bumpIndex.has(assignKey)) bumpIndex.set(assignKey, []);
      bumpIndex.get(assignKey)!.push({
        id: b.id,
        vanId,
        fromLocation: b.fromLocation ?? "",
        toLocation: b.toLocation ?? "",
      });

      log(`[runReassign] OK      id=${b.id} ${b.invoiceNo ?? "no-inv"} date=${b.travelDate} vi=${b.vehicleIndex} (${b.tripType ?? "?"}) → van ${vanId} (${van?.vanNumber ?? "?"})`);
      assigned++;
    } else {
      // ── No free van: attempt to bump a lower-priority booking ─────────────
      // Rule: higher priority MUST get a van. Search bumpableTypes() in order
      // (lowest priority first) for a same-date booking to displace.
      const { needsSingapore, needsThailand } = detectTripRequirements(b.fromLocation, b.toLocation);
      const isAlphard = b.isAlphardTrip === 1;
      const allowedBumpTypes = bumpableTypes(b.tripType);

      let bumped = false;

      for (const bumpType of allowedBumpTypes) {
        const candidates = (bumpIndex.get(`${b.travelDate}::${bumpType}`) ?? [])
          .filter((c) => c.id !== b.id && c.vanId != null);

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

          const victimKey = `${b.travelDate}::${bumpType}`;
          bumpIndex.set(victimKey, (bumpIndex.get(victimKey) ?? []).filter((c) => c.id !== victim.id));
          const winnerKey = `${b.travelDate}::${b.tripType ?? "trip"}`;
          if (!bumpIndex.has(winnerKey)) bumpIndex.set(winnerKey, []);
          bumpIndex.get(winnerKey)!.push({
            id: b.id,
            vanId: bumpedVanId,
            fromLocation: b.fromLocation ?? "",
            toLocation: b.toLocation ?? "",
          });

          log(`[runReassign] BUMP    ${b.tripType} id=${b.id} date=${b.travelDate} displaced ${bumpType} id=${victim.id} → van ${bumpedVanId} (${van?.vanNumber ?? "?"})`);

          bumpedIds.push(victim.id);
          assigned++;
          bumped = true;
          break;
        }
      }

      // ── SG/TH override bump ─────────────────────────────────────────────
      // If no same-priority victim was found and this booking needs Singapore
      // or Thailand capability, the LOCATION-BASED OVERRIDE rule allows it to
      // displace ANY non-SG/TH booking on a capable van, regardless of the
      // victim's priority tier. This ensures SG/TH trips are outsourced ONLY
      // when every capable van is already holding another SG/TH trip.
      if (!bumped && (needsSingapore || needsThailand)) {
        // Collect all same-date candidates across both tripType buckets.
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
          // Van must have the needed capability and correct vehicle type.
          if (needsSingapore && van.singaporeEnabled !== 1) return false;
          if (needsThailand && van.thailandEnabled !== 1) return false;
          const isVanAlphard = (van.vehicleType ?? "").toLowerCase() === "toyota alphard";
          if (isAlphard && !isVanAlphard) return false;
          if (!isAlphard && isVanAlphard) return false;
          // Victim must NOT itself need the same specialty — otherwise the
          // displaced booking would immediately need the same kind of van.
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
          });

          log(
            `[runReassign] SG/TH OVERRIDE BUMP id=${b.id} (needs${needsSingapore ? "SG" : "TH"}) displaced ${victim.tripType} id=${victim.id} → van ${bumpedVanId} (${van?.vanNumber ?? "?"})`,
          );

          bumpedIds.push(victim.id);
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
            inHouseOrOutsourced: "I",
            outsourcedCompany: "",
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
