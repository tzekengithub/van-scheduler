export type TripType = "one_way_ride" | "round_trip" | "day_trip" | "trip";

export interface ParsedBooking {
  // existing fields (for van-assignment compatibility)
  travelDate: string;      // YYYY-MM-DD
  fromLocation: string;
  toLocation: string;
  isRoundTrip: 0 | 1;
  details: string;         // cleaned booking description
  // invoice fields
  invoiceNo: string;
  clientDetails: string;
  day: string;
  month: string;
  year: string;
  numberOfVehicles: number;
  vehicleIndex: number;
  myrPerVehicle: number;
  amount: number;
  vehiclePlate: string;
  driverName: string;
  paidStatus: string;
  inHouseOrOutsourced: string;
  outsourcedCompany: string;
  overtime: string;
  introducer: string;
  // new fields — Section 1
  tripType: TripType;
  isAlphardTrip: 0 | 1;
}

/**
 * Ports Flask's parse_locations().
 * "KL - KLIA"            → one-way (from=KL, to=KLIA)
 * "KL - Malacca - KL"   → round trip (from=KL, to=Malacca)
 */
export function parseLocations(details: string): {
  fromLocation: string;
  toLocation: string;
  isRoundTrip: 0 | 1;
} {
  const parts = details.split("-").map((p) => p.trim()).filter(Boolean);

  if (parts.length === 0) {
    return { fromLocation: details.trim(), toLocation: "", isRoundTrip: 0 };
  }

  if (parts.length === 1) {
    // Single segment — no destination (e.g. "KL Day Trip", "Overtime")
    return { fromLocation: parts[0], toLocation: "", isRoundTrip: 0 };
  }

  if (parts.length === 2) {
    return { fromLocation: parts[0], toLocation: parts[1], isRoundTrip: 0 };
  }

  if (
    parts.length === 3 &&
    parts[0].toLowerCase() === parts[2].toLowerCase()
  ) {
    return { fromLocation: parts[0], toLocation: parts[1], isRoundTrip: 1 };
  }

  // Fallback: first → last
  return {
    fromLocation: parts[0],
    toLocation: parts[parts.length - 1],
    isRoundTrip: 0,
  };
}

const MONTHS: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04",
  may: "05", june: "06", july: "07", august: "08",
  september: "09", october: "10", november: "11", december: "12",
};

/** Converts "15 March, 2024" → "2024-03-15". Returns null if no match. */
function parseDateString(raw: string): string | null {
  const match = raw.match(/\b(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})\b/);
  if (!match) return null;
  const day = match[1].padStart(2, "0");
  const month = MONTHS[match[2].toLowerCase()];
  const year = match[3];
  if (!month) return null;
  return `${year}-${month}-${day}`;
}

/** Extract day/month/year text parts from a string containing a date. */
function extractDateParts(raw: string): { day: string; month: string; year: string } | null {
  const match = raw.match(/\b(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})\b/);
  if (!match) return null;
  return { day: match[1], month: match[2], year: match[3] };
}

/** Strip slash-and-beyond, then strip non-ASCII (Chinese/CJK) characters. */
function cleanBookingDetails(raw: string): string {
  const slashIdx = raw.indexOf("/");
  const clipped = slashIdx >= 0 ? raw.slice(0, slashIdx) : raw;
  return clipped.replace(/[^\x00-\x7F]/g, "").trim();
}

/**
 * Returns true if the booking details or annotation line contain "Alphard",
 * indicating the trip requires a Toyota Alphard vehicle.
 */
function detectAlphardTrip(bookingDetails: string, annotationLine: string): boolean {
  return (
    bookingDetails.toLowerCase().includes("alphard") ||
    annotationLine.toLowerCase().includes("alphard")
  );
}

/**
 * Determine tripType from booking details and annotation.
 * "one_way" if details/annotation contain "one-way" or "one way" (case-insensitive).
 * Everything else → "trip".
 */
function detectTripType(
  bookingDetails: string,
  annotationLine: string,
  _isRoundTripByRoute: boolean
): TripType {
  const lower = bookingDetails.toLowerCase();
  const annotLower = annotationLine.toLowerCase();
  if (
    lower.includes("one-way") || lower.includes("one way") ||
    annotLower.includes("one-way") || annotLower.includes("one way")
  ) {
    return "one_way_ride";
  }
  return "trip";
}

/**
 * Parse raw text extracted from an invoice PDF.
 * Designed for PyMuPDF block output where each table cell is its own line.
 * Pure function — no PDF dependency, fully testable.
 */
