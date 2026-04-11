/*
 * MANUAL ACTIONS REQUIRED BY STAFF:
 * 1. Fill in outsourcedCompany name when a booking is auto-outsourced
 *    → Van Schedule page shows conflict banner
 * 2. Mark bookings as paid (paidStatus)
 *    → Daily Jobs or All Jobs page
 * 3. Override incorrect van assignments
 *    → Click van field on any booking row to edit
 *    → This sets manualChange=1, locking the assignment
 * 4. Reset a bad manual assignment back to auto
 *    → Click "Reset to auto" on the booking row
 * 5. Add new vans or remove vans from the fleet
 *    → Dashboard → Van Management section
 * 6. Handle edge case routes the AI may not know about
 *    → If AI assigns wrong van for unusual route, override manually
 */

import { db } from "@/lib/db";
import { bookings, vans } from "@/drizzle/schema";
import { eq, isNotNull, inArray } from "drizzle-orm";
import { recheckAllVans, runConstraintChecks, runMidLayerChecks } from "@/lib/recheck";
import { runReassign } from "@/lib/reassign";
import { getActiveRules } from "@/lib/scheduling-rules";

export interface AiReasoningEntry {
  bookingId: number;
  van: string | null;
  action: "assigned" | "outsourced";
  reasoning: string;
}

export interface AiRecheckResult {
  summary: string;
  log: string[];
  reasoning: AiReasoningEntry[];
}

/** Max bookings per AI request — larger = fewer round trips = faster overall. */
const CHUNK_SIZE = 50;

