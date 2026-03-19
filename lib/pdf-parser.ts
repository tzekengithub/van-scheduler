export interface ParsedBooking {
  travelDate: string; // YYYY-MM-DD
  fromLocation: string;
  toLocation: string;
  isRoundTrip: 0 | 1;
  details: string;
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
  const match = raw.match(/\b(\d{1,2})\s+([A-Za-z]+),\s+(\d{4})\b/);
  if (!match) return null;
  const day = match[1].padStart(2, "0");
  const month = MONTHS[match[2].toLowerCase()];
  const year = match[3];
  if (!month) return null;
  return `${year}-${month}-${day}`;
}

/**
 * Ports Flask's extract_travel_bookings().
 * Accepts a PDF Buffer (in-memory — no disk writes, Vercel compatible).
 * Uses dynamic import of pdf-parse to avoid its test-fixture writes at module load time.
 */
export async function extractTravelBookings(
  pdfBuffer: Buffer
): Promise<ParsedBooking[]> {
  // Dynamic import prevents pdf-parse from executing its require-time side-effects
  // (writing test fixture files) which would crash on Vercel's read-only filesystem.
  const pdfParse = (await import("pdf-parse")).default;
  const data = await pdfParse(pdfBuffer);

  const lines = data.text.split("\n").map((l: string) => l.trim());
  const results: ParsedBooking[] = [];
  let currentDate: string | null = null;

  for (const line of lines) {
    if (!line) continue;

    // Update running date whenever we see a date pattern on its own line
    const parsedDate = parseDateString(line);
    if (parsedDate && !/^\d+\./.test(line)) {
      currentDate = parsedDate;
      continue;
    }

    // Numbered booking line: "1. KL - KLIA 15 March, 2024 250.00"
    if (/^\d+\.\s/.test(line)) {
      // Extract date from this line if present (date may appear inline)
      const inlineDate = parseDateString(line);
      const travelDate = inlineDate ?? currentDate;
      if (!travelDate) continue;

      if (inlineDate) currentDate = inlineDate;

      // Strip the number prefix
      let details = line.replace(/^\d+\.\s*/, "").trim();
      // Strip date portion
      details = details.replace(/\b\d{1,2}\s+[A-Za-z]+,\s+\d{4}\b/, "").trim();
      // Strip trailing price/numbers
      details = details.replace(/\s+\d[\d.,]*.*$/, "").trim();

      if (!details) continue;

      const { fromLocation, toLocation, isRoundTrip } = parseLocations(details);
      if (!fromLocation || !toLocation) continue;

      results.push({ travelDate, fromLocation, toLocation, isRoundTrip, details });
    }
  }

  return results;
}
