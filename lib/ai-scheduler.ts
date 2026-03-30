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
import { eq, isNotNull } from "drizzle-orm";
import { recheckAllVans } from "@/lib/recheck";
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

/** Max bookings per AI request — keeps token usage low and avoids timeouts. */
const CHUNK_SIZE = 25;

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

5. Workload distribution — spread jobs evenly across vans where possible.

6. Assignment stability — if a booking already has currentVanId set and
   keeping it violates none of the above, prefer keeping it. Only move an
   existing assignment when required by a higher-priority rule.

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

export async function aiRecheckAllVans(
  logger?: (msg: string) => void,
): Promise<AiRecheckResult> {
  const log: string[] = [];
  const emit = (msg: string) => {
    log.push(msg);
    logger?.(msg);
  };

  try {
    // ── Step 1: Fetch all data ──────────────────────────────────────────────────
    const allVans = await db.select().from(vans);
    const allBookings = await db.select().from(bookings);

    const isProtected = (b: (typeof allBookings)[0]) =>
      b.manualChange === 1 ||
      (b.inHouseOrOutsourced === "O" && (b.outsourcedCompany ?? "").trim() !== "");

    const unprotected = allBookings.filter((b) => !isProtected(b));

    if (unprotected.length === 0) {
      return { summary: "No bookings to assign.", log, reasoning: [] };
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

    // ── Step 3: Sort bookings — priority tier first, then date + invoice ───────
    // Tier 1 (multi-day / day_trip) → Tier 2 (trip/round_trip/tpri) → Tier 3 (one_way_ride)
    // Within the same tier sort by date then invoice so higher-priority trips
    // claim vans before lower-priority ones in each batch.
    const tripTier = (b: (typeof unprotected)[0]): number => {
      const t = (b.tripType ?? "trip").toLowerCase();
      if (t === "day_trip") return 0;
      if (t === "one_way_ride") return 2;
      return 1; // trip, round_trip, tpri, etc.
    };

    const sorted = [...unprotected].sort(
      (a, b) =>
        tripTier(a) - tripTier(b) ||
        a.travelDate.localeCompare(b.travelDate) ||
        (a.invoiceNo ?? "").localeCompare(b.invoiceNo ?? "") ||
        (a.vehicleIndex ?? 1) - (b.vehicleIndex ?? 1),
    );

    // ── Step 4: Chunk into batches ─────────────────────────────────────────────
    const chunks: (typeof sorted)[] = [];
    for (let i = 0; i < sorted.length; i += CHUNK_SIZE) {
      chunks.push(sorted.slice(i, i + CHUNK_SIZE));
    }

    emit(
      `📦 ${unprotected.length} booking(s) → ${chunks.length} batch(es) of up to ${CHUNK_SIZE}`,
    );

    // ── Step 5: Committed context — tracks what's locked across batches ────────
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

    const allReasoning: AiReasoningEntry[] = [];
    const summaries: string[] = [];

    // ── Step 6: Process each batch ─────────────────────────────────────────────
    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci];
      emit(
        `🤖 Batch ${ci + 1}/${chunks.length} — sending ${chunk.length} booking(s) to Gemini 2.5 Pro…`,
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
        `\n\nBOOKINGS TO ASSIGN (batch ${ci + 1}/${chunks.length}):\n${JSON.stringify(chunkPayload, null, 2)}` +
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
              model: "google/gemini-2.5-pro-preview",
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

        // Check no double-booking within this chunk vs committed (protected) slots.
        // We only error on conflicts with PROTECTED (manualChange=1 or confirmed
        // outsource) bookings — the AI is allowed to reassign unprotected bookings
        // to different vans (bumping), so intra-chunk conflicts between unprotected
        // bookings are resolved by the AI's own bump logic.
        const newVanDates = new Map<string, number>(); // key → bookingId
        const unprotectedIds = new Set(chunk.map((b) => b.id));
        for (const a of parsed.assignments) {
          const b = chunk.find((x) => x.id === a.bookingId);
          if (!b) continue;
          const key = `${a.vanId}::${b.travelDate}`;
          // Only throw if the conflict is with a PROTECTED committed slot
          if (committedVanDates.has(key)) {
            throw new Error(
              `Double-booking with protected slot: van ${a.vanId} on ${b.travelDate}`,
            );
          }
          // Within the chunk, allow the last assignment for a key to win
          // (AI may have bumped an earlier one to a different van)
          newVanDates.set(key, a.bookingId);
        }

        chunkResult = parsed;
        emit(
          `⏳ Batch ${ci + 1} — writing ${parsed.assignments.length} assignment(s)…`,
        );
      } catch (chunkErr: any) {
        // Per-chunk fallback: rules engine handles only this batch's IDs
        emit(
          `⚠ Batch ${ci + 1} failed (${chunkErr.message}) — rules engine handling this batch…`,
        );
        await runReassign(
          chunk.map((b) => b.id),
          (msg) => {
            log.push(msg);
            logger?.(msg);
          },
        );

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

      // ── Write assignments to DB + update committed context ───────────────────
      for (const assignment of chunkResult.assignments) {
        const van = vanMap.get(assignment.vanId);
        if (!van) continue;
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
      }

      for (const outsourced of chunkResult.outsourced) {
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
      }

      if (chunkResult.summary) summaries.push(chunkResult.summary);
    }

    // ── Step 7: Combine summaries ──────────────────────────────────────────────
    const summary =
      summaries.length === 0
        ? "All bookings processed."
        : summaries.length === 1
          ? summaries[0]
          : summaries.map((s, i) => `Batch ${i + 1}: ${s}`).join(" ");

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
