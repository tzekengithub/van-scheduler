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

// ── Client details extraction tests ──────────────────────────────────────────

function testClientDetails() {
  console.log("\nTest: Client details extraction");

  // INV2025120078 — Steven: phone on same line as name
  const text1 = [
    "SOME TRANSPORT SDN BHD",
    "Company Contact No : +60 12-606 1728",
    "",
    "Invoice Number",
    "INV2025120078",
    "",
    "Steven +60 16-565 1979",
    "",
    "1. KL - KLIA 15 December, 2025 1 230.00",
    "COMPANY POLICY",
  ].join("\n");
  const r1 = parseRawText(text1);
  assert(
    r1.length > 0 && r1[0].clientDetails === "Steven\n+60 16-565 1979",
    `INV2025120078 — clientDetails "Steven\\n+60 16-565 1979" (got: "${r1[0]?.clientDetails}")`
  );

  // INV2026010094 — Jessie Oh: phone on same line as name
  const text2 = [
    "SOME TRANSPORT SDN BHD",
    "Company Contact No : +60 12-606 1728",
    "",
    "Invoice Number INV2026010094",
    "",
    "Jessie Oh +60 16-533 9999",
    "",
    "1. KL - KLIA 15 January, 2026 1 230.00",
    "COMPANY POLICY",
  ].join("\n");
  const r2 = parseRawText(text2);
  assert(
    r2.length > 0 && r2[0].clientDetails === "Jessie Oh\n+60 16-533 9999",
    `INV2026010094 — clientDetails "Jessie Oh\\n+60 16-533 9999" (got: "${r2[0]?.clientDetails}")`
  );

  // INV2026020004 — Arenaa Star Hotel: name on line above, phone on next line
  const text3 = [
    "SOME TRANSPORT SDN BHD",
    "Company Contact No : +60 12-606 1728",
    "",
    "Invoice Number INV2026020004",
    "",
    "Arenaa Star Hotel",
    "+60 12-226 7224",
    "",
    "1. KL - KLIA 15 February, 2026 1 230.00",
    "COMPANY POLICY",
  ].join("\n");
  const r3 = parseRawText(text3);
  assert(
    r3.length > 0 && r3[0].clientDetails === "Arenaa Star Hotel\n+60 12-226 7224",
    `INV2026020004 — clientDetails "Arenaa Star Hotel\\n+60 12-226 7224" (got: "${r3[0]?.clientDetails}")`
  );

  // BOOK prefix: PDF line "BOOK2026020004 Arenaa Star Hotel" must be stripped
  const text4b = [
    "SOME TRANSPORT SDN BHD",
    "Company Contact No : +60 12-606 1728",
    "",
    "Invoice Number INV2026020004",
    "",
    "BOOK2026020004 Arenaa Star Hotel",
    "+60 12-226 7224",
    "",
    "1. KL - KLIA 15 February, 2026 1 230.00",
    "COMPANY POLICY",
  ].join("\n");
  const r4b = parseRawText(text4b);
  assert(
    r4b.length > 0 && r4b[0].clientDetails === "Arenaa Star Hotel\n+60 12-226 7224",
    `BOOK prefix stripped — clientDetails "Arenaa Star Hotel\\n+60 12-226 7224" (got: "${r4b[0]?.clientDetails}")`
  );

  // Guard: company contact line must NOT leak into clientDetails
  const text4 = [
    "Company Contact No : +60 12-606 1728",
    "Invoice Number INV2026020004",
    "Arenaa Star Hotel +60 12-226 7224",
    "1. KL - KLIA 15 February, 2026 1 230.00",
    "COMPANY POLICY",
  ].join("\n");
  const r4 = parseRawText(text4);
  assert(
    r4.length > 0 && !r4[0].clientDetails.includes("Company Contact"),
    `Company Contact No must not leak into clientDetails (got: "${r4[0]?.clientDetails}")`
  );
}

// ── Run all ──────────────────────────────────────────────────────────────────

testInvoiceExtraction();
testLocationParsing();
testClientDetails();

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
