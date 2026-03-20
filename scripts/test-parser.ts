import { parseRawText } from "../lib/pdf-parser";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${message}`);
    failed++;
  }
}

// ── Invoice number extraction tests ─────────────────────────────────────────

function testInvoiceExtraction() {
  console.log("\nTest: Invoice number extraction");

  // Format 1: two-line ("Invoice Number\nINV…")
  const text1 = [
    "Invoice Number",
    "INV2025120078",
    "1. KL - KLIA 15 January, 2025 1 230.00",
  ].join("\n");
  const r1 = parseRawText(text1);
  assert(
    r1.length > 0 && r1[0].invoiceNo === "INV2025120078",
    `INV2025120078 — two-line format (got: "${r1[0]?.invoiceNo}")`
  );

  // Format 2: same-line ("Invoice Number INV…")
  const text2 = [
    "Invoice Number INV2026010094",
    "1. KL - KLIA 15 January, 2026 1 230.00",
  ].join("\n");
  const r2 = parseRawText(text2);
  assert(
    r2.length > 0 && r2[0].invoiceNo === "INV2026010094",
    `INV2026010094 — same-line format (got: "${r2[0]?.invoiceNo}")`
  );

  // Format 3: fallback — standalone INV number in text
  const text3 = [
    "Some header text INV2026020004 extra info",
    "1. KL - KLIA 15 February, 2026 1 230.00",
  ].join("\n");
  const r3 = parseRawText(text3);
  assert(
    r3.length > 0 && r3[0].invoiceNo === "INV2026020004",
    `INV2026020004 — fallback format (got: "${r3[0]?.invoiceNo}")`
  );
}

// ── Location parsing sanity tests ────────────────────────────────────────────

function testLocationParsing() {
  console.log("\nTest: Location & booking parsing");

  const text = [
    "Invoice Number INV2025120078",
    "1. KL - KLIA 15 January, 2025 1 230.00",
    "2. Malacca - KL - Malacca 20 January, 2025 2 300.00",
  ].join("\n");

  const rows = parseRawText(text);

  assert(rows.length === 2, `Parsed 2 bookings (got: ${rows.length})`);
  assert(
    rows[0].fromLocation === "KL" && rows[0].toLocation === "KLIA",
    `Row 0: KL → KLIA (got: ${rows[0].fromLocation} → ${rows[0].toLocation})`
  );
  assert(rows[0].isRoundTrip === 0, `Row 0: one-way`);
  assert(rows[1].isRoundTrip === 1, `Row 1: round-trip`);
  assert(rows[0].amount === 230, `Row 0: amount 230 (got: ${rows[0].amount})`);
}

// ── Run all ──────────────────────────────────────────────────────────────────

testInvoiceExtraction();
testLocationParsing();

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
