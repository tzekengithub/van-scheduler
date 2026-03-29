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
  {
    const bySlot = new Map<string, Set<number>>();
    for (const b of finalBookings) {
      if (!b.vanId || !b.invoiceNo) continue;
      const key = `${b.invoiceNo}::${b.vehicleIndex ?? 1}`;
      if (!bySlot.has(key)) bySlot.set(key, new Set());
      bySlot.get(key)!.add(b.vanId);
    }
    const splits = [...bySlot.entries()].filter(([, vanSet]) => vanSet.size > 1);
    if (splits.length === 0) {
      pass(`Invoice consistency: same (invoiceNo, vehicleIndex) = same van`);
    } else {
      for (const [slot, vanSet] of splits) {
        const vanNames = [...vanSet].map((id) => vanById.get(id)?.vanNumber ?? id).join(", ");
        fail(`Split invoice: ${slot} assigned to multiple vans [${vanNames}]`);
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
