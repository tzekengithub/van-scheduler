import { NextRequest, NextResponse } from "next/server";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const SYSTEM_PROMPT = `You are an invoice data extractor for a Malaysian transport company (ETSM88).
Extract structured invoice data from the raw text the user provides.

Return ONLY valid JSON — no markdown, no explanation:
{
  "customerName": "string",
  "contactPerson": "string",
  "customerDetails": "string (phone, WeChat, IC, or other contact details)",
  "invoiceDate": "string (e.g. '15 April 2026')",
  "items": [
    {
      "route": "string — MUST use hyphen separator, see format rules below",
      "travelDate": "string (e.g. '15 April 2026')",
      "vehicleCount": number,
      "unitPrice": number,
      "isOneWay": boolean,
      "isAlphard": boolean,
      "is15Pax": boolean,
      "isCar": boolean
    }
  ],
  "notes": "string"
}

ROUTE FORMAT RULES (critical — wrong format breaks the scheduler):
- One-way:   "KLIA - KL"  or  "KL - Penang"  (From - To)
- Round trip: "KL - Penang - KL"  (From - To - From, same start and end)
- Day trip:  "KL Day Trip"  (no destination needed)
- ALWAYS use " - " (space-hyphen-space) as separator. Never use "→" or "to".
- Do NOT include Chinese characters or slash descriptions.

ANNOTATION FLAGS:
- isOneWay: true if trip is one-way only (keywords: one-way, one way, ride only, airport transfer)
- isAlphard: true if Alphard vehicle requested
- is15Pax: true if 15-pax / 15-seater van needed
- isCar: true if 5-seater or 7-seater car requested (auto-outsourced)

OTHER RULES:
- vehicleCount and unitPrice must be plain numbers (no currency symbols, no commas)
- If travel date is missing for an item, use the invoice date
- If vehicleCount is not mentioned, default to 1
- Create one item per trip leg (not one per vehicle)
- Combine all customer contact info into customerDetails`;

export async function POST(request: NextRequest) {
  const { text } = await request.json();

  if (!text || typeof text !== "string") {
    return NextResponse.json({ error: "text required" }, { status: 400 });
  }

  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-pro",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
      temperature: 0.1,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    return NextResponse.json({ error: `OpenRouter error: ${err}` }, { status: 502 });
  }

  const json = await resp.json();
  const raw = json.choices?.[0]?.message?.content ?? "";

  let extracted: unknown;
  try {
    const cleaned = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
    extracted = JSON.parse(cleaned);
  } catch {
    return NextResponse.json({ error: "AI returned invalid JSON", raw }, { status: 502 });
  }

  return NextResponse.json(extracted);
}
