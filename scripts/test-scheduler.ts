/**
 * test-scheduler.ts
 *
 * Comprehensive end-to-end scheduler test.
 * Parses ALL test PDFs → inserts into DB → runs recheckAllVans → validates invariants.
 *
 * Usage:
 *   npx tsx --tsconfig tsconfig.json scripts/test-scheduler.ts
 *
 * Validates:
 *   1. No double-booking   — 1 van ≤ 1 job per day
 *   2. Invoice consistency — same (invoiceNo, vehicleIndex) = same van across all dates
 *   3. SG capability       — Singapore routes only assigned to singaporeEnabled vans
 *   4. TH capability       — Thailand routes only assigned to thailandEnabled vans
 *   5. Outsource flag      — unassigned bookings must be marked inHouseOrOutsourced='O'
 *   6. No ghost vans       — vanId always points to a real van
 */

import fs from "fs";
import path from "path";
import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import { eq, and, isNull, isNotNull } from "drizzle-orm";
import * as schema from "../drizzle/schema";
import { parseRawText } from "../lib/pdf-parser";
import { recheckAllVans } from "../lib/recheck";

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle(sql, { schema });

const PDF_SERVICE = process.env.PDF_SERVICE_URL ?? process.env.NEXT_PUBLIC_PDF_SERVICE_URL ?? "";
const TEST_PDFS_DIR = path.join(__dirname, "../test-pdfs");
const CONCURRENCY = 8; // parallel PDF parse calls

// ─── Helpers ──────────────────────────────────────────────────────────────────

function needsSg(from: string, to: string) {
  return `${from} ${to}`.toLowerCase().includes("singapore");
}
function needsTh(from: string, to: string) {
  return `${from} ${to}`.toLowerCase().includes("thailand");
}

