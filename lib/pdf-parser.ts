export interface ParsedBooking {
  // existing fields (for van-assignment compatibility)
  travelDate: string;      // YYYY-MM-DD
  fromLocation: string;
  toLocation: string;
  isRoundTrip: 0 | 1;
  details: string;         // cleaned booking description
  // new fields
  invoiceNo: string;
  clientDetails: string;
  day: string;
  month: string;
  year: string;
  numberOfVehicles: number;
  myrPerVehicle: number;
  amount: number;
  vehiclePlate: string;
  driverName: string;
  paidStatus: string;
  inHouseOrOutsourced: string;
  outsourcedCompany: string;
  overtime: string;
  introducer: string;
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

  if (parts.length === 2) {
    return { fromLocation: parts[0], toLocation: parts[1], isRoundTrip: 0 };
  }

  if (
    parts.length === 3 &&
    parts[0].toLowerCase() === parts[2].toLowerCase()
  ) {
    return { fromLocation: parts[0], toLocation: parts[1], isRoundTrip: 1 };
  }

  // Fallback: first and last
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
 * Parse raw text extracted from an invoice PDF.
 * Pure function — no PDF dependency, fully testable.
 */
export function parseRawText(text: string): ParsedBooking[] {
  const lines = text.split("\n").map((l) => l.trim());
  const results: ParsedBooking[] = [];

  // --- Header extraction ---
  // Match invoice number from full text (handles same-line and two-line formats)
  const invoiceMatch =
    text.match(/Invoice\s*Number\s*\n?\s*(INV\d+)/i) ??
    text.match(/(INV\d{10,})/i);
  let invoiceNo = invoiceMatch ? invoiceMatch[1] : "";

  let clientName = "";
  let clientContact = "";

  // Labels that indicate the company's own contact line, not the client's.
  // Use word boundaries so "Hotel" does not match \btel\b.
  const SKIP_LABELS = /\bcompany\s+contact\b|\bcontact\s*no\b|\btel(?:ephone)?\b|\bfax\b|\bhotline\b/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    // Client info — phone number and name
    if (!clientContact) {
      const phoneMatch = line.match(/(\+60[\d\s-]{8,})/);
      if (phoneMatch) {
        const beforePhone = line.slice(0, line.indexOf(phoneMatch[0])).trim();
        // Skip lines like "Company Contact No : +60 ..." — that's the company's own number
        if (SKIP_LABELS.test(beforePhone)) continue;
        clientContact = phoneMatch[1].trim();
        if (beforePhone) {
          clientName = beforePhone;
        } else if (i > 0 && lines[i - 1] && !/^\d+\./.test(lines[i - 1])) {
          const prevLine = lines[i - 1].trim();
          if (!SKIP_LABELS.test(prevLine)) {
            clientName = prevLine;
          }
        }
      }
    }
  }

  const clientDetails = [clientName, clientContact].filter(Boolean).join(" ").trim();

  // --- Booking line parsing ---
  const STOP_PHRASES = [
    "COMPANY POLICY",
    "All cheques should be",
    "Payment by CASH",
    "Please send the payment",
    "For Tour",
    "For Ride",
    "TOTAL amount",
    "For Pick Up",
    "For cancellation",
    "Balance must",
    "Balance paid",
    "All fees in",
    "Company is not responsible",
    "For customers travelling",
    "This is computer generated",
  ];

  let currentDateStr: string | null = null;
  let currentDay = "";
  let currentMonth = "";
  let currentYear = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    if (STOP_PHRASES.some((phrase) => line.includes(phrase))) break;

    // Format A: "1. KL - KLIA 13 February, 2026 1 230.00"
    const isFormatA = /^\d+\./.test(line);
    // Format B: "KL - KLIA / Chinese 1. 13 February, 2026 1 230.00 230.00"
    const isFormatB = !isFormatA && /^.+?\s+\d+\.\s+\d{1,2}\s+[A-Za-z]+/.test(line);

    // Non-booking line: track running date and move on
    if (!isFormatA && !isFormatB) {
      const parts = extractDateParts(line);
      const iso = parts ? parseDateString(line) : null;
      if (iso && parts) {
        currentDateStr = iso;
        currentDay = parts.day;
        currentMonth = parts.month;
        currentYear = parts.year;
      }
      continue;
    }

    // Normalise to "route date prices" by stripping the row number.
    // Format A: strip leading "1. ", Format B: strip inline " 1. "
    const remainder = isFormatA
      ? line.replace(/^\d+\.\s*/, "").trim()
      : line.replace(/\s+\d+\.\s+/, " ").trim();

    const inlineParts = extractDateParts(remainder);
    const inlineIso = inlineParts ? parseDateString(remainder) : null;

    const travelDate = inlineIso ?? currentDateStr;
    if (!travelDate) continue;

    const usedDay = inlineParts?.day ?? currentDay;
    const usedMonth = inlineParts?.month ?? currentMonth;
    const usedYear = inlineParts?.year ?? currentYear;

    if (inlineIso && inlineParts) {
      currentDateStr = inlineIso;
      currentDay = inlineParts.day;
      currentMonth = inlineParts.month;
      currentYear = inlineParts.year;
    }

    // Isolate booking description: everything before the date
    const dateMatch = remainder.match(/\b\d{1,2}\s+[A-Za-z]+,?\s+\d{4}\b/);
    const rawDetails = dateMatch
      ? remainder.slice(0, remainder.indexOf(dateMatch[0])).trim()
      : remainder;

    const bookingDetails = cleanBookingDetails(rawDetails);

    // Parse vehicle count and prices from the portion after the date
    const afterDate = dateMatch
      ? remainder.slice(remainder.indexOf(dateMatch[0]) + dateMatch[0].length).trim()
      : "";

    const numTokens = afterDate.match(/[\d,]+\.?\d*/g) ?? [];
    // Normalize comma-thousands separators
    const nums = numTokens.map((t) => parseFloat(t.replace(/,/g, "")));

    let numberOfVehicles = 1;
    let myrPerVehicle = 0;
    let amount = 0;

    if (nums.length >= 1) {
      const first = numTokens[0] ?? "";
      // Is first token an integer vehicle count (no decimal, value <= 20)?
      if (!first.includes(".") && nums[0] <= 20) {
        numberOfVehicles = nums[0];
        if (nums.length >= 2) {
          myrPerVehicle = nums[1];
          amount = nums.length >= 3 ? nums[nums.length - 1] : numberOfVehicles * myrPerVehicle;
        }
      } else {
        // Only prices, no explicit count
        myrPerVehicle = nums[0];
        amount = nums.length >= 2 ? nums[nums.length - 1] : nums[0];
      }
    }

    // Look at next non-empty line for ride type annotation
    let rideTypeAnnotation = "";
    for (let j = i + 1; j < lines.length && j <= i + 3; j++) {
      const next = lines[j].trim();
      if (!next) continue;
      const rideMatch = next.match(/\(?(One-Way Ride Only|Maximum \d+\s*hrs[^)]*)\)?/i);
      if (rideMatch) {
        rideTypeAnnotation = rideMatch[1].trim();
      }
      break;
    }

    const finalDetails = rideTypeAnnotation
      ? `${bookingDetails} (${rideTypeAnnotation})`
      : bookingDetails;

    if (!bookingDetails) continue;

    const { fromLocation, toLocation, isRoundTrip } = parseLocations(bookingDetails);
    if (!fromLocation || !toLocation) continue;

    results.push({
      travelDate,
      fromLocation,
      toLocation,
      isRoundTrip,
      details: finalDetails,
      invoiceNo,
      clientDetails,
      day: usedDay,
      month: usedMonth,
      year: usedYear,
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
    });
  }

  return results;
}

/**
 * Extracts travel bookings from a PDF buffer.
 * Calls a Python pdfminer microservice for reliable text extraction,
 * then passes the text through parseRawText() unchanged.
 */
export async function extractTravelBookings(
  buffer: Buffer
): Promise<ParsedBooking[]> {
  const pythonServiceUrl = process.env.PDF_SERVICE_URL;
  if (!pythonServiceUrl) {
    throw new Error("PDF_SERVICE_URL environment variable not set");
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
