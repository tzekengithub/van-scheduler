import { db } from "@/lib/db";
import { bookings, vans } from "@/drizzle/schema";
import { eq, and, isNotNull, desc } from "drizzle-orm";

export type AssignResult = number | { outsource: true; reason?: string };

/** Detect if a trip requires Singapore or Thailand capability based on locations. */
export function detectTripRequirements(fromLocation: string, toLocation: string) {
  const combined = `${fromLocation} ${toLocation}`.toLowerCase();
  return {
    needsSingapore: combined.includes("singapore"),
    needsThailand: combined.includes("thailand"),
  };
}

export async function smartAssignVan(
  travelDate: string,
  fromLocation: string,
  toLocation: string,
  invoiceNo: string,
  vehicleIndex: number,
  _numberOfVehicles: number,
  tripType?: string | null,
  isAlphardTrip?: boolean,
): Promise<AssignResult> {
  const allVans = await db.select().from(vans).orderBy(vans.id);
  if (allVans.length === 0) return { outsource: true };

  // ── Gather which vans are already booked on this date ──────────────────────
  const bookedOnDate = await db
    .select({ vanId: bookings.vanId })
    .from(bookings)
    .where(and(eq(bookings.travelDate, travelDate), isNotNull(bookings.vanId)));

  const bookedVanIds = new Set(bookedOnDate.map((b) => b.vanId));

  // ── Gather last drop-off location per van (continuity hint) ────────────────
  const vanLastDropOff: Record<number, string | null> = {};
  for (const van of allVans) {
    const [last] = await db
      .select({ toLocation: bookings.toLocation })
      .from(bookings)
      .where(eq(bookings.vanId, van.id))
      .orderBy(desc(bookings.travelDate))
      .limit(1);
    vanLastDropOff[van.id] = last?.toLocation ?? null;
  }

  // ── Alphard hard constraint pre-checks ────────────────────────────────────
  const isAlphardVan = (van: typeof allVans[number]) =>
    (van.vehicleType ?? "").toLowerCase() === "toyota alphard";

  if (isAlphardTrip) {
    const alphardVans = allVans.filter(isAlphardVan);
    if (alphardVans.length === 0) {
      return { outsource: true, reason: "No Toyota Alphard available for this Alphard Trip" };
    }
    const freeAlphards = alphardVans.filter((v) => !bookedVanIds.has(v.id));
    if (freeAlphards.length === 0) {
      return { outsource: true, reason: "All Toyota Alphards are fully booked for this time slot" };
    }
  }

  // ── Check if this invoice already has a van assigned on another date ───────
  let existingInvoiceVanId: number | null = null;
  if (invoiceNo.trim()) {
    const [prior] = await db
      .select({ vanId: bookings.vanId })
      .from(bookings)
      .where(
        and(
          eq(bookings.invoiceNo, invoiceNo),
          eq(bookings.vehicleIndex, vehicleIndex),
          isNotNull(bookings.vanId),
        )
      )
      .limit(1);
    existingInvoiceVanId = prior?.vanId ?? null;
  }

  // ── Build van context for the AI (pre-filtered by Alphard eligibility) ────
  const eligibleVans = allVans.filter((van) =>
    isAlphardTrip ? isAlphardVan(van) : !isAlphardVan(van)
  );
  const vanContext = eligibleVans.map((van) => ({
    id: van.id,
    plate: van.vanNumber,
    driver: van.driverName || "Unknown",
    freeOnDate: !bookedVanIds.has(van.id),
    singaporeEnabled: van.singaporeEnabled === 1,
    thailandEnabled: van.thailandEnabled === 1,
    lastDropOffLocation: vanLastDropOff[van.id] ?? null,
    preferredForThisInvoice: van.id === existingInvoiceVanId,
  }));

  // ── Call OpenRouter Gemini 2.5 Pro ─────────────────────────────────────────
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");

  const systemPrompt = `You are a van fleet dispatch optimizer. Assign the best available van to a booking.

HARD RULES (never break these):
1. A van can only take ONE booking per day — never assign a van where freeOnDate=false.
2. Routes involving Singapore require singaporeEnabled=true on the van.
3. Routes involving Thailand require thailandEnabled=true on the van.
4. If no suitable free van exists, return outsource=true.
5. Only vans in the list below are eligible for this booking (vehicle-type filtering is pre-applied).

SOFT PREFERENCES (apply when multiple vans are eligible):
- If preferredForThisInvoice=true on a free van, prefer it (keeps multi-day invoices on the same van).
- Otherwise prefer a van whose lastDropOffLocation matches the booking's fromLocation (routing continuity).
- Otherwise pick the van with the lowest id.

Respond ONLY with valid JSON — no markdown, no explanation:
{"vanId": <number>, "outsource": false}   — when assigning a van
{"vanId": null, "outsource": true}         — when no van is available`;

  const userMessage = `Booking details:
- Travel date: ${travelDate}
- From: ${fromLocation}
- To: ${toLocation}
- Trip type: ${tripType ?? "trip"}
- Invoice: ${invoiceNo || "n/a"}
- Vehicle index: ${vehicleIndex}

Vans:
${JSON.stringify(vanContext, null, 2)}`;

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
      "X-Title": "Van Scheduler",
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-pro",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenRouter error ${response.status}: ${errText.slice(0, 300)}`);
  }

  const json = await response.json();
  const content: string = json.choices?.[0]?.message?.content ?? "";

  let result: { vanId: number | null; outsource: boolean };
  try {
    result = JSON.parse(content);
  } catch {
    throw new Error(`AI returned non-JSON: ${content.slice(0, 200)}`);
  }

  if (result.outsource || result.vanId == null) return { outsource: true };

  // Safety check — make sure returned ID actually exists, is free, and obeys Alphard rules
  const chosenVan = allVans.find((v) => v.id === result.vanId);
  if (!chosenVan || bookedVanIds.has(chosenVan.id)) return { outsource: true };
  if (isAlphardTrip && !isAlphardVan(chosenVan)) return { outsource: true };
  if (!isAlphardTrip && isAlphardVan(chosenVan)) return { outsource: true };

  return chosenVan.id;
}
