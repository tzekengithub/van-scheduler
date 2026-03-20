import fs from "fs";
import path from "path";
import { extractTravelBookings } from "../lib/pdf-parser";

interface TestCase {
  file: string;
  invoiceNo: string;
  clientName: string;
  clientPhone: string;
  rowCount: number;
  firstAmount: number;
  lastAmount?: number;
  vehicles?: number;
  firstDetails?: string;
  lastDetails?: string;
  isRoundTrip0?: number;
}

const TEST_CASES: TestCase[] = [
  {
    file: "INV2025120078.pdf",
    invoiceNo: "INV2025120078",
    clientName: "Steven",
    clientPhone: "+60 16-565 1979",
    rowCount: 5,
    firstAmount: 230,
    lastAmount: 1000,
    firstDetails: "KLIA - KL",
    lastDetails: "Johor Bahru",
  },
  {
    file: "INV2026010094.pdf",
    invoiceNo: "INV2026010094",
    clientName: "Jessie Oh",
    clientPhone: "+60 16-533 9999",
    rowCount: 2,
    firstAmount: 280,
    vehicles: 2,
    firstDetails: "KL - KLIA",
  },
  {
    file: "INV2026020004.pdf",
    invoiceNo: "INV2026020004",
    clientName: "Arenaa Star Hotel",
    clientPhone: "+60 12-226 7224",
    rowCount: 2,
    firstAmount: 230,
    firstDetails: "KL - KLIA",
  },
  {
    file: "INV2026020007.pdf",
    invoiceNo: "INV2026020007",
    clientName: "Alvin Teo",
    clientPhone: "+65 9146 4791",
    rowCount: 1,
    firstAmount: 1050,
    firstDetails: "Malacca",
    isRoundTrip0: 1,
  },
  {
    file: "INV2026030039.pdf",
    invoiceNo: "INV2026030039",
    clientName: "DKL Tours and Travel",
    clientPhone: "+60 18-977 2720",
    rowCount: 4,
    firstAmount: 1200,
    lastAmount: 320,
    firstDetails: "KLIA - KL",
    lastDetails: "KL - KLIA",
  },
  {
    file: "INV2026030045.pdf",
    invoiceNo: "INV2026030045",
    clientName: "E Like Travel & Tours Sdn Bhd",
    clientPhone: "+60 16-923 8826",
    rowCount: 2,
    firstAmount: 850,
    firstDetails: "Kuantan",
  },
];

async function runTests() {
  let passed = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const tc of TEST_CASES) {
    const filePath = path.join(__dirname, "../test-pdfs", tc.file);

    if (!fs.existsSync(filePath)) {
      console.log(`  SKIP  ${tc.file} — not found in test-pdfs/`);
      continue;
    }

    const buffer = fs.readFileSync(filePath);

    try {
      const bookings = await extractTravelBookings(buffer);
      const b0 = bookings[0];
      const bLast = bookings[bookings.length - 1];
      const fileErrors: string[] = [];

      const check = (name: string, pass: boolean, got: unknown, want: string) => {
        if (!pass) fileErrors.push(`    ${name}: got ${JSON.stringify(got)} — want ${want}`);
      };

      check("invoiceNo",       b0?.invoiceNo === tc.invoiceNo,
        b0?.invoiceNo, tc.invoiceNo);

      check("clientName",      !!b0?.clientDetails?.includes(tc.clientName),
        b0?.clientDetails, `includes "${tc.clientName}"`);

      check("clientPhone",     !!b0?.clientDetails?.includes(tc.clientPhone),
        b0?.clientDetails, `includes "${tc.clientPhone}"`);

      check("no company phone", !b0?.clientDetails?.includes("606 1728"),
        b0?.clientDetails, `NOT include "606 1728"`);

      check("rowCount",        bookings.length === tc.rowCount,
        bookings.length, String(tc.rowCount));

      check("firstAmount",     Number(b0?.amount) === tc.firstAmount,
        b0?.amount, String(tc.firstAmount));

      if (tc.lastAmount !== undefined)
        check("lastAmount",    Number(bLast?.amount) === tc.lastAmount,
          bLast?.amount, String(tc.lastAmount));

      if (tc.vehicles !== undefined)
        check("vehicles",      b0?.numberOfVehicles === tc.vehicles,
          b0?.numberOfVehicles, String(tc.vehicles));

      if (tc.firstDetails !== undefined)
        check("firstDetails",  !!b0?.details?.includes(tc.firstDetails),
          b0?.details, `includes "${tc.firstDetails}"`);

      if (tc.lastDetails !== undefined)
        check("lastDetails",   !!bLast?.details?.includes(tc.lastDetails),
          bLast?.details, `includes "${tc.lastDetails}"`);

      if (tc.isRoundTrip0 !== undefined)
        check("isRoundTrip[0]", b0?.isRoundTrip === tc.isRoundTrip0,
          b0?.isRoundTrip, String(tc.isRoundTrip0));

      if (fileErrors.length === 0) {
        console.log(`  PASS  ${tc.file}`);
        passed++;
      } else {
        console.log(`  FAIL  ${tc.file}`);
        fileErrors.forEach((e) => { console.log(e); errors.push(`${tc.file} ${e}`); });
        failed++;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ERROR ${tc.file} — ${msg}`);
      errors.push(`${tc.file} — crashed: ${msg}`);
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("\nFailed assertions:");
    errors.forEach((e) => console.log(e));
    process.exit(1);
  }
}

runTests();