async function parsePDF(filePath: string, attempt = 1): Promise<schema.NewBooking[]> {
  const buffer = fs.readFileSync(filePath);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(`${PDF_SERVICE}/parse`, {
      method: "POST",
      headers: { "Content-Type": "application/pdf" },
      body: new Uint8Array(buffer),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`PDF service ${res.status} for ${path.basename(filePath)}`);
    const { text } = await res.json() as { text: string };
    if (!text || text.trim().length < 10) throw new Error(`Empty text for ${path.basename(filePath)}`);
    return parseRawText(text) as unknown as schema.NewBooking[];
  } catch (err) {
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      return parsePDF(filePath, attempt + 1);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function runInBatches<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<{ results: R[]; errors: Array<{ item: T; error: string }> }> {
  const results: R[] = [];
  const errors: Array<{ item: T; error: string }> = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const settled = await Promise.allSettled(batch.map(fn));
    for (let j = 0; j < settled.length; j++) {
      const s = settled[j];
      if (s.status === "fulfilled") results.push(s.value);
      else errors.push({ item: batch[j], error: s.reason?.message ?? String(s.reason) });
    }
  }
  return { results, errors };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  VAN SCHEDULER — END-TO-END TEST");
  console.log("═══════════════════════════════════════════════════\n");

  if (!PDF_SERVICE) {
    console.error("ERROR: PDF_SERVICE_URL (or NEXT_PUBLIC_PDF_SERVICE_URL) not set");
    process.exit(1);
  }

  // ── 1. Collect PDF paths ───────────────────────────────────────────────────
  const allPdfs: string[] = [];
  function scanDir(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) scanDir(full);
      else if (entry.name.endsWith(".pdf")) allPdfs.push(full);
    }
  }
  scanDir(TEST_PDFS_DIR);
  allPdfs.sort();
  console.log(`Found ${allPdfs.length} PDF file(s) in test-pdfs/\n`);

  // ── 2. Parse all PDFs ─────────────────────────────────────────────────────
  console.log(`Parsing PDFs (${CONCURRENCY} concurrent)…`);
  let doneCount = 0;
  const { results: parsedGroups, errors: parseErrors } = await runInBatches(
    allPdfs,
    CONCURRENCY,
    async (p) => {
      const r = await parsePDF(p);
      doneCount++;
      if (doneCount % 20 === 0 || doneCount === allPdfs.length)
        process.stdout.write(`  ${doneCount}/${allPdfs.length} done\n`);
      return r;
    },
  );

  const allBookings = parsedGroups.flat();
  console.log(`  Parsed: ${allBookings.length} booking row(s) from ${parsedGroups.length} PDF(s)`);
  if (parseErrors.length > 0) {
    console.log(`  Parse errors: ${parseErrors.length}`);
    for (const e of parseErrors) {
      console.log(`    PARSE ERROR: ${path.basename(e.item as string)} — ${e.error}`);
    }
  }

  if (allBookings.length === 0) {
    console.error("\nNo bookings parsed — aborting.");
    process.exit(1);
  }

  // ── 3. Wipe bookings and re-insert ────────────────────────────────────────
  console.log("\nClearing bookings table…");
  await db.delete(schema.bookings);
  console.log("  Cleared.");

  console.log("Inserting parsed bookings…");
  const CHUNK = 50;
  for (let i = 0; i < allBookings.length; i += CHUNK) {
    await db.insert(schema.bookings).values(allBookings.slice(i, i + CHUNK));
  }
  console.log(`  Inserted ${allBookings.length} row(s).`);

  // ── 4. Run recheckAllVans ─────────────────────────────────────────────────
  console.log("\nRunning recheckAllVans…");
  const recheckLogs: string[] = [];
  await recheckAllVans((msg) => recheckLogs.push(msg));

  // Print condensed recheck log
  for (const line of recheckLogs) {
    const prefix =
      line.startsWith("━━━") || line.startsWith("Step") ? "  " :
      line.includes("CONFLICT") || line.includes("outsourced") ? "  ⚠ " :
      line.includes("BUMP") ? "  ↕ " :
      line.includes("OK") || line.includes("✓") ? "  ✓ " :
      "  ";
    console.log(prefix + line);
  }

  // ── 5. Validate ───────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════");
  console.log("  VALIDATION");
  console.log("═══════════════════════════════════════════════════\n");

  const allVans = await db.select().from(schema.vans);
  const vanById = new Map(allVans.map((v) => [v.id, v]));

  const finalBookings = await db.select().from(schema.bookings);

  let failures = 0;
  function fail(msg: string) {
    console.log(`  FAIL  ${msg}`);
    failures++;
  }
  function pass(msg: string) {
    console.log(`  PASS  ${msg}`);
  }

  // ── Rule 1: No double-booking ────────────────────────────────────────────
  {
    const byVanDate = new Map<string, number[]>();
    for (const b of finalBookings) {
      if (!b.vanId) continue;
      const key = `${b.vanId}::${b.travelDate}`;
      if (!byVanDate.has(key)) byVanDate.set(key, []);
      byVanDate.get(key)!.push(b.id);
    }
    const violations = [...byVanDate.entries()].filter(([, ids]) => ids.length > 1);
    if (violations.length === 0) {
      pass(`No double-bookings (1 van = max 1 job/day)`);
    } else {
      for (const [key, ids] of violations) {
        const [vanId, date] = key.split("::");
        const van = vanById.get(Number(vanId));
        fail(`Double-booking: van ${van?.vanNumber ?? vanId} on ${date} has ${ids.length} jobs (ids: ${ids.join(",")})`);
      }
    }
  }

  // ── Rule 2: Invoice consistency ──────────────────────────────────────────
  // Groups by (invoiceNo, vehicleIndex, isAlphardTrip) — Alphard and non-Alphard
  // legs of the same invoice slot use different van types by design (not a split).
  // Same-day duplicates (same invoice+vi+date) legitimately need separate vans
  // and are excluded from this check.
  {
    type SlotRow = { vanId: number; travelDate: string };
    const bySlot = new Map<string, SlotRow[]>();
    for (const b of finalBookings) {
      if (!b.vanId || !b.invoiceNo) continue;
      const key = `${b.invoiceNo}::${b.vehicleIndex ?? 1}::${b.isAlphardTrip ?? 0}`;
      if (!bySlot.has(key)) bySlot.set(key, []);
      bySlot.get(key)!.push({ vanId: b.vanId, travelDate: b.travelDate });
    }
    const splits: string[] = [];
    for (const [slotKey, rows] of bySlot) {
      const dateCounts = new Map<string, number>();
      for (const { travelDate } of rows) {
        dateCounts.set(travelDate, (dateCounts.get(travelDate) ?? 0) + 1);
      }
      // Only unique-date bookings must share a van — same-day duplicates need separate vans
      const uniqueVans = new Set(
        rows.filter(({ travelDate }) => dateCounts.get(travelDate) === 1).map(({ vanId }) => vanId)
      );
      if (uniqueVans.size > 1) {
        const vanNames = [...uniqueVans].map((id) => vanById.get(id)?.vanNumber ?? id).join(", ");
        splits.push(`${slotKey} → vans [${vanNames}]`);
      }
    }
    if (splits.length === 0) {
      pass(`Invoice consistency: same (invoiceNo, vehicleIndex, vanType) = same van across dates`);
    } else {
      for (const s of splits) {
        fail(`Split invoice: ${s}`);
      }
    }
  }

  // ── Rule 3: Singapore capability ────────────────────────────────────────
  {
    const sgBookings = finalBookings.filter((b) =>
      b.vanId && needsSg(b.fromLocation ?? "", b.toLocation ?? "")
    );
    const sgViolations = sgBookings.filter((b) => {
      const van = vanById.get(b.vanId!);
      return !van || van.singaporeEnabled !== 1;
    });
    if (sgViolations.length === 0) {
      pass(`Singapore capability: all ${sgBookings.length} SG booking(s) on SG-enabled vans`);
    } else {
      for (const b of sgViolations) {
        const van = vanById.get(b.vanId!);
        fail(`SG trip id=${b.id} ${b.invoiceNo} assigned to non-SG van ${van?.vanNumber ?? b.vanId}`);
      }
    }
  }

  // ── Rule 4: Thailand capability ──────────────────────────────────────────
  {
    const thBookings = finalBookings.filter((b) =>
      b.vanId && needsTh(b.fromLocation ?? "", b.toLocation ?? "")
    );
    const thViolations = thBookings.filter((b) => {
      const van = vanById.get(b.vanId!);
      return !van || van.thailandEnabled !== 1;
    });
    if (thViolations.length === 0) {
      pass(`Thailand capability: all ${thBookings.length} TH booking(s) on TH-enabled vans`);
    } else {
      for (const b of thViolations) {
        const van = vanById.get(b.vanId!);
        fail(`TH trip id=${b.id} ${b.invoiceNo} assigned to non-TH van ${van?.vanNumber ?? b.vanId}`);
      }
    }
  }

  // ── Rule 5: No ghost vanIds ──────────────────────────────────────────────
  {
    const ghostBookings = finalBookings.filter((b) => b.vanId && !vanById.has(b.vanId));
    if (ghostBookings.length === 0) {
      pass(`No ghost vanIds (all vanIds point to real vans)`);
    } else {
      for (const b of ghostBookings) {
        fail(`Ghost vanId: booking id=${b.id} has vanId=${b.vanId} which does not exist`);
      }
    }
  }

  // ── Rule 6: Unassigned = outsourced ─────────────────────────────────────
  {
    const unassignedInHouse = finalBookings.filter(
      (b) => !b.vanId && b.inHouseOrOutsourced === "I" && b.manualChange === 0
    );
    if (unassignedInHouse.length === 0) {
      pass(`Outsource flag: all unassigned bookings correctly flagged as 'O'`);
    } else {
      for (const b of unassignedInHouse) {
        fail(`Unassigned but still in-house: id=${b.id} ${b.invoiceNo} ${b.travelDate}`);
      }
    }
  }

  // ── Scenario Tests ────────────────────────────────────────────────────────
  console.log("\n─── Scenario Tests ──────────────────────────────────");
  {
    const allVansForTest = await db.select().from(schema.vans).orderBy(schema.vans.id);
    const regularVans = allVansForTest.filter(
      (v) => (v.vehicleType ?? "").toLowerCase() !== "toyota alphard"
    );

    const clean = async (invoiceNo: string) =>
      db.delete(schema.bookings).where(eq(schema.bookings.invoiceNo, invoiceNo));

    if (regularVans.length === 0) {
      console.log("  SKIP  All scenario tests — no regular vans in DB");
    } else {
      const v1 = regularVans[0];

      // S1: manualChange=1 is never touched by recheck
      {
        const INV = "TEST-S1-MANUAL";
        await clean(INV);
        const [ins] = await db.insert(schema.bookings).values({
          travelDate: "2099-12-31", fromLocation: "KL", toLocation: "Penang",
          vanId: v1.id, vehiclePlate: v1.vanNumber, driverName: v1.driverName ?? "",
          manualChange: 1, inHouseOrOutsourced: "I", tripType: "trip",
          invoiceNo: INV, vehicleCategory: "Van",
        }).returning({ id: schema.bookings.id });
        await recheckAllVans();
        const [after] = await db.select({ vanId: schema.bookings.vanId }).from(schema.bookings).where(eq(schema.bookings.id, ins.id));
        if (after?.vanId === v1.id) pass("S1: manualChange=1 — van preserved after recheck");
        else fail(`S1: manualChange=1 — van changed from ${v1.id} to ${after?.vanId}`);
        await clean(INV);
      }

      // S2: Car trips always outsourced, never get a fleet van
      {
        const INV = "TEST-S2-CAR";
        await clean(INV);
        const [ins] = await db.insert(schema.bookings).values({
          travelDate: "2099-12-31", fromLocation: "KL", toLocation: "Penang",
          manualChange: 0, inHouseOrOutsourced: "I", tripType: "trip",
          invoiceNo: INV, vehicleCategory: "Car",
        }).returning({ id: schema.bookings.id });
        await recheckAllVans();
        const [after] = await db.select({ vanId: schema.bookings.vanId, flag: schema.bookings.inHouseOrOutsourced }).from(schema.bookings).where(eq(schema.bookings.id, ins.id));
        if (after?.vanId === null && after?.flag === "O") pass("S2: Car trip correctly outsourced");
        else fail(`S2: Car trip has vanId=${after?.vanId} flag=${after?.flag} (expected null + "O")`);
        await clean(INV);
      }

      // S3: Confirmed outsource (outsourcedCompany set) never reassigned
      {
        const INV = "TEST-S3-OUTSOURCE";
        await clean(INV);
        const [ins] = await db.insert(schema.bookings).values({
          travelDate: "2099-12-31", fromLocation: "KL", toLocation: "Penang",
          manualChange: 0, inHouseOrOutsourced: "O", outsourcedCompany: "ABC Tours",
          tripType: "trip", invoiceNo: INV, vehicleCategory: "Van",
        }).returning({ id: schema.bookings.id });
        await recheckAllVans();
        const [after] = await db.select({ vanId: schema.bookings.vanId, co: schema.bookings.outsourcedCompany }).from(schema.bookings).where(eq(schema.bookings.id, ins.id));
        if (after?.vanId === null && after?.co === "ABC Tours") pass("S3: Confirmed outsource untouched");
        else fail(`S3: Confirmed outsource was changed (vanId=${after?.vanId}, company=${after?.co})`);
        await clean(INV);
      }

      // S4: Priority bump — trip displaces one_way_ride when all vans occupied
      {
        const INV_OWR = "TEST-S4-OWR";
        const INV_TRIP = "TEST-S4-TRIP";
        await clean(INV_OWR); await clean(INV_TRIP);
        // Occupy ALL regular vans with one_way_rides
        await db.insert(schema.bookings).values(
          regularVans.map((v) => ({
            travelDate: "2099-12-31", fromLocation: "KL", toLocation: "Penang",
            manualChange: 0, inHouseOrOutsourced: "I", tripType: "one_way_ride",
            invoiceNo: INV_OWR, vehicleCategory: "Van",
            vanId: v.id, vehiclePlate: v.vanNumber, driverName: v.driverName ?? "",
          }))
        );
        const [tripIns] = await db.insert(schema.bookings).values({
          travelDate: "2099-12-31", fromLocation: "KL", toLocation: "Penang",
          manualChange: 0, inHouseOrOutsourced: "I", tripType: "trip",
          invoiceNo: INV_TRIP, vehicleCategory: "Van",
        }).returning({ id: schema.bookings.id });
        await recheckAllVans();
        const [tripAfter] = await db.select({ vanId: schema.bookings.vanId }).from(schema.bookings).where(eq(schema.bookings.id, tripIns.id));
        if (tripAfter?.vanId != null) pass("S4: Priority bump — trip displaced one_way_ride and got a van");
        else fail("S4: Priority bump failed — trip still has no van");
        // Verify no double-bookings on test date
        const dayBookings = await db.select({ vanId: schema.bookings.vanId }).from(schema.bookings).where(and(eq(schema.bookings.travelDate, "2099-12-31"), isNotNull(schema.bookings.vanId)));
        const slotCount = new Map<number, number>();
        for (const b of dayBookings) slotCount.set(b.vanId!, (slotCount.get(b.vanId!) ?? 0) + 1);
        if ([...slotCount.values()].every((n) => n <= 1)) pass("S4: No double-bookings after priority bump");
        else fail("S4: Double-booking detected after priority bump");
        await clean(INV_OWR); await clean(INV_TRIP);
      }

      // S5: Rescue — auto-outsourced booking (no company) gets a van when one is free
      {
        const INV = "TEST-S5-RESCUE";
        await clean(INV);
        const [ins] = await db.insert(schema.bookings).values({
          travelDate: "2099-12-31", fromLocation: "KL", toLocation: "Penang",
          manualChange: 0, inHouseOrOutsourced: "O", outsourcedCompany: "",
          tripType: "trip", invoiceNo: INV, vehicleCategory: "Van",
        }).returning({ id: schema.bookings.id });
        await recheckAllVans();
        const [after] = await db.select({ vanId: schema.bookings.vanId, flag: schema.bookings.inHouseOrOutsourced }).from(schema.bookings).where(eq(schema.bookings.id, ins.id));
        if (after?.vanId != null && after?.flag === "I") pass(`S5: Rescue — incorrectly-outsourced booking got van ${after.vanId}`);
        else fail(`S5: Rescue failed — still outsourced (vanId=${after?.vanId}, flag=${after?.flag})`);
        await clean(INV);
      }

      // S6: Multi-day invoice uses the same van across all 3 legs
      {
        const INV = "TEST-S6-MULTIDAY";
        await clean(INV);
        await db.insert(schema.bookings).values([
          { travelDate: "2099-12-29", fromLocation: "KL", toLocation: "Penang", manualChange: 0, inHouseOrOutsourced: "I", tripType: "trip", invoiceNo: INV, vehicleIndex: 1, vehicleCategory: "Van" },
          { travelDate: "2099-12-30", fromLocation: "Penang", toLocation: "KL", manualChange: 0, inHouseOrOutsourced: "I", tripType: "trip", invoiceNo: INV, vehicleIndex: 1, vehicleCategory: "Van" },
          { travelDate: "2099-12-31", fromLocation: "KL", toLocation: "JB", manualChange: 0, inHouseOrOutsourced: "I", tripType: "trip", invoiceNo: INV, vehicleIndex: 1, vehicleCategory: "Van" },
        ]);
        await recheckAllVans();
        const legs = await db.select({ vanId: schema.bookings.vanId }).from(schema.bookings).where(and(eq(schema.bookings.invoiceNo, INV), isNotNull(schema.bookings.vanId)));
        const vanSet = new Set(legs.map((l) => l.vanId));
        if (vanSet.size === 1) pass("S6: Multi-day invoice — all 3 legs on same van");
        else if (vanSet.size === 0) fail("S6: Multi-day invoice — no legs assigned");
        else fail(`S6: Multi-day invoice — legs split across ${vanSet.size} vans`);
        await clean(INV);
      }
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const assigned = finalBookings.filter((b) => b.vanId).length;
  const outsourced = finalBookings.filter((b) => !b.vanId).length;
  const manualOutsource = finalBookings.filter(
    (b) => !b.vanId && b.inHouseOrOutsourced === "O" && (b.outsourcedCompany ?? "").trim() !== ""
  ).length;

  console.log(`\n─── Schedule Summary ───────────────────────────────`);
  console.log(`  Total bookings : ${finalBookings.length}`);
  console.log(`  Assigned       : ${assigned}`);
  console.log(`  Outsourced     : ${outsourced} (${manualOutsource} user-confirmed)`);
  console.log(`  Parse errors   : ${parseErrors.length}`);

  // Van utilisation
  const vanUsage = new Map<number, number>();
  for (const b of finalBookings) {
    if (b.vanId) vanUsage.set(b.vanId, (vanUsage.get(b.vanId) ?? 0) + 1);
  }
  console.log(`\n─── Van Utilisation ─────────────────────────────────`);
  for (const van of allVans.sort((a, b) => a.id - b.id)) {
    const count = vanUsage.get(van.id) ?? 0;
    const caps = [
      van.singaporeEnabled ? "🇸🇬SG" : "",
      van.thailandEnabled ? "🇹🇭TH" : "",
    ].filter(Boolean).join(" ") || "MY only";
    console.log(`  ${van.vanNumber.padEnd(12)} ${van.driverName?.padEnd(28)} ${caps.padEnd(14)} ${count} job(s)`);
  }

  console.log(`\n═══════════════════════════════════════════════════`);
  if (failures === 0) {
    console.log("  ✅  ALL CHECKS PASSED — schedule is PERFECT");
  } else {
    console.log(`  ❌  ${failures} CHECK(S) FAILED — schedule has issues`);
    process.exit(1);
  }
  console.log("═══════════════════════════════════════════════════\n");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