const SYSTEM_PROMPT = `You are a van scheduling optimizer for a Malaysian transport company
called Excellent Travel. You assign vans to trip bookings.

THE FLEET:
You will receive the current van list in each request.

════════════════════════════════════════════════════════════
HARD CONSTRAINTS — never violate these under any circumstance
════════════════════════════════════════════════════════════
- One van = maximum one job per day. No exceptions.
- Routes containing "singapore" (case-insensitive) in from/to/details:
  only assign vans where singaporeEnabled = true.
- Routes containing "thailand" or "hatyai" or "hat yai" or "padang besar"
  (case-insensitive) in from/to/details: only assign vans where
  thailandEnabled = true.
- Never reassign bookings where manualChange = 1 (return currentVanId as-is).
- Never reassign confirmed outsourced bookings (inHouseOrOutsourced = 'O'
  with outsourcedCompany filled and non-empty).
- Bookings with vehicleCategory = "Car" (5-Seater / 7-Seater): always
  outsource — never assign a van from the fleet, no exceptions.
- Bookings with isAlphardTrip = 1: ONLY assign vans whose vehicleType is
  "toyota alphard" (case-insensitive). Never assign a regular van.
- Bookings with isAlphardTrip = 0 (or absent): NEVER assign a van whose
  vehicleType is "toyota alphard". Alphard vans are exclusively for
  Alphard-flagged trips — they must NOT appear as options for any
  regular trip, including "select free van" scenarios.

════════════════════════════════════════════════════════════
TRIP TYPE PRIORITY TIERS (highest → lowest)
════════════════════════════════════════════════════════════
Tier 1 — MULTI-DAY TRIPS  (tripType = "day_trip", OR the same invoiceNo
  spans consecutive dates across multiple bookings)
Tier 2 — STANDARD TRIPS   (tripType = "trip" or "round_trip" or "tpri")
Tier 3 — ONE-WAY RIDES    (tripType = "one_way_ride") ← LOWEST PRIORITY

Higher tiers ALWAYS beat lower tiers for van access.
One-way rides are the least important trip type — if bumping a one-way
ride frees a van for a higher-priority trip, you MUST do it.

════════════════════════════════════════════════════════════
LOCATION-BASED OVERRIDE (Singapore / Thailand trips)
════════════════════════════════════════════════════════════
A Singapore-enabled or Thailand-enabled trip that needs a capable van
MAY bump ANY regular Malaysia-only trip — regardless of that trip's tier —
if that is the only way to assign a capable van in-house.
When bumping: reassign the displaced Malaysia trip to the next best free
van, or outsource it only if no other van is available.

════════════════════════════════════════════════════════════
BUMPING LOGIC — think before outsourcing
════════════════════════════════════════════════════════════
STABILITY FIRST: If a booking already has currentVanId and that van is
free on that date (no conflict), keep it exactly as-is. Do not move it.
Only trigger the bump cascade when a genuine conflict exists.

BEFORE marking any booking as outsourced, you MUST check:
1. Is there a free (unassigned) van on that date that meets the route
   constraints? If yes → assign it. Never outsource when a free van exists.
2. Is there a lower-priority trip occupying a van on that date?
   If yes → BUMP the lower-priority trip off that van; reassign the bumped
   trip to another free van (or outsource the bumped trip if no van is
   available). Give the freed van to the higher-priority trip.
3. Only after exhausting steps 1 and 2 may you outsource a booking.

Bump cascade rules:
- Multi-day trip bumps any Tier 2 or Tier 3 trip.
- Standard trip bumps any Tier 3 (one-way) trip.
- One-way trip CANNOT bump anything — it is displaced first.
- When a bumped trip itself cannot find a free van, it is outsourced.
  But try hard: check all remaining free vans before outsourcing.
- Do NOT outsource a high-priority trip just because the naive first-fit
  fails. Think globally across all vans.

════════════════════════════════════════════════════════════
OPTIMIZATION GOALS — in strict priority order
════════════════════════════════════════════════════════════
1. Keep jobs in-house — never outsource when a free or bumpable van exists.

2. Invoice continuity (IN-HOUSE vans only) — all bookings sharing the same
   (invoiceNo + vehicleIndex) across multiple dates MUST use the same van,
   PROVIDED:
   a. The van was assigned in-house (not outsourced) on the earlier leg.
   b. The gap between legs is NOT more than a few days for one-way trips
      (one_way_ride). One-way trips with a multi-day gap between legs on the
      same invoice do NOT require continuity — treat them as independent and
      assign the best available van.
   If a booking's currentVanId was set while it was outsourced
   (inHouseOrOutsourced = 'O'), invoice continuity does NOT apply —
   reassign to the best available in-house van.

3. Location continuity — if a van's last job on a date ends at location X,
   prefer assigning that van to the next job departing from X on a
   subsequent date.

4. Bumping to prevent outsourcing (see BUMPING LOGIC above).

5. Assignment stability — STRONG RULE. Each booking has an "isNew" flag:
   - isNew = true  → just uploaded, no van yet, assign freely.
   - isNew = false → already assigned (currentVanId is set). You MUST
     keep the existing van UNLESS a strictly higher-priority isNew trip
     needs that exact van+date slot and there is no free alternative.
     Never move an isNew=false booking for soft reasons like workload
     balance or location preference — only bump it when forced by a
     genuine priority conflict with a new trip.

6. Workload distribution — spread jobs evenly across vans ONLY when
   assigning bookings that have no current van (vanId = null). Never
   reshuffle an already-assigned booking purely for balance.

════════════════════════════════════════════════════════════
OUTSOURCE RULES — last resort only
════════════════════════════════════════════════════════════
Outsource ONLY when ALL of the following are true:
- Every van capable of the route (SG/TH constraints) is already committed
  on that date, AND
- No lower-priority booking can be bumped to free a capable van, AND
- The booking is NOT a vehicleCategory = "Car" (those always outsource).

Do NOT blindly outsource. Think step by step. Show your work in reasoning.

════════════════════════════════════════════════════════════
OUTPUT — return ONLY this JSON shape, nothing else
════════════════════════════════════════════════════════════
{
  "assignments": [
    {
      "bookingId": 123,
      "vanId": 4,
      "reasoning": "one concise sentence"
    }
  ],
  "outsourced": [
    {
      "bookingId": 456,
      "reasoning": "one concise sentence explaining why no van was available after bumping"
    }
  ],
  "summary": "2-3 sentence plain English overview of the full schedule, highlighting any outsourced jobs, bumps, or notable decisions"
}

Every bookingId from the input must appear in either assignments or outsourced. Never omit a booking from the output.`;

/**
 * Run the AI scheduler.
 *
 * @param logger    Optional streaming log callback.
 * @param newIds    When provided (e.g. just-uploaded rows), these IDs are
 *                  flagged as "isNew: true" in the payload. The AI still sees
 *                  ALL unprotected bookings so it can bump older low-priority
 *                  ones to make room — but it knows existing assigned bookings
 *                  should only be moved when a new higher-priority trip
 *                  genuinely needs their slot.
 */