export function parseRawText(text: string): ParsedBooking[] {
  // Drop blank lines — PyMuPDF gives one block per non-empty cell
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const results: ParsedBooking[] = [];

  // ── Invoice Number ──────────────────────────────────────────────────────────
  let invoiceNo = "";
  for (const line of lines) {
    if (/^INV\d+$/.test(line)) { invoiceNo = line; break; }
  }
  if (!invoiceNo) {
    const m =
      text.match(/Invoice\s*Number\s*\n?\s*(INV\d+)/i) ??
      text.match(/(INV\d{10,})/i);
    invoiceNo = m?.[1] ?? "";
  }

  // ── Client Details ──────────────────────────────────────────────────────────
  const COMPANY_PHONE = "+60 12-606 1728";
  let bookIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^BOOK\d+/.test(lines[i])) { bookIdx = i; break; }
  }

  let clientDetails = "";
  if (bookIdx >= 0) {
    const bookLine = lines[bookIdx];
    const bookLineWithName = bookLine.match(/^BOOK\d+\s+(.+)/i);

    if (bookLineWithName) {
      // BOOK number and company name on same line: "BOOK2026030045 E Like Travel..."
      const clientName = bookLineWithName[1].trim();
      const extraLines: string[] = [];
      let clientPhone = "";

      for (let i = bookIdx + 1; i < Math.min(lines.length, bookIdx + 6); i++) {
        const line = lines[i];
        if (/^\d+\./.test(line)) break;
        if (/COMPANY POLICY|No Booking Details|Booking Details/i.test(line)) break;
        if (line === COMPANY_PHONE) continue;
        if (line === "No") continue;
        if (/^\+6[05\d][\d\s-]{6,}/.test(line)) {
          clientPhone = line;
          break;
        }
        extraLines.push(line);
      }

      const parts = [clientName, ...extraLines];
      if (clientPhone) parts.push(clientPhone);
      clientDetails = parts.filter((p) => p.trim().length > 0).join("\n");
    } else {
      // BOOK number alone on its line; collect subsequent lines as before
      const clientDetailLines: string[] = [];
      for (let i = bookIdx + 1; i < lines.length && clientDetailLines.length < 4; i++) {
        const l = lines[i];
        if (/^\d+\./.test(l)) break;
        if (
          l.includes("COMPANY POLICY") ||
          l.includes("No Booking Details") ||
          l.includes("Booking Details")
        ) break;
        if (l === COMPANY_PHONE) continue;
        if (l === "No") continue;
        clientDetailLines.push(l);
      }
      clientDetails = clientDetailLines.join("\n").trim();
    }
  }

  // ── Booking Row Parsing ─────────────────────────────────────────────────────
  // PyMuPDF splits the table into individual cells, one per line.
  // Each booking row starts with a standalone row number line: "1.", "2.", …
  // Followed by:
  //   route line(s)          — English / Chinese, stop at date
  //   date line              — "12 February, 2026"
  //   vehicle count          — "1", "2"  (integer)
  //   MYR/vehicle amount     — "230.00", "1,200.00"
  //   total amount           — "230.00", "1,200.00"
  //   optional annotation    — "(One-Way Ride Only)", "[Maximum …]"

  const STOP_PHRASES = ["COMPANY POLICY", "COMPANY POLICIES"];
  const isStop      = (l: string) => STOP_PHRASES.some((p) => l.includes(p));
  const isRowNum    = (l: string) => /^\d+\.$/.test(l);
  const isSkippable = (l: string) =>
    l.startsWith("[") ||
    l.startsWith("(") ||
    /^charged if more than/i.test(l) ||
    /^Hourly Rate/i.test(l);

  const parseAmt = (s: string) => parseFloat(s.replace(/,/g, "")) || 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isStop(line)) break;
    if (!isRowNum(line)) continue;

    // ── Collect route lines until we find a date ──
    const routeLines: string[] = [];
    let travelDate: string | null = null;
    let dateParts: { day: string; month: string; year: string } | null = null;
    let j = i + 1;

    while (j < lines.length && j <= i + 10) {
      const next = lines[j];
      if (isStop(next) || isRowNum(next)) break;
      if (isSkippable(next)) { j++; continue; }
      const dp = extractDateParts(next);
      const iso = dp ? parseDateString(next) : null;
      if (iso && dp) {
        travelDate = iso;
        dateParts = dp;
        j++;
        break;
      }
      routeLines.push(next);
      j++;
    }

    if (!travelDate || !dateParts || routeLines.length === 0) continue;

    // ── Collect up to 3 numeric tokens; capture annotation "(…)" lines ──
    const numTokens: string[] = [];
    let annotationLine = "";

    while (j < lines.length && numTokens.length < 3) {
      const next = lines[j];
      if (isStop(next) || isRowNum(next)) break;
      if (isSkippable(next)) {
        // Capture annotation lines starting with "(" before skipping
        if (next.startsWith("(") && !annotationLine) annotationLine = next;
        j++; continue;
      }
      const words = next.trim().split(/\s+/);
      const found = words.filter((w) => /^[\d,]+\.?\d*$/.test(w));
      if (found.length > 0) {
        numTokens.push(...found.slice(0, 3 - numTokens.length));
        j++;
      } else {
        break;
      }
    }

    // Also look ahead for annotation if not yet found
    if (!annotationLine) {
      for (let k = j; k < lines.length; k++) {
        const l = lines[k];
        if (isStop(l) || isRowNum(l)) break;
        if (l.startsWith("(")) { annotationLine = l; break; }
        // Stop if we've hit something clearly non-annotation
        if (!isSkippable(l)) break;
      }
    }

    let numberOfVehicles = 1;
    let myrPerVehicle = 0;
    let amount = 0;

    if (numTokens.length >= 3) {
      const n0 = parseAmt(numTokens[0]);
      if (!numTokens[0].includes(".") && n0 <= 20) {
        numberOfVehicles = n0;
        myrPerVehicle    = parseAmt(numTokens[1]);
        amount           = parseAmt(numTokens[2]);
      } else {
        myrPerVehicle = n0;
        amount        = parseAmt(numTokens[numTokens.length - 1]);
      }
    } else if (numTokens.length === 2) {
      const n0 = parseAmt(numTokens[0]);
      if (!numTokens[0].includes(".") && n0 <= 20) {
        numberOfVehicles = n0;
        amount           = parseAmt(numTokens[1]);
        // myrPerVehicle stays 0 — cannot read it directly when only 2 tokens present
      } else {
        myrPerVehicle = n0;
        amount        = parseAmt(numTokens[1]);
      }
    } else if (numTokens.length === 1) {
      amount        = parseAmt(numTokens[0]);
      myrPerVehicle = amount;
    }

    // ── Clean booking description ──
    const rawRoute = routeLines.join(" ");
    const bookingDetails = cleanBookingDetails(rawRoute)
      .replace(/\[[^\]]*\]/g, "")
      .replace(/Maximum \d+\s*hrs.*/i, "")
      .trim();

    if (!bookingDetails) continue;

    // Skip overtime-only rows — not a trip booking
    if (/^overtime$/i.test(bookingDetails.trim())) continue;

    // Skip Tour Guide rows — not a van trip
    if (/tour\s*guide/i.test(bookingDetails)) continue;

    // ── Determine trip type ──
    const locationResult = parseLocations(bookingDetails);
    const tripType = detectTripType(
      bookingDetails,
      annotationLine,
      locationResult.isRoundTrip === 1
    );

    const fromLocation = locationResult.fromLocation;
    const toLocation = locationResult.toLocation;
    const isRoundTrip = locationResult.isRoundTrip;

    if (!fromLocation) continue;

    // Skip rows with no destination unless they are an explicit day trip.
    // This filters out fee/service lines like "Parking Fees", "Gift",
    // "Paging", "Food", "Help to check in at the hotel", etc.
    if (!toLocation && !/day\s*trip/i.test(bookingDetails)) continue;

    // ── Expand: one row per vehicle ──
    const baseRow = {
      travelDate,
      fromLocation,
      toLocation,
      isRoundTrip,
      details: bookingDetails,
      invoiceNo,
      clientDetails,
      day:   dateParts.day,
      month: dateParts.month,
      year:  dateParts.year,
      numberOfVehicles,
      myrPerVehicle,
      amount,
      vehiclePlate: "",
      driverName: "",
      paidStatus: "U",
      inHouseOrOutsourced: "I",
      outsourcedCompany: "",
      overtime: "",
      introducer: "",
      tripType,
      isAlphardTrip: (detectAlphardTrip(bookingDetails, annotationLine) ? 1 : 0) as 0 | 1,
    } as const;

    for (let vi = 1; vi <= numberOfVehicles; vi++) {
      results.push({ ...baseRow, vehicleIndex: vi });
    }
  }

  return results;
}

/**
 * Extracts travel bookings from a PDF buffer.
 * Calls a Python PyMuPDF microservice for reliable text extraction,
 * then passes the text through parseRawText() unchanged.
 */
export async function extractTravelBookings(
  buffer: Buffer
): Promise<ParsedBooking[]> {
  const pythonServiceUrl = process.env.PDF_SERVICE_URL ?? process.env.NEXT_PUBLIC_PDF_SERVICE_URL;
  if (!pythonServiceUrl) {
    throw new Error("PDF_SERVICE_URL (or NEXT_PUBLIC_PDF_SERVICE_URL) environment variable is not set");
  }

  const response = await fetch(`${pythonServiceUrl}/parse`, {
    method: "POST",
    headers: { "Content-Type": "application/pdf" },
    body: new Uint8Array(buffer),
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(`PDF service error: ${err.error}`);
  }

  const { text } = await response.json();

  if (!text || text.trim().length < 10) {
    throw new Error("PDF service returned empty text");
  }

  return parseRawText(text);
}
