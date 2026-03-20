// Run with: npx tsx scripts/test-parser.ts
import fs from "fs";
import path from "path";
import { parseRawText, extractTravelBookings } from "../lib/pdf-parser";

// ---- INV2025120078 — Steven, 5 bookings ----
const inv1 = `
Invoice Number    INV2025120078
Steven
+60 16-565 1979

1. KL - KLIA 5 December, 2025 1 230.00
(One-Way Ride Only)
2. KLIA - KL 6 December, 2025 1 230.00
(One-Way Ride Only)
3. KL - Malacca - KL 8 December, 2025 1 350.00
4. KL - Penang 10 December, 2025 1 280.00
5. Penang - KL 12 December, 2025 1 280.00
`;

// ---- INV2026010094 — Jessie Oh, 2 bookings, 2 vehicles each ----
const inv2 = `
Invoice Number    INV2026010094
Jessie Oh +60 16-533 9999

1. KL - KLIA 16 January, 2026 2 140.00
(One-Way Ride Only)
2. KLIA - KL 17 January, 2026 2 140.00
(One-Way Ride Only)
`;

// ---- INV2026020004 — Arenaa Star Hotel, 2 bookings ----
const inv3 = `
Invoice Number    INV2026020004
Arenaa Star Hotel
+60 12-226 7224

1. KL - KLIA 12 February, 2026 1 230.00
(One-Way Ride Only)
2. KLIA - KL / 吉隆坡 14 February, 2026 1 230.00
(One-Way Ride Only)
`;

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${msg}`);
  }
}

function runTest(name: string, text: string) {
  console.log(`\n=== ${name} ===`);
  const results = parseRawText(text);
  console.log(JSON.stringify(results, null, 2));
  return results;
}

const r1 = runTest("INV2025120078 - Steven", inv1);
assert(r1.length === 5, `INV2025120078: expected 5 rows, got ${r1.length}`);
assert(r1[0].invoiceNo === "INV2025120078", `invoiceNo = INV2025120078`);
assert(r1[0].clientDetails.includes("Steven"), `clientDetails includes Steven`);
assert(r1[0].clientDetails.includes("+60 16-565 1979"), `clientDetails includes phone`);
assert(r1[0].numberOfVehicles === 1, `row 0: numberOfVehicles = 1`);
assert(r1[0].amount === 230, `row 0: amount = 230`);

const r2 = runTest("INV2026010094 - Jessie Oh", inv2);
assert(r2.length === 2, `INV2026010094: expected 2 rows, got ${r2.length}`);
assert(r2[0].numberOfVehicles === 2, `row 0: numberOfVehicles = 2`);
assert(r2[0].myrPerVehicle === 140, `row 0: myrPerVehicle = 140`);
assert(r2[0].amount === 280, `row 0: amount = 280`);

const r3 = runTest("INV2026020004 - Arenaa Star Hotel", inv3);
assert(r3.length === 2, `INV2026020004: expected 2 rows, got ${r3.length}`);
assert(r3[0].clientDetails.includes("Arenaa Star Hotel"), `clientDetails includes Arenaa Star Hotel`);
assert(r3[1].toLocation === "KL", `row 1: toLocation = KL (Chinese stripped)`);

// --- Part 2: real PDF buffer tests ---
async function runPDFTests() {
  console.log("\n=== Part 2: Real PDF buffer test ===");

  const testPDFs = [
    "INV2025120078.pdf",
    "INV2026010094.pdf",
    "INV2026020004.pdf",
  ];

  let anyFound = false;

  for (const filename of testPDFs) {
    const filePath = path.join(__dirname, "../test-pdfs", filename);
    if (!fs.existsSync(filePath)) {
      console.warn(`SKIP — ${filename} not found in test-pdfs/`);
      continue;
    }

    anyFound = true;
    const buffer = fs.readFileSync(filePath);
    const bookings = await extractTravelBookings(buffer);

    console.log(`\n${filename}: ${bookings.length} bookings found`);
    if (bookings.length === 0) {
      console.error(`FAIL — ${filename} returned 0 bookings`);
      process.exitCode = 1;
      continue;
    }

    bookings.forEach((b, i) => {
      console.log(`  Row ${i + 1}: ${b.travelDate} | ${b.details} | MYR ${b.amount}`);
    });
    console.log(`PASS — ${filename}`);
  }

  if (!anyFound) {
    console.log("No PDFs found in test-pdfs/ — skipping Part 2.");
  }

  console.log("\n=== All tests passed ===");
}

runPDFTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