export async function aiRecheckAllVans(
  logger?: (msg: string) => void,
  newIds?: number[],
): Promise<AiRecheckResult> {
  const log: string[] = [];
  const emit = (msg: string) => {
    log.push(msg);
    logger?.(msg);
  };

  try {
    // ── Step 1: Fetch all data ──────────────────────────────────────────────────
    // Sort vans by id so rescue-pass van selection is deterministic across runs.
    const allVans = await db.select().from(vans).orderBy(vans.id);
    const allBookings = await db.select().from(bookings);

    const isProtected = (b: (typeof allBookings)[0]) =>
      b.manualChange === 1 ||
      (b.inHouseOrOutsourced === "O" && (b.outsourcedCompany ?? "").trim() !== "");

    const unprotected = allBookings.filter((b) => !isProtected(b));
    const newIdSet = newIds ? new Set(newIds) : null;

    // ── Step 1.5 (full-recheck mode only): Reset all auto assignments ──────────
    // When called without newIds (manual Recheck button), start from a clean
    // slate: clear van assignments for all non-protected bookings so the AI
    // assigns everything fresh — exactly like uploading new bookings from scratch.
    // Car trips are excluded (they stay outsourced; the AI will outsource them
    // again immediately per the hard constraint).
    if (!newIds) {
      const toReset = unprotected.filter((b) => b.vehicleCategory !== "Car");
      if (toReset.length > 0) {
        const toResetIds = toReset.map((b) => b.id);
        emit(`🔄 Full recheck — resetting ${toResetIds.length} booking(s) to clean slate…`);
        await db
          .update(bookings)
          .set({
            vanId: null,
            vehiclePlate: null,
            driverName: null,
            driverContact: null,
            inHouseOrOutsourced: "I",
            outsourcedCompany: null,
          })
          .where(inArray(bookings.id, toResetIds));
        // Mirror in-memory so isNew detection sees vanId = null for all of them
        for (const b of toReset) {
          b.vanId = null;
          b.vehiclePlate = null;
          b.driverName = null;
          b.driverContact = null;
          b.inHouseOrOutsourced = "I";
          b.outsourcedCompany = null;
        }
      }
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");

    // ── Step 2: Build static payloads ──────────────────────────────────────────
    const vansPayload = allVans.map((v) => ({
      vanId: v.id,
      plate: v.vanNumber,
      driver: v.driverName ?? "",
      vehicleType: v.vehicleType ?? "van",
      singaporeEnabled: v.singaporeEnabled === 1,
      thailandEnabled: v.thailandEnabled === 1,
    }));

    const customRules = await getActiveRules();
    const customRulesSection =
      customRules.length > 0
        ? `\n\nCUSTOM SCHEDULING RULES (user-defined, highest priority after hard constraints):\n${customRules.map((r, i) => `${i + 1}. ${r}`).join("\n")}`
        : "";

    const vanMap = new Map(allVans.map((v) => [v.id, v]));

    // ── Step 3: Committed context — tracks what's locked across batches ────────
    // Pre-seed with protected bookings so the AI never double-books them.
    const committedVanDates = new Set<string>(); // "vanId::date"
    const committedInvoiceVans = new Map<string, number>(); // "invoiceNo::vi" → vanId

    for (const b of allBookings) {
      if (isProtected(b) && b.vanId) {
        committedVanDates.add(`${b.vanId}::${b.travelDate}`);
        if (b.invoiceNo) {
          committedInvoiceVans.set(`${b.invoiceNo}::${b.vehicleIndex ?? 1}`, b.vanId);
        }
      }
    }

    // ── Step 4: Working set — all unprotected bookings ───────────────────────
    // Always send the full set so the AI can see every booking and make
    // globally optimal decisions (bumping, workload balance, etc.).
    const workingSet = unprotected;

    if (workingSet.length === 0) {
      return { summary: "No bookings to assign.", log, reasoning: [] };
    }

    // ── Step 5: Split into 3 priority layers ──────────────────────────────────
    // Layer 1 (highest): day_trips + invoices spanning 2+ distinct dates (multi-day tours)
    // Layer 2 (standard): trip, round_trip, tpri
    // Layer 3 (lowest):  one_way_ride
    //
    // Each layer is processed as a separate set of AI batches. Committed slots from
    // Layer N are automatically available as locked context for Layer N+1, so
    // higher-priority bookings always claim vans before lower-priority ones even run.

    // Detect multi-day invoices (same invoiceNo on 2+ distinct travel dates)
    const invoiceDateCount = new Map<string, Set<string>>();
    for (const b of workingSet) {
      if (!b.invoiceNo) continue;
      if (!invoiceDateCount.has(b.invoiceNo)) invoiceDateCount.set(b.invoiceNo, new Set());
      invoiceDateCount.get(b.invoiceNo)!.add(b.travelDate);
    }
    const multiDayInvoices = new Set(
      [...invoiceDateCount.entries()]
        .filter(([, s]) => s.size > 1)
        .map(([inv]) => inv),
    );

    const byDate = (a: (typeof workingSet)[0], b: (typeof workingSet)[0]) =>
      a.travelDate.localeCompare(b.travelDate) ||
      (a.invoiceNo ?? "").localeCompare(b.invoiceNo ?? "") ||
      (a.vehicleIndex ?? 1) - (b.vehicleIndex ?? 1);

    const isL1 = (b: (typeof workingSet)[0]) =>
      (b.tripType ?? "").toLowerCase() === "day_trip" ||
      multiDayInvoices.has(b.invoiceNo ?? "");
    const isL3 = (b: (typeof workingSet)[0]) =>
      (b.tripType ?? "").toLowerCase() === "one_way_ride";

    const layers = [
      {
        label: "Layer 1/3 — Day Trips + Multi-day Tours (highest priority)",
        bookings: [...workingSet].filter(isL1).sort(byDate),
      },
      {
        label: "Layer 2/3 — Standard Trips",
        bookings: [...workingSet].filter((b) => !isL1(b) && !isL3(b)).sort(byDate),
      },
      {
        label: "Layer 3/3 — One-Way Rides (lowest priority)",
        bookings: [...workingSet].filter(isL3).sort(byDate),
      },
    ];

    emit(
      `📦 ${workingSet.length} booking(s) split into 3 layers: ` +
      `${layers[0].bookings.length} day-trip/multi-day | ` +
      `${layers[1].bookings.length} standard | ` +
      `${layers[2].bookings.length} one-way`,
    );

    const allReasoning: AiReasoningEntry[] = [];
    const summaries: string[] = [];

    // ── Step 6–7: Process each layer, then each batch within the layer ─────────
    for (let li = 0; li < layers.length; li++) {
      const layer = layers[li];

      if (layer.bookings.length === 0) {
        emit(`⏭ ${layer.label} — no bookings, skipping`);
        continue;
      }

      // Chunk this layer
      const chunks: (typeof layer.bookings)[] = [];
      for (let i = 0; i < layer.bookings.length; i += CHUNK_SIZE) {
        chunks.push(layer.bookings.slice(i, i + CHUNK_SIZE));
      }

      emit(`\n🗂 ${layer.label} — ${layer.bookings.length} booking(s) → ${chunks.length} batch(es)`);

      // Layer hint injected into every userMessage for this layer
      const layerHint =
        `\n\nCURRENT LAYER: ${li + 1} of 3 — ${layer.label}.\n` +
        (li === 0
          ? "Committed slots above are from protected/manual bookings only. All other vans are fully available."
          : `Committed slots above include protected bookings AND all assignments already made in earlier layers. ` +
            `Only vans NOT in the committed list are available for this layer.`);

      for (let ci = 0; ci < chunks.length; ci++) {
        const chunk = chunks[ci];
        emit(
          `🤖 ${layer.label}, Batch ${ci + 1}/${chunks.length} — sending ${chunk.length} booking(s) to Gemini…`,
        );

      const chunkPayload = chunk.map((b) => ({
        bookingId: b.id,
        travelDate: b.travelDate,
        from: b.fromLocation,
        to: b.toLocation,
        details: b.details ?? "",
        tripType: b.tripType ?? "trip",
        vehicleCategory: b.vehicleCategory ?? "Van",
        isAlphardTrip: b.isAlphardTrip ?? 0,
        invoiceNo: b.invoiceNo ?? "",
        vehicleIndex: b.vehicleIndex ?? 1,
        numberOfVehicles: b.numberOfVehicles ?? 1,
        passengerCount: b.passengerCount ?? 0,
        manualChange: b.manualChange ?? 0,
        currentVanId: b.vanId ?? null,
        inHouseOrOutsourced: b.inHouseOrOutsourced ?? "I",
        outsourcedCompany: b.outsourcedCompany ?? "",
        // true = just uploaded, needs assignment from scratch
        // false = already has a van, only move if a higher-priority new trip needs the slot
        isNew: newIdSet ? newIdSet.has(b.id) : b.vanId === null,
      }));

      // Build committed-context section for this batch
      let committedSection = "";
      if (committedVanDates.size > 0 || committedInvoiceVans.size > 0) {
        const takenSlots = [...committedVanDates].map((k) => {
          const [vanId, date] = k.split("::");
          return { vanId: Number(vanId), date };
        });
        const invoiceBindings = [...committedInvoiceVans.entries()].map(([k, vanId]) => {
          const [invoiceNo, vi] = k.split("::");
          return { invoiceNo, vehicleIndex: Number(vi), vanId };
        });
        committedSection =
          `\n\nCOMMITTED ASSIGNMENTS — already locked, do not reuse these van+date slots:\n` +
          `Van+date taken: ${JSON.stringify(takenSlots)}\n` +
          `Invoice→van bindings: ${JSON.stringify(invoiceBindings)}`;
      }

      const userMessage =
        `CURRENT FLEET:\n${JSON.stringify(vansPayload, null, 2)}` +
        committedSection +
        layerHint +
        `\n\nBOOKINGS TO ASSIGN (${layer.label}, batch ${ci + 1}/${chunks.length}):\n${JSON.stringify(chunkPayload, null, 2)}` +
        customRulesSection;

      // ── Call OpenRouter for this chunk ───────────────────────────────────────
      let chunkResult: {
        assignments: Array<{ bookingId: number; vanId: number; reasoning: string }>;
        outsourced: Array<{ bookingId: number; reasoning: string }>;
        summary: string;
      } | null = null;

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 90_000); // 90s per chunk

        let response: Response;
        try {
          response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            signal: controller.signal,
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
              "HTTP-Referer": "https://van-scheduler.vercel.app",
            },
            body: JSON.stringify({
              model: "google/gemini-2.5-flash",
              temperature: 0,
              response_format: { type: "json_object" },
              messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: userMessage },
              ],
            }),
          });
        } catch (fetchErr: any) {
          clearTimeout(timeoutId);
          if (fetchErr?.name === "AbortError")
            throw new Error(`Batch ${ci + 1} timed out after 90 seconds`);
          throw fetchErr;
        }
        clearTimeout(timeoutId);

        if (!response.ok) {
          const errText = await response.text().catch(() => "");
          throw new Error(`OpenRouter error ${response.status}: ${errText.slice(0, 200)}`);
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content;
        if (!content) throw new Error("OpenRouter returned empty content");

        type ChunkResponse = {
          assignments: Array<{ bookingId: number; vanId: number; reasoning: string }>;
          outsourced: Array<{ bookingId: number; reasoning: string }>;
          summary: string;
        };
        let parsed: ChunkResponse;
        try {
          parsed = JSON.parse(content) as ChunkResponse;
        } catch {
          throw new Error("AI returned invalid JSON");
        }

        if (!Array.isArray(parsed?.assignments) || !Array.isArray(parsed?.outsourced)) {
          throw new Error("AI returned incomplete structure");
        }

        // Validate every chunk bookingId is accounted for
        const chunkIds = new Set(chunk.map((b) => b.id));
        const respondedIds = new Set([
          ...parsed.assignments.map((a) => a.bookingId),
          ...parsed.outsourced.map((o) => o.bookingId),
        ]);
        for (const id of chunkIds) {
          if (!respondedIds.has(id)) throw new Error(`AI omitted bookingId ${id}`);
        }

        // Check no double-booking within this chunk vs committed slots.
        // committedVanDates contains: (1) truly protected bookings
        // (manualChange=1 or confirmed outsource), (2) prior-batch assignments,
        // and (3) pre-seeded non-working-set bookings in targeted mode.
        // Rather than failing the entire batch on the first conflict, redirect
        // conflicting assignments to the outsourced list so the rescue pass
        // below can try to find a free van for them.
        const newVanDates = new Map<string, number>(); // key → bookingId
        const validAssignments: typeof parsed.assignments = [];
        for (const a of parsed.assignments) {
          const b = chunk.find((x) => x.id === a.bookingId);
          if (!b) continue;
          const key = `${a.vanId}::${b.travelDate}`;
          if (committedVanDates.has(key)) {
            // AI tried to reuse an already-committed slot — move to outsourced
            // so the rescue pass can attempt to find a free alternative van.
            emit(`⚠ #${b.id} (${b.travelDate}): AI tried to reuse van ${a.vanId} which is already committed — will try to find a free van`);
            parsed.outsourced.push({
              bookingId: b.id,
              reasoning: `Committed-slot conflict: van ${a.vanId} is already assigned on ${b.travelDate}. Rescue pass will attempt a free alternative.`,
            });
          } else {
            // Alphard exclusivity guard — catch AI mistakes before writing to DB.
            // isAlphardTrip=1 bookings must use Toyota Alphard vans; all other
            // bookings must NOT use Toyota Alphard vans.  If the AI violates this,
            // re-queue the booking as outsourced so the rescue pass can find the
            // correct van type.
            const assignedVan = vanMap.get(a.vanId);
            if (assignedVan) {
              const isVanAlphard = (assignedVan.vehicleType ?? "").toLowerCase() === "toyota alphard";
              const isAlphardBooking = (b.isAlphardTrip ?? 0) === 1;
              if (isAlphardBooking && !isVanAlphard) {
                emit(`⚠ #${b.id} (${b.travelDate}): AI assigned regular van ${assignedVan.vanNumber} to Alphard booking — re-queuing for correct assignment`);
                parsed.outsourced.push({
                  bookingId: b.id,
                  reasoning: `Alphard violation: booking requires Toyota Alphard but AI assigned regular van ${assignedVan.vanNumber}. Rescue pass will find a Toyota Alphard.`,
                });
                continue;
              }
              if (!isAlphardBooking && isVanAlphard) {
                emit(`⚠ #${b.id} (${b.travelDate}): AI assigned Alphard van ${assignedVan.vanNumber} to non-Alphard booking — re-queuing for correct assignment`);
                parsed.outsourced.push({
                  bookingId: b.id,
                  reasoning: `Alphard violation: non-Alphard booking cannot use Toyota Alphard van ${assignedVan.vanNumber}. Rescue pass will find a regular van.`,
                });
                continue;
              }
            }
            // Within the chunk, allow the last assignment for a key to win
            // (AI may have bumped an earlier one to a different van)
            newVanDates.set(key, a.bookingId);
            validAssignments.push(a);
          }
        }
        parsed = { ...parsed, assignments: validAssignments };

        chunkResult = parsed;

        // ── Rescue pass: catch AI mistakes where a free van actually exists ──────
        // The AI sometimes outsources a booking even though a capable van is free.
        // Before touching the DB, re-verify every outsourced booking.
        {
          const chunkSlots = new Set<string>(); // "vanId::date" claimed by this chunk
          for (const a of chunkResult.assignments) {
            const b = chunk.find((x) => x.id === a.bookingId);
            if (b) chunkSlots.add(`${a.vanId}::${b.travelDate}`);
          }

          const rescuedAssignments: typeof chunkResult.assignments = [];
          const trulyOutsourced: typeof chunkResult.outsourced = [];

          for (const out of chunkResult.outsourced) {
            const b = chunk.find((x) => x.id === out.bookingId)!;

            // Never rescue: Car trips, confirmed outsources, or manual-locked bookings
            if ((b.vehicleCategory ?? "Van") === "Car") { trulyOutsourced.push(out); continue; }
            if (b.inHouseOrOutsourced === "O" && (b.outsourcedCompany ?? "").trim() !== "") { trulyOutsourced.push(out); continue; }
            if (b.manualChange === 1) { trulyOutsourced.push(out); continue; }

            const locStr = `${b.fromLocation ?? ""} ${b.toLocation ?? ""} ${b.details ?? ""}`.toLowerCase();
            const needsSingapore = locStr.includes("singapore");
            const needsThailand =
              locStr.includes("thailand") || locStr.includes("hatyai") ||
              locStr.includes("hat yai") || locStr.includes("padang besar");
            const isAlphardBooking = (b.isAlphardTrip ?? 0) === 1;

            let freeVan: (typeof allVans)[number] | null = null;
            for (const van of allVans) {
              if (needsSingapore && van.singaporeEnabled !== 1) continue;
              if (needsThailand && van.thailandEnabled !== 1) continue;
              const isVanAlphard = (van.vehicleType ?? "").toLowerCase() === "toyota alphard";
              if (isAlphardBooking && !isVanAlphard) continue;
              if (!isAlphardBooking && isVanAlphard) continue;
              const key = `${van.id}::${b.travelDate}`;
              if (!committedVanDates.has(key) && !chunkSlots.has(key)) {
                freeVan = van;
                break;
              }
            }

            if (freeVan) {
              rescuedAssignments.push({
                bookingId: b.id,
                vanId: freeVan.id,
                reasoning: `Rescued by post-check: ${freeVan.vanNumber} was free on ${b.travelDate} — AI incorrectly outsourced.`,
              });
              chunkSlots.add(`${freeVan.id}::${b.travelDate}`);
              emit(`🔧 Rescued #${b.id} (${b.travelDate} ${b.fromLocation}→${b.toLocation}) → van ${freeVan.vanNumber}`);
            } else {
              trulyOutsourced.push(out);
            }
          }

          if (rescuedAssignments.length > 0) {
            emit(`🔧 Rescue pass recovered ${rescuedAssignments.length} booking(s) the AI incorrectly outsourced`);
            chunkResult = {
              assignments: [...chunkResult.assignments, ...rescuedAssignments],
              outsourced: trulyOutsourced,
              summary: chunkResult.summary,
            };
          }
        }

        emit(
          `⏳ Batch ${ci + 1} — writing ${chunkResult.assignments.length} assignment(s), ${chunkResult.outsourced.length} outsourced…`,
        );
      } catch (chunkErr: any) {
        // Per-chunk fallback: rules engine handles only this batch's IDs
        emit(
          `⚠ Batch ${ci + 1} failed (${chunkErr.message}) — rules engine handling this batch…`,
        );
        try {
          await runReassign(
            chunk.map((b) => b.id),
            (msg) => {
              log.push(msg);
              logger?.(msg);
            },
          );
        } catch (reassignErr: any) {
          // runReassign calls smartAssignVan which makes its own AI call — that can
          // also fail (e.g. empty response, network error). Don't let it abort the
          // whole scheduler session; just log and move on to the next batch.
          emit(`⚠ Rules-engine fallback also failed (${reassignErr.message}) — skipping batch ${ci + 1}`);
        }

        // Refresh committed context from DB so subsequent batches stay accurate
        const nowAssigned = await db
          .select({
            vanId: bookings.vanId,
            travelDate: bookings.travelDate,
            invoiceNo: bookings.invoiceNo,
            vehicleIndex: bookings.vehicleIndex,
          })
          .from(bookings)
          .where(isNotNull(bookings.vanId));
        for (const b of nowAssigned) {
          committedVanDates.add(`${b.vanId}::${b.travelDate}`);
          if (b.invoiceNo)
            committedInvoiceVans.set(`${b.invoiceNo}::${b.vehicleIndex ?? 1}`, b.vanId!);
        }

        continue; // next batch
      }

      // ── Write assignments to DB in parallel + update committed context ────────
      await Promise.all(
        chunkResult.assignments.map(async (assignment) => {
          const van = vanMap.get(assignment.vanId);
          if (!van) return;
          const b = chunk.find((x) => x.id === assignment.bookingId)!;

          await db
            .update(bookings)
            .set({
              vanId: assignment.vanId,
              vehiclePlate: van.vanNumber ?? "",
              driverName: van.driverName ?? "",
              driverContact: van.driverContact ?? "",
              inHouseOrOutsourced: "I",
              outsourcedCompany: "",
            })
            .where(eq(bookings.id, assignment.bookingId));

          committedVanDates.add(`${assignment.vanId}::${b.travelDate}`);
          if (b.invoiceNo)
            committedInvoiceVans.set(`${b.invoiceNo}::${b.vehicleIndex ?? 1}`, assignment.vanId);

          emit(
            `✓ Assigned ${van.vanNumber} (${van.driverName ?? "?"}) → ${b.invoiceNo ?? `#${b.id}`} on ${b.travelDate}`,
          );
          allReasoning.push({
            bookingId: assignment.bookingId,
            van: van.vanNumber,
            action: "assigned",
            reasoning: assignment.reasoning,
          });
        }),
      );

      await Promise.all(
        chunkResult.outsourced.map(async (outsourced) => {
          const b = chunk.find((x) => x.id === outsourced.bookingId)!;
          await db
            .update(bookings)
            .set({
              vanId: null,
              vehiclePlate: "",
              driverName: "",
              driverContact: "",
              inHouseOrOutsourced: "O",
              outsourcedCompany: "",
            })
            .where(eq(bookings.id, outsourced.bookingId));

          emit(
            `⚠ Outsourced #${outsourced.bookingId} (${b.travelDate} ${b.fromLocation}→${b.toLocation}): ${outsourced.reasoning}`,
          );
          allReasoning.push({
            bookingId: outsourced.bookingId,
            van: null,
            action: "outsourced",
            reasoning: outsourced.reasoning,
          });
        }),
      );

      if (chunkResult.summary) summaries.push(chunkResult.summary);
      } // end batch loop (ci)

      // ── Mid-layer rescan: fix mistakes before next layer inherits committed slots ──
      emit(`\n🔍 Post-layer rescan for ${layer.label}…`);
      await runMidLayerChecks(layer.label, (msg) => emit(msg));

      // Refresh committedVanDates + committedInvoiceVans from DB so the next layer
      // sees the corrected (post-rescan) state as its locked context.
      const nowAssigned = await db
        .select({
          vanId: bookings.vanId,
          travelDate: bookings.travelDate,
          invoiceNo: bookings.invoiceNo,
          vehicleIndex: bookings.vehicleIndex,
        })
        .from(bookings)
        .where(isNotNull(bookings.vanId));

      committedVanDates.clear();
      committedInvoiceVans.clear();
      for (const b of nowAssigned) {
        committedVanDates.add(`${b.vanId}::${b.travelDate}`);
        if (b.invoiceNo)
          committedInvoiceVans.set(`${b.invoiceNo}::${b.vehicleIndex ?? 1}`, b.vanId!);
      }
      // Re-seed protected bookings (manualChange=1 / confirmed outsource) which
      // have no vanId but must still block their slots
      for (const b of allBookings) {
        if (isProtected(b) && b.vanId) {
          committedVanDates.add(`${b.vanId}::${b.travelDate}`);
          if (b.invoiceNo)
            committedInvoiceVans.set(`${b.invoiceNo}::${b.vehicleIndex ?? 1}`, b.vanId);
        }
      }
      emit(`✅ ${layer.label} complete — committed slots refreshed from DB`);
    } // end layer loop (li)

    // ── Step 8: Constraint checks — fix any mistakes the AI made ─────────────
    // Runs enforce-invoice-consistency, eliminate-double-bookings, and marks
    // any still-unassigned bookings as outsourced. Guarantees hard rules are
    // always satisfied regardless of AI output quality.
    emit("🔒 Running constraint checks to verify AI output…");
    await runConstraintChecks((msg) => emit(msg));

    // ── Step 9: Combine summaries ──────────────────────────────────────────────
    const summary =
      summaries.length === 0
        ? "All bookings processed."
        : summaries.length === 1
          ? summaries[0]
          : summaries.map((s, i) => `Layer ${i + 1}: ${s}`).join(" ");

    return { summary, log, reasoning: allReasoning };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[AI-SCHEDULER ERROR]", err);
    emit(`⚠ AI scheduler failed (${errMsg}) — fell back to rules engine`);
    await recheckAllVans((msg) => {
      log.push(msg);
      logger?.(msg);
    });
    return {
      summary: "Van assignments completed using the rules engine (AI scheduler unavailable).",
      log,
      reasoning: [],
    };
  }
}
