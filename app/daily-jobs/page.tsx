"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useUploadContext } from "@/app/upload-context";

const MONTHS_LIST = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];
const DAYS_LIST = Array.from({ length: 31 }, (_, i) => String(i + 1));
const YEARS_LIST = ["2024", "2025", "2026", "2027"];
const OVERTIME_OPTIONS = Array.from({ length: 21 }, (_, i) =>
  (i * 0.5).toFixed(i === 0 ? 0 : 1)
);

type TripType = "one_way_ride" | "round_trip" | "day_trip" | "trip";

interface BookingRow {
  id: number;
  travelDate: string;
  fromLocation: string;
  toLocation: string;
  isRoundTrip: number;
  details: string | null;
  vanId: number | null;
  vanNumber: string | null;
  manualChange: number;
  invoiceNo: string | null;
  clientDetails: string | null;
  amount: string | null;
  passengerCount: number | null;
  myrPerVehicle: string | null;
  vehiclePlate: string | null;
  driverName: string | null;
  driverContact: string | null;
  paidStatus: string | null;
  overtime: string | null;
  introducer: string | null;
  inHouseOrOutsourced: string | null;
  outsourcedCompany: string | null;
  outsourceReason: string | null;
  day: string | null;
  month: string | null;
  year: string | null;
  tripType: TripType | null;
  tourGuide: string | null;
  vehicleIndex: number | null;
  numberOfVehicles: number | null;
  vehicleCategory: string | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseClientDetails(clientDetails: string): { name: string; phone: string } {
  if (!clientDetails) return { name: "", phone: "" };
  const lines = clientDetails.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return { name: "", phone: "" };
  if (lines.length === 1) return { name: lines[0], phone: "" };
  if (lines.length === 2) return { name: lines[0], phone: lines[1] };
  // 3+ lines: line 0 = name, line 1 = contact person (skip), line 2 = phone
  return { name: lines[0], phone: lines[2] };
}

function clientName(row: BookingRow): string {
  return parseClientDetails(row.clientDetails ?? "").name;
}

function clientPhone(row: BookingRow): string {
  return parseClientDetails(row.clientDetails ?? "").phone;
}

function tripTypeBadge(t: TripType | null) {
  const base: React.CSSProperties = {
    display: "inline-flex", alignItems: "center", gap: 3,
    padding: "2px 7px", borderRadius: 4, fontSize: 10, fontWeight: 700,
    fontFamily: "var(--font-mono)", letterSpacing: "0.04em", whiteSpace: "nowrap",
    border: "1px solid",
  };
  switch (t) {
    case "one_way_ride":
      return <span style={{ ...base, background: "rgba(88,166,255,0.12)", borderColor: "rgba(88,166,255,0.3)", color: "var(--blue)" }}>→ One Way</span>;
    case "round_trip":
      return <span style={{ ...base, background: "rgba(63,185,80,0.12)", borderColor: "rgba(63,185,80,0.3)", color: "var(--green)" }}>⇄ Round Trip</span>;
    case "day_trip":
      return <span style={{ ...base, background: "rgba(245,158,11,0.12)", borderColor: "rgba(245,158,11,0.3)", color: "var(--amber)" }}>◎ Day Trip</span>;
    case "trip":
    default:
      return <span style={{ ...base, background: "rgba(251,146,60,0.12)", borderColor: "rgba(251,146,60,0.3)", color: "var(--orange)" }}>◷ Trip</span>;
  }
}

function tripTypeLabel(t: TripType | null): string {
  switch (t) {
    case "one_way_ride": return "One-Way Ride Only";
    case "round_trip":   return "Round Trip";
    case "day_trip":     return "Day Trip";
    default:             return "Trip";
  }
}

function formatFullDate(day: string, month: string, year: string): string {
  const monthNum = MONTHS_LIST.indexOf(month);
  if (monthNum === -1) return `${day} ${month} ${year}`;
  const d = new Date(Number(year), monthNum, Number(day));
  const weekday = d.toLocaleDateString("en-GB", { weekday: "long" });
  return `${weekday}, ${day} ${month} ${year}`;
}

function formatShortDate(day: string, month: string, year: string): string {
  const monthNum = MONTHS_LIST.indexOf(month);
  if (monthNum === -1) return `${day}/${month}/${year}`;
  const d = new Date(Number(year), monthNum, Number(day));
  const weekday = d.toLocaleDateString("en-GB", { weekday: "short" });
  const mm = String(monthNum + 1).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${dd}/${mm}/${year} (${weekday})`;
}

// ── WhatsApp export ───────────────────────────────────────────────────────────

function formatBriefDate(travelDate: string): string {
  const raw = cleanText(travelDate);
  if (!raw) return "";
  const d = new Date(raw + "T00:00:00");
  if (isNaN(d.getTime())) return raw;
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

function cleanText(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (/^(undefined|null|nan)$/i.test(text)) return "";
  if (text === "-" || (text.length === 1 && text.charCodeAt(0) === 8212)) return "";
  return text;
}

function finishWhatsAppText(lines: string[]): string {
  return lines
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

function pushBlank(lines: string[]) {
  if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
}

function pushSection(lines: string[], label: string, value: string, always = false) {
  const cleanValue = cleanText(value);
  if (!always && !cleanValue) return;
  pushBlank(lines);
  lines.push(label, cleanValue);
}

function pushInlineSection(lines: string[], label: string, value: string, always = false) {
  const cleanValue = cleanText(value);
  if (!always && !cleanValue) return;
  lines.push(cleanValue ? `${label} ${cleanValue}` : label);
}

function normalizeComparable(value: string): string {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function uniqueBy<T>(items: T[], keyFor: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = keyFor(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function rowHaystack(row: BookingRow): string {
  return [
    row.fromLocation,
    row.toLocation,
    row.details,
    row.clientDetails,
    row.tourGuide,
  ].map(cleanText).filter(Boolean).join(" ");
}

function rowsHaystack(rows: BookingRow[]): string {
  return rows.map(rowHaystack).join(" ");
}

function extractTime(row: BookingRow): string {
  const match = rowHaystack(row).match(
    /\b((?:[01]?\d|2[0-3])[:.][0-5]\d\s*(?:am|pm)?|(?:[1-9]|1[0-2])\s*(?:am|pm))\b/i
  );
  return cleanText(match?.[1]);
}

function extractFlightNo(row: BookingRow): string {
  const text = rowHaystack(row);
  const explicit = text.match(/\bflight\s*(?:no\.?|number)?\s*[:#-]?\s*([A-Z0-9]{2,4}\s?\d{2,5}[A-Z]?)\b/i);
  if (explicit?.[1]) return cleanText(explicit[1]).toUpperCase();
  const general = text.match(/\b([A-Z]{2}\s?\d{2,5}[A-Z]?)\b/);
  return cleanText(general?.[1]).toUpperCase();
}

function extractHotel(rows: BookingRow[]): string {
  const hotelPattern = /\b(hotel|resort|inn|suite|suites|serviced residence)\b/i;
  for (const row of rows) {
    const locations = [row.fromLocation, row.toLocation].map(cleanText);
    const match = locations.find((location) => hotelPattern.test(location));
    if (match) return match;
  }
  const detailLine = rows
    .flatMap((row) => cleanText(row.details).split(/\n+/))
    .map(cleanText)
    .find((line) => hotelPattern.test(line));
  return cleanText(detailLine);
}

function isLikelyPhone(value: string): boolean {
  return /(?:\+?\d[\d\s-]{6,}\d)/.test(value);
}

function guestContactLines(row: BookingRow): string[] {
  const lines = cleanText(row.clientDetails).split(/\n+/).map(cleanText).filter(Boolean);
  if (lines.length === 0) return [];

  const phones = lines.filter(isLikelyPhone);
  const names = lines.filter((line) => !isLikelyPhone(line));

  if (phones.length === 0 || names.length === 0) return lines;
  if (phones.length === 1) return names.map((name) => `${name} - ${phones[0]}`);

  const paired = names.map((name, index) => {
    const phone = phones[index] ?? phones[phones.length - 1];
    return `${name} - ${phone}`;
  });
  const extraPhones = phones.slice(names.length);
  return [...paired, ...extraPhones];
}

function passengerAndLuggage(row: BookingRow): string {
  const pax = typeof row.passengerCount === "number" && row.passengerCount > 0
    ? `${row.passengerCount} pax`
    : "";
  const details = rowHaystack(row);
  const lower = details.toLowerCase();

  let luggage = "";
  const luggageCount = details.match(/\b\d+\s*(?:pcs?|pieces?|bags?|luggages?)\b/i);
  if (luggageCount?.[0]) {
    luggage = luggageCount[0];
  } else if (/\b(with|including)\s+luggage\b/i.test(details)) {
    luggage = "with luggage";
  } else if (/\b(no|without)\s+luggage\b/i.test(lower)) {
    luggage = "without luggage";
  }

  return [pax, luggage].filter(Boolean).join(" ");
}

function remarksFor(row: BookingRow): string {
  const remarks = cleanText(row.details);
  if (!remarks) return "";

  const from = cleanText(row.fromLocation);
  const to = cleanText(row.toLocation);
  const normalizedRemarks = normalizeComparable(remarks);
  const routeForms = [
    from,
    `${from} ${to}`,
    `${from} to ${to}`,
    `${from} ${to} one way`,
    `${from} ${to} one-way`,
    `${from} ${to} ride only`,
  ].map(normalizeComparable);

  if (routeForms.includes(normalizedRemarks)) return "";
  return remarks;
}

function combinedRemarks(rows: BookingRow[]): string {
  return uniqueBy(
    rows.map(remarksFor).filter(Boolean),
    (remark) => normalizeComparable(remark)
  ).join("\n");
}

function serviceValue(rows: BookingRow[], yesPattern: RegExp, noPattern: RegExp): string {
  const text = rowsHaystack(rows).toLowerCase();
  if (noPattern.test(text)) return "No";
  if (yesPattern.test(text)) return "Yes";
  return "";
}

function pushServiceRequirements(lines: string[], rows: BookingRow[]) {
  pushBlank(lines);
  lines.push("Service Requirements:");
  pushInlineSection(lines, "Paging:", serviceValue(rows, /\bpaging\b/i, /\b(no|without)\s+paging\b/i), true);
  pushInlineSection(
    lines,
    "Hotel Check-In Assistance:",
    serviceValue(rows, /\b(help\s+to\s+)?check[-\s]?in\b|\bhotel\s+check[-\s]?in\b/i, /\b(no|without)\s+(hotel\s+)?check[-\s]?in\b/i),
    true
  );
  pushInlineSection(
    lines,
    "Luggage Assistance:",
    serviceValue(rows, /\b(luggage\s+assistance|assist(?:ance)?\s+with\s+luggage|help\s+with\s+luggage|porter)\b/i, /\b(no|without)\s+luggage\s+assistance\b/i),
    true
  );
  pushInlineSection(lines, "Remarks:", combinedRemarks(rows), true);
}

function inferTripType(row: BookingRow, allLegs: BookingRow[]): string {
  const uniqueDates = new Set(allLegs.map((leg) => cleanText(leg.travelDate)).filter(Boolean));
  if (uniqueDates.size > 1) return "Multi-Day Trip";

  const text = rowsHaystack([row, ...allLegs]);
  if (/\b(KLIA\s*1|KLIA\s*2|KLIA|airport|terminal|arrival|departure)\b/i.test(text) || extractFlightNo(row)) {
    return "Airport Transfer";
  }
  if (/\b(10\s*hours?|10\s*hrs?|day\s*trip|full\s*day|melaka\s+day\s+trip|kl\s+day\s+trip)\b/i.test(text) || row.tripType === "day_trip") {
    return "Day Trip";
  }
  if (/\b(convention\s+cent(?:er|re)|event\s+venue|hotel\s+event|event|expo|exhibition|conference|ballroom|banquet|wedding)\b/i.test(text)) {
    return "Event Transfer";
  }
  if (cleanText(row.fromLocation) && cleanText(row.toLocation)) return "Point-to-Point Transfer";
  return "Transfer";
}

function hasDriverData(row: BookingRow | undefined): boolean {
  if (!row) return false;
  return Boolean(
    cleanText(row.driverName) ||
    cleanText(row.driverContact) ||
    cleanText(row.vehiclePlate) ||
    cleanText(row.vanNumber)
  );
}

function driverLines(row: BookingRow | undefined): string[] {
  if (!row) return [];
  return [
    cleanText(row.driverName),
    cleanText(row.driverContact),
    cleanText(row.vehiclePlate) || cleanText(row.vanNumber),
  ].filter(Boolean);
}

function driverByVehicle(legs: BookingRow[]): Map<number, BookingRow> {
  const drivers = new Map<number, BookingRow>();
  for (const leg of legs) {
    const vi = leg.vehicleIndex && leg.vehicleIndex > 0 ? leg.vehicleIndex : 1;
    if (!drivers.has(vi) && hasDriverData(leg)) drivers.set(vi, leg);
  }
  return drivers;
}

function vehicleCount(legs: BookingRow[], repRow: BookingRow): number {
  const declared = repRow.numberOfVehicles && repRow.numberOfVehicles > 0 ? repRow.numberOfVehicles : 1;
  const maxIndex = legs.reduce((max, leg) => Math.max(max, leg.vehicleIndex ?? 1), 1);
  return Math.max(declared, maxIndex);
}

function vehicleLabel(row: BookingRow | undefined, fallback: BookingRow): string {
  const category = cleanText(row?.vehicleCategory) || cleanText(fallback.vehicleCategory);
  return category && category.toLowerCase() !== "van" ? category : "Van";
}

function pushDriverInformation(lines: string[], legs: BookingRow[], repRow: BookingRow) {
  const drivers = driverByVehicle(legs);
  const count = vehicleCount(legs, repRow);
  const isMultiVehicle = count > 1 || drivers.size > 1;

  pushBlank(lines);
  if (isMultiVehicle) {
    const indexes = Array.from(
      new Set([
        ...Array.from({ length: count }, (_, index) => index + 1),
        ...Array.from(drivers.keys()),
      ])
    ).sort((a, b) => a - b);

    for (const index of indexes) {
      const driver = drivers.get(index);
      lines.push(`${vehicleLabel(driver, repRow)} ${index} Driver Information:`);
      const info = driverLines(driver);
      lines.push(...(info.length > 0 ? info : ["No driver assigned"]));
      lines.push("");
    }
    return;
  }

  const driver = drivers.get(1) ?? legs.find(hasDriverData) ?? repRow;
  const info = driverLines(driver);
  if (info.length === 0) {
    lines.push("No driver assigned");
    return;
  }

  lines.push("Driver Information:");
  lines.push(...info);
}

function legKey(leg: BookingRow): string {
  return [
    cleanText(leg.travelDate),
    normalizeComparable(cleanText(leg.fromLocation)),
    normalizeComparable(cleanText(leg.toLocation)),
    normalizeComparable(cleanText(leg.details)),
  ].join("|");
}

function buildInvBlock(invKey: string, allInvLegs: BookingRow[], repRow: BookingRow): string {
  const lines: string[] = [];

  // Deduplicate legs by date and route so multi-van rows share one itinerary leg.
  const uniqueLegs = uniqueBy(allInvLegs, legKey)
    .sort((a, b) => (a.travelDate ?? "").localeCompare(b.travelDate ?? "") || a.id - b.id);

  const isMultiLeg = uniqueLegs.length > 1;

  if (isMultiLeg) {
    if (!invKey.startsWith("__solo_")) pushSection(lines, "Invoice No:", invKey, true);
    pushSection(lines, "Group / Booking:", clientName(repRow) || remarksFor(repRow), true);
    pushSection(lines, "Pax & Luggage:", passengerAndLuggage(repRow), true);
    pushSection(lines, "Hotel:", extractHotel(allInvLegs), true);

    pushBlank(lines);
    lines.push("Itinerary:");

    uniqueLegs.forEach((leg, index) => {
      lines.push("");
      lines.push(`Day ${index + 1} - ${formatBriefDate(leg.travelDate)}`);
      lines.push("Time:");
      lines.push(extractTime(leg));
      lines.push("From:");
      lines.push(cleanText(leg.fromLocation));
      lines.push("To:");
      lines.push(cleanText(leg.toLocation));
      lines.push("Remarks:");
      lines.push(remarksFor(leg));
    });

    pushDriverInformation(lines, allInvLegs, repRow);
    pushServiceRequirements(lines, allInvLegs);
    return finishWhatsAppText(lines);
  }

  pushSection(lines, "Date:", formatBriefDate(repRow.travelDate), true);
  pushSection(lines, "Time:", extractTime(repRow), true);
  pushSection(lines, "Flight No.:", extractFlightNo(repRow), true);
  pushSection(lines, "Trip Type:", inferTripType(repRow, allInvLegs), true);
  pushSection(lines, "From:", cleanText(repRow.fromLocation), true);
  pushSection(lines, "To:", cleanText(repRow.toLocation), true);
  pushSection(lines, "Pax & Luggage:", passengerAndLuggage(repRow), true);
  pushSection(lines, "Guest Contact:", guestContactLines(repRow).join("\n"), true);
  pushSection(lines, "Tour Guide:", cleanText(repRow.tourGuide), true);
  pushServiceRequirements(lines, [repRow]);
  pushDriverInformation(lines, allInvLegs, repRow);

  return finishWhatsAppText(lines);
}

function buildOutsourcedBlock(outsourced: BookingRow[]): string {
  const lines: string[] = [];
  const dates = uniqueBy(
    outsourced.map((row) => formatBriefDate(row.travelDate)).filter(Boolean),
    (date) => date
  );
  const dateLabel = dates.length > 0 ? ` (${dates.join(", ")})` : "";
  lines.push(`OUTSOURCED${dateLabel}`);

  outsourced.forEach((row, index) => {
    pushBlank(lines);
    lines.push(`Job ${index + 1}`);
    pushSection(lines, "Date:", formatBriefDate(row.travelDate), true);
    pushSection(lines, "Time:", extractTime(row), true);
    pushSection(lines, "From:", cleanText(row.fromLocation), true);
    pushSection(lines, "To:", cleanText(row.toLocation), true);
    pushSection(lines, "Pax & Luggage:", passengerAndLuggage(row), true);
    pushSection(lines, "Supplier / Outsourced To:", cleanText(row.outsourcedCompany), true);
    pushDriverInformation(lines, [row], row);
    pushSection(lines, "Remarks:", [remarksFor(row), cleanText(row.outsourceReason)].filter(Boolean).join("\n"), true);
  });

  return finishWhatsAppText(lines);
}

function generateWhatsAppBlocks(
  allLegs: BookingRow[],
  dayRows: BookingRow[]
): { key: string; label: string; text: string }[] {
  const blocks: { key: string; label: string; text: string }[] = [];

  const inHouse = dayRows.filter(
    (r) => r.inHouseOrOutsourced !== "O" && r.inHouseOrOutsourced !== "outsourced"
  );
  const outsourced = dayRows.filter(
    (r) => r.inHouseOrOutsourced === "O" || r.inHouseOrOutsourced === "outsourced"
  );

  // Group in-house by invoice
  const invoiceOrder: string[] = [];
  const invoiceMap = new Map<string, BookingRow[]>();
  for (const r of inHouse) {
    const key = r.invoiceNo?.trim() || `__solo_${r.id}`;
    if (!invoiceMap.has(key)) { invoiceMap.set(key, []); invoiceOrder.push(key); }
    invoiceMap.get(key)!.push(r);
  }

  let jobIdx = 0;
  for (const invKey of invoiceOrder) {
    jobIdx++;
    const todayLegs = invoiceMap.get(invKey)!;
    const repRow = todayLegs[0];

    let allInvLegs: BookingRow[];
    if (invKey.startsWith("__solo_")) {
      allInvLegs = todayLegs;
    } else {
      allInvLegs = allLegs
        .filter(r => r.invoiceNo?.trim() === invKey)
        .sort((a, b) => (a.travelDate ?? "").localeCompare(b.travelDate ?? ""));
      if (allInvLegs.length === 0) allInvLegs = todayLegs;
    }

    const label = invKey.startsWith("__solo_") ? `Job ${jobIdx}` : invKey;
    blocks.push({ key: invKey, label, text: buildInvBlock(invKey, allInvLegs, repRow) });
  }

  // Outsourced block
  if (outsourced.length > 0) {
    blocks.push({ key: "__outsourced", label: `Outsourced (${outsourced.length})`, text: buildOutsourcedBlock(outsourced) });
  }

  return blocks;
}

function generateWhatsAppText(
  allLegs: BookingRow[],
  dayRows: BookingRow[],
  fullDateLabel: string
): string {
  const blocks = generateWhatsAppBlocks(allLegs, dayRows);
  const inHouseCount = dayRows.filter(r => r.inHouseOrOutsourced !== "O" && r.inHouseOrOutsourced !== "outsourced").length;
  const outCount = dayRows.length - inHouseCount;
  const parts = [
    `📅 *${fullDateLabel}*`,
    ``,
    ...blocks.flatMap((b, i) => i > 0 ? [`─────────────────────`, ``, b.text, ``] : [b.text, ``]),
    `─────────────────────`,
    `Total: ${dayRows.length} booking${dayRows.length !== 1 ? "s" : ""} · ${inHouseCount} in-house · ${outCount} outsourced`,
  ];
  return parts.join("\n");
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function DailyJobsPage() {
  const today = new Date();
  const [day, setDay] = useState(String(today.getDate()));
  const [month, setMonth] = useState(MONTHS_LIST[today.getMonth()]);
  const [year, setYear] = useState(String(today.getFullYear()));

  const [rows, setRows] = useState<BookingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingCell, setEditingCell] = useState<{ id: number; field: string } | null>(null);
  const [editValue, setEditValue] = useState("");
  const [cellStates, setCellStates] = useState<Record<string, "saving" | "saved" | "error">>({});
  const [patchError, setPatchError] = useState<string | null>(null);
  const [deleteInvoiceInput, setDeleteInvoiceInput] = useState("");
  const [deleteInvoiceState, setDeleteInvoiceState] = useState<"idle" | "confirm" | "deleting">("idle");
  const [whatsappOpen, setWhatsappOpen] = useState(false);
  const [whatsappCopied, setWhatsappCopied] = useState<Record<string, boolean>>({});
  const [whatsappTexts, setWhatsappTexts] = useState<Record<string, string>>({});
  const [whatsappLegs, setWhatsappLegs] = useState<BookingRow[]>([]);
  const [rechecking, setRechecking] = useState(false);
  const [recheckMsg, setRecheckMsg] = useState<string | null>(null);

  const whatsappBlocks = useMemo(
    () => generateWhatsAppBlocks(whatsappLegs.length ? whatsappLegs : rows, rows),
    [whatsappLegs, rows]
  );

  useEffect(() => {
    if (whatsappOpen) {
      const init: Record<string, string> = {};
      for (const b of whatsappBlocks) init[b.key] = b.text;
      setWhatsappTexts(init);
      setWhatsappCopied({});
    }
  }, [whatsappOpen, whatsappBlocks]);
  const allInvoiceNos = useMemo(
    () => [...new Set(rows.map((r) => r.invoiceNo).filter(Boolean))] as string[],
    [rows],
  );

  const router = useRouter();
  const { uploadOpen, setUploadOpen, serviceStatus } = useUploadContext();

  // ── Rules engine recheck ──────────────────────────────────────────────────
  const handleRecheck = async () => {
    setRechecking(true);
    setRecheckMsg(null);
    try {
      const res = await fetch("/api/reassign", { method: "POST" });
      if (!res.ok || !res.body) { setRecheckMsg("❌ Recheck failed"); return; }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data: ")) continue;
          let payload: string;
          try { payload = JSON.parse(line.slice(6)); } catch { continue; }
          if (payload === "[DONE]") setRecheckMsg("✅ Recheck complete");
          else if (payload.startsWith("[ERROR]")) setRecheckMsg(`❌ ${payload.slice(8)}`);
        }
      }
    } catch { setRecheckMsg("❌ Network error"); }
    finally {
      setRechecking(false);
      await fetchRows();
    }
  };

  // ── Date navigation ────────────────────────────────────────────────────────
  function navigateDay(delta: number) {
    const monthNum = MONTHS_LIST.indexOf(month);
    const d = new Date(Number(year), monthNum, Number(day) + delta);
    setDay(String(d.getDate()));
    setMonth(MONTHS_LIST[d.getMonth()]);
    setYear(String(d.getFullYear()));
  }

  // ── Data fetching ──────────────────────────────────────────────────────────
  const fetchRows = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/bookings?day=${encodeURIComponent(day)}&month=${encodeURIComponent(month)}&year=${encodeURIComponent(year)}`
      );
      if (res.ok) {
        const data: BookingRow[] = await res.json();
        setRows(data);
      }
    } finally {
      setLoading(false);
    }
  }, [day, month, year]);

  useEffect(() => { fetchRows(); }, [fetchRows]);


  // Refresh data and navigate to first inserted date after PDF upload
  useEffect(() => {
    const handler = async (e: Event) => {
      const count = (e as CustomEvent<{ count: number }>).detail?.count ?? 0;
      if (count > 0) {
        const navRes = await fetch(`/api/bookings?recentCount=${count}`);
        if (navRes.ok) {
          const recent: BookingRow[] = await navRes.json();
          const first = recent
            .filter((r) => r.day && r.month && r.year)
            .sort((a, b) => (a.travelDate ?? "").localeCompare(b.travelDate ?? ""))[0];
          if (first?.day && first?.month && first?.year) {
            setDay(first.day);
            setMonth(first.month);
            setYear(first.year);
            return;
          }
        }
      }
      await fetchRows();
    };
    window.addEventListener("bookings-uploaded", handler);
    return () => window.removeEventListener("bookings-uploaded", handler);
  }, [fetchRows]);

  // ── Cell editing ───────────────────────────────────────────────────────────
  async function patchRow(id: number, field: string, value: unknown) {
    const key = `${id}-${field}`;
    setCellStates((prev) => ({ ...prev, [key]: "saving" }));
    try {
      const res = await fetch(`/api/bookings/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      });
      if (res.ok) {
        setCellStates((prev) => ({ ...prev, [key]: "saved" }));
        setTimeout(() => setCellStates((prev) => {
          const next = { ...prev }; delete next[key]; return next;
        }), 1000);
        await fetchRows();
      } else if (res.status === 409) {
        const data = await res.json();
        setPatchError(data.error ?? "Double booking conflict — please choose another van.");
        setCellStates((prev) => ({ ...prev, [key]: "error" }));
      } else {
        setCellStates((prev) => ({ ...prev, [key]: "error" }));
      }
    } catch {
      setCellStates((prev) => ({ ...prev, [key]: "error" }));
    }
  }

  // Multi-field patch — sends all updates in one request and reflects them in local state.
  // primaryField controls which cell's save-indicator ring is shown.
  async function patchFields(id: number, updates: Record<string, unknown>, primaryField: string) {
    const key = `${id}-${primaryField}`;
    setCellStates((prev) => ({ ...prev, [key]: "saving" }));
    try {
      const res = await fetch(`/api/bookings/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (res.ok) {
        setCellStates((prev) => ({ ...prev, [key]: "saved" }));
        setTimeout(() => setCellStates((prev) => {
          const next = { ...prev }; delete next[key]; return next;
        }), 1000);
        await fetchRows();
      } else {
        setCellStates((prev) => ({ ...prev, [key]: "error" }));
      }
    } catch {
      setCellStates((prev) => ({ ...prev, [key]: "error" }));
    }
  }

  function startEdit(id: number, field: string, currentValue: string) {
    setEditingCell({ id, field });
    setEditValue(currentValue);
  }

  async function commitEdit() {
    if (!editingCell) return;
    const { id, field } = editingCell;
    setEditingCell(null);
    await patchRow(id, field, editValue);
  }

  async function handleDelete(id: number) {
    if (!confirm("Delete this booking?")) return;
    const res = await fetch(`/api/bookings/${id}`, { method: "DELETE" });
    if (res.ok) { await fetchRows(); router.refresh(); }
  }

  async function handleDeleteByInvoice() {
    const inv = deleteInvoiceInput.trim();
    if (!inv) return;
    if (deleteInvoiceState === "idle") { setDeleteInvoiceState("confirm"); return; }
    setDeleteInvoiceState("deleting");
    try {
      const res = await fetch(`/api/bookings?invoiceNo=${encodeURIComponent(inv)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmInvoiceNo: inv }),
      });
      const data = await res.json();
      if (res.ok) {
        setDeleteInvoiceInput("");
        setDeleteInvoiceState("idle");
        await fetchRows();
        router.refresh();
      } else {
        alert(data.error ?? "Delete failed");
        setDeleteInvoiceState("idle");
      }
    } catch {
      alert("Delete failed");
      setDeleteInvoiceState("idle");
    }
  }

  async function handleAddRow() {
    const res = await fetch("/api/bookings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ day, month, year }),
    });
    if (res.ok) {
      const newRow: BookingRow = await res.json();
      setRows((prev) => [...prev, newRow]);
    }
  }


  // ── Computed ───────────────────────────────────────────────────────────────
  const totalAmount = rows.reduce((sum, r) => sum + parseFloat(r.amount ?? "0"), 0);
  const paidCount = rows.filter((r) => r.paidStatus === "P").length;
  const unpaidCount = rows.filter((r) => r.paidStatus !== "P").length;


  // No-van conflicts: vanId is null, in-house, has an invoice (shouldn't happen after recheck)
  const noVanRows = rows.filter((r) =>
    r.vanId === null &&
    r.invoiceNo &&
    r.inHouseOrOutsourced !== "O" &&
    r.inHouseOrOutsourced !== "outsourced"
  );

  // Outsource needed: marked outsourced by the system but no company name entered yet
  const outsourceNeededRows = rows.filter((r) =>
    (r.inHouseOrOutsourced === "O" || r.inHouseOrOutsourced === "outsourced") &&
    !r.outsourcedCompany?.trim() &&
    r.invoiceNo
  );

  // Double-booked conflicts: same van assigned to multiple bookings on this day
  const doubleBookedRows = (() => {
    const groups = new Map<number, BookingRow[]>();
    for (const r of rows) {
      if (r.vanId == null) continue;
      if (r.inHouseOrOutsourced === "O" || r.inHouseOrOutsourced === "outsourced") continue;
      if (!groups.has(r.vanId)) groups.set(r.vanId, []);
      groups.get(r.vanId)!.push(r);
    }
    return [...groups.values()].filter((g) => g.length > 1).flat();
  })();


  // ── Editable cell components ───────────────────────────────────────────────
  function EditableText({ id, field, value, placeholder }: {
    id: number; field: string; value: string | null; placeholder?: string;
  }) {
    const isEditing = editingCell?.id === id && editingCell?.field === field;
    const saveState = cellStates[`${id}-${field}`];
    const ringClass =
      saveState === "saving" ? "ring-1 ring-zinc-300 animate-pulse" :
      saveState === "saved"  ? "ring-1 ring-green-400" :
      saveState === "error"  ? "ring-1 ring-red-400" : "";
    if (isEditing) {
      return (
        <input
          autoFocus
          className={`w-full border rounded px-1 py-0.5 text-xs bg-white text-zinc-900 ${saveState === "error" ? "border-red-400" : "border-blue-400"}`}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitEdit();
            if (e.key === "Escape") setEditingCell(null);
          }}
        />
      );
    }
    return (
      <span
        className={`cursor-pointer hover:bg-blue-50 rounded px-1 min-w-[40px] inline-block text-xs text-zinc-900 ${ringClass}`}
        onClick={() => startEdit(id, field, value ?? "")}
      >
        {value || <span className="text-zinc-300">{placeholder ?? "—"}</span>}
      </span>
    );
  }

  function EditableSelect({ id, field, value, options }: {
    id: number; field: string; value: string | null; options: string[];
  }) {
    const saveState = cellStates[`${id}-${field}`];
    const borderClass =
      saveState === "saving" ? "border-zinc-300 animate-pulse" :
      saveState === "saved"  ? "border-green-400" :
      saveState === "error"  ? "border-red-400" : "border-zinc-300";
    return (
      <select
        className={`text-xs border ${borderClass} rounded px-1 py-0.5 w-full bg-white text-zinc-900`}
        value={value ?? options[0]}
        onChange={async (e) => { await patchRow(id, field, e.target.value); }}
      >
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }

  // ── Table for a single trip-type group ─────────────────────────────────────
  const COL_HEADERS = [
    "Invoice #", "Client Name", "Client Phone", "Location",
    "Type", "Description", "Van Plate", "Driver Name", "Driver Contact",
    "Tour Guide", "Remarks", "Pax", "Overtime", "I/O", "Outsourced Co.", "Amount (MYR)", "P/U", "",
  ];

  function TripTable({ groupRows }: { groupRows: BookingRow[] }) {
    if (groupRows.length === 0) return null;
    return (
      <div style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 12, overflow: "auto" }}>
        <table className="data-table">
          <thead>
            <tr className="bg-zinc-50 border-b border-zinc-200">
              {COL_HEADERS.map((col, i) => (
                <th
                  key={i}
                  className={`px-3 py-2.5 text-left font-semibold text-zinc-700 whitespace-nowrap${i === COL_HEADERS.length - 1 ? " no-print" : ""}`}
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groupRows.map((row) => (
              <tr key={row.id} className="border-b border-zinc-100 hover:bg-zinc-50">
                {/* Invoice # */}
                <td className="px-3 py-2 font-mono whitespace-nowrap text-zinc-700 min-w-[160px]">
                  {row.invoiceNo || <span className="text-zinc-300">—</span>}
                  {(row.numberOfVehicles ?? 1) > 1 && (
                    <span className="ml-1 text-[10px] text-zinc-400">v{row.vehicleIndex}/{row.numberOfVehicles}</span>
                  )}
                </td>
                {/* Client Name */}
                <td className="px-3 py-2 min-w-[140px]">
                  <EditableText id={row.id} field="clientDetails" value={clientName(row)} placeholder="Client name" />
                </td>
                {/* Client Phone */}
                <td className="px-3 py-2 min-w-[130px] text-zinc-600 whitespace-nowrap">
                  {clientPhone(row) || <span className="text-zinc-300">—</span>}
                </td>
                {/* Location */}
                <td className="px-3 py-2 min-w-[200px] whitespace-nowrap text-zinc-800">
                  {row.toLocation
                    ? `${row.fromLocation} → ${row.toLocation}`
                    : row.fromLocation || "—"}
                </td>
                {/* Trip Type badge */}
                <td className="px-3 py-2 whitespace-nowrap min-w-[110px]">
                  {tripTypeBadge(row.tripType)}
                </td>
                {/* Description */}
                <td className="px-3 py-2 whitespace-nowrap text-zinc-600 text-xs min-w-[90px]">
                  {tripTypeLabel(row.tripType)}
                </td>
                {/* Van Plate */}
                <td className="px-3 py-2 min-w-[110px]">
                  <EditableText id={row.id} field="vehiclePlate" value={row.vehiclePlate} placeholder="—" />
                </td>
                {/* Driver Name */}
                <td className="px-3 py-2 min-w-[140px]">
                  <EditableText id={row.id} field="driverName" value={row.driverName} placeholder="—" />
                </td>
                {/* Driver Contact */}
                <td className="px-3 py-2 min-w-[130px]">
                  <EditableText id={row.id} field="driverContact" value={row.driverContact} placeholder="—" />
                </td>
                {/* Tour Guide */}
                <td className="px-3 py-2 min-w-[120px]">
                  <EditableText id={row.id} field="tourGuide" value={row.tourGuide} placeholder="—" />
                </td>
                {/* Remarks */}
                <td className="px-3 py-2 min-w-[160px]">
                  <EditableText id={row.id} field="details" value={row.details} placeholder="Add remarks…" />
                </td>
                {/* Pax */}
                <td className="px-3 py-2 min-w-[72px]">
                  <input
                    type="number"
                    min="0"
                    className={`w-full border rounded px-1 py-0.5 text-xs text-zinc-900 bg-white ${
                      cellStates[`${row.id}-passengerCount`] === "saving" ? "border-zinc-300 animate-pulse" :
                      cellStates[`${row.id}-passengerCount`] === "saved"  ? "border-green-400" :
                      cellStates[`${row.id}-passengerCount`] === "error"  ? "border-red-400" : "border-zinc-300"
                    }`}
                    key={`pax-${row.id}`}
                    defaultValue={row.passengerCount ?? ""}
                    onBlur={(e) => patchRow(row.id, "passengerCount", e.target.value !== "" ? parseInt(e.target.value) : null)}
                  />
                </td>
                {/* Overtime */}
                <td className="px-3 py-2 min-w-[96px]">
                  <EditableSelect id={row.id} field="overtime" value={row.overtime ?? "0"} options={OVERTIME_OPTIONS} />
                </td>
                {/* I/O */}
                <td className="px-3 py-2 min-w-[80px]">
                  {(() => {
                    const ioVal = row.inHouseOrOutsourced === "outsourced" ? "O" : (row.inHouseOrOutsourced ?? "I");
                    const saving = cellStates[`${row.id}-inHouseOrOutsourced`] === "saving";
                    const saved  = cellStates[`${row.id}-inHouseOrOutsourced`] === "saved";
                    const handleIO = async (val: string) => {
                      if (val === ioVal) return;
                      if (val === "O") {
                        await patchFields(row.id, {
                          inHouseOrOutsourced: "O",
                          vanId: null,
                          vehiclePlate: null,
                          driverName: null,
                          driverContact: null,
                        }, "inHouseOrOutsourced");
                      } else {
                        await patchFields(row.id, {
                          inHouseOrOutsourced: "I",
                          outsourcedCompany: "",
                          manualChange: 0,
                        }, "inHouseOrOutsourced");
                        const res = await fetch(`/api/bookings/${row.id}/reassign`, { method: "POST" });
                        if (res.ok) {
                          await fetchRows();
                        }
                      }
                    };
                    return (
                      <div className={`inline-flex rounded border text-xs font-semibold overflow-hidden ${saving ? "opacity-50 pointer-events-none" : ""} ${saved ? "border-green-400" : "border-zinc-300"}`}>
                        <button
                          type="button"
                          onClick={() => handleIO("I")}
                          className={`px-2.5 py-1 leading-none transition-colors ${ioVal === "I" ? "bg-blue-600 text-white" : "bg-white text-zinc-500 hover:bg-zinc-100"}`}
                        >I</button>
                        <button
                          type="button"
                          onClick={() => handleIO("O")}
                          className={`px-2.5 py-1 leading-none border-l border-zinc-300 transition-colors ${ioVal === "O" ? "bg-orange-500 text-white" : "bg-white text-zinc-500 hover:bg-zinc-100"}`}
                        >O</button>
                      </div>
                    );
                  })()}
                </td>
                {/* Outsourced Company + Reason */}
                <td className="px-3 py-2 min-w-[150px]">
                  {(row.inHouseOrOutsourced === "O" || row.inHouseOrOutsourced === "outsourced") ? (
                    <div className="flex flex-col gap-1">
                      <input
                        className={`w-full border rounded px-1 py-0.5 text-xs text-zinc-900 bg-white ${
                          cellStates[`${row.id}-outsourcedCompany`] === "saving" ? "border-zinc-300 animate-pulse" :
                          cellStates[`${row.id}-outsourcedCompany`] === "saved"  ? "border-green-400" : "border-zinc-300"
                        }`}
                        defaultValue={row.outsourcedCompany ?? ""}
                        placeholder={row.vehicleCategory === "Alphard" ? "Alphard company" : row.vehicleCategory === "Car" ? "Car company" : "Company name"}
                        key={`oc-${row.id}`}
                        onBlur={(e) => patchRow(row.id, "outsourcedCompany", e.target.value)}
                      />
                      {row.outsourceReason && (
                        <span className="text-[10px] text-orange-500 leading-tight">{row.outsourceReason}</span>
                      )}
                    </div>
                  ) : (
                    <span className="text-xs text-zinc-300 px-1">—</span>
                  )}
                </td>
                {/* Amount */}
                <td className="px-3 py-2 min-w-[110px]">
                  <EditableText id={row.id} field="amount" value={row.amount} />
                </td>
                {/* Paid Status */}
                <td className="px-3 py-2 min-w-[68px]">
                  <EditableSelect id={row.id} field="paidStatus" value={row.paidStatus} options={["U", "P"]} />
                </td>
                {/* Delete */}
                <td className="px-3 py-2 no-print">
                  <button
                    onClick={() => handleDelete(row.id)}
                    className="text-red-400 hover:text-red-600 font-bold text-base leading-none px-1"
                    title="Delete row"
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  const fullDateLabel = formatFullDate(day, month, year);
  const shortDateLabel = formatShortDate(day, month, year);

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-base)" }}>
      <style>{`
        @media print {
          .no-print { display: none !important; }
          @page { size: A3 landscape; margin: 10mm; }
          body { background: white; }
          table { font-size: 10px; }
        }
      `}</style>

      <main className="px-4 py-6 space-y-4">

        {/* Top bar — date nav + actions */}
        <div className="flex gap-3 items-end flex-wrap no-print">
          {/* Prev arrow */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => navigateDay(-1)}
              className="btn btn-secondary"
              style={{ width: 34, padding: 0, fontFamily: "var(--font-mono)" }}
              title="Previous day"
            >
              ←
            </button>
          </div>

          {/* Day selector */}
          <div className="flex flex-col gap-1">
            <label style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-muted)", letterSpacing: "0.08em", textTransform: "uppercase" }}>Day</label>
            <select
              className="input-base"
              style={{ height: 34, padding: "0 10px" }}
              value={day}
              onChange={(e) => setDay(e.target.value)}
            >
              {DAYS_LIST.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-muted)", letterSpacing: "0.08em", textTransform: "uppercase" }}>Month</label>
            <select
              className="input-base"
              style={{ height: 34, padding: "0 10px" }}
              value={month}
              onChange={(e) => setMonth(e.target.value)}
            >
              {MONTHS_LIST.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-muted)", letterSpacing: "0.08em", textTransform: "uppercase" }}>Year</label>
            <select
              className="input-base"
              style={{ height: 34, padding: "0 10px" }}
              value={year}
              onChange={(e) => setYear(e.target.value)}
            >
              {YEARS_LIST.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>

          {/* Next arrow */}
          <button
            onClick={() => navigateDay(1)}
            className="btn btn-secondary"
            style={{ width: 34, padding: 0, fontFamily: "var(--font-mono)", alignSelf: "flex-end" }}
            title="Next day"
          >
            →
          </button>

          <div className="flex gap-2 ml-2 self-end flex-wrap">
            <button onClick={() => setUploadOpen(true)} className="btn btn-secondary">
              ↑ Upload PDF
            </button>
            <button onClick={handleAddRow} className="btn btn-secondary">
              + Add Row
            </button>
            <button
              onClick={handleRecheck}
              disabled={rechecking}
              className="btn"
              style={{
                background: "rgba(88,166,255,0.1)", border: "1px solid rgba(88,166,255,0.3)",
                color: "var(--blue)",
              }}
              title="Re-run rules engine"
            >
              {rechecking ? (
                <svg className="spin" style={{ width: 13, height: 13 }} viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" opacity="0.25"/>
                  <path fill="currentColor" opacity="0.75" d="M4 12a8 8 0 018-8v8z"/>
                </svg>
              ) : (
                <svg style={{ width: 13, height: 13 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              )}
              {rechecking ? "Rechecking…" : "Recheck"}
            </button>
            {recheckMsg && (
              <span style={{
                fontSize: 11, fontFamily: "var(--font-mono)", alignSelf: "center",
                color: recheckMsg.startsWith("✅") ? "var(--green)" : "var(--red)",
              }}>
                {recheckMsg}
              </span>
            )}
            <button
              onClick={async () => {
                const invoiceSet = new Set(rows.map(r => r.invoiceNo).filter(Boolean));
                try {
                  const res = await fetch("/api/bookings");
                  if (res.ok) {
                    const all: BookingRow[] = await res.json();
                    const legs = all.filter(r => r.invoiceNo && invoiceSet.has(r.invoiceNo));
                    setWhatsappLegs(legs.length ? legs : rows);
                  } else { setWhatsappLegs(rows); }
                } catch { setWhatsappLegs(rows); }
                setWhatsappOpen(true);
              }}
              className="btn"
              style={{ background: "rgba(63,185,80,0.12)", border: "1px solid rgba(63,185,80,0.3)", color: "var(--green)" }}
            >
              📱 WhatsApp
            </button>
            <button
              onClick={() => window.print()}
              className="btn btn-secondary"
            >
              Print PDF
            </button>
            {/* Delete by invoice number */}
            <div style={{
              display: "flex", alignItems: "center",
              border: "1px solid rgba(248,81,73,0.3)", borderRadius: 6,
              overflow: "hidden", background: "var(--bg-muted)",
            }}>
              <datalist id="delete-inv-list">
                {allInvoiceNos.map((inv) => <option key={inv} value={inv} />)}
              </datalist>
              <input
                type="text"
                list="delete-inv-list"
                placeholder="Invoice # to delete"
                value={deleteInvoiceInput}
                onChange={(e) => { setDeleteInvoiceInput(e.target.value); setDeleteInvoiceState("idle"); }}
                onKeyDown={(e) => { if (e.key === "Enter") handleDeleteByInvoice(); if (e.key === "Escape") { setDeleteInvoiceInput(""); setDeleteInvoiceState("idle"); } }}
                style={{
                  height: 34, padding: "0 10px", fontSize: 12,
                  background: "transparent", border: "none", outline: "none",
                  color: "var(--text-primary)", width: 156,
                  fontFamily: "var(--font-mono)",
                }}
              />
              <button
                onClick={handleDeleteByInvoice}
                disabled={!deleteInvoiceInput.trim() || deleteInvoiceState === "deleting"}
                style={{
                  height: 34, padding: "0 10px", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap",
                  border: "none", cursor: deleteInvoiceInput.trim() ? "pointer" : "not-allowed",
                  background: deleteInvoiceState === "confirm" ? "var(--red)"
                    : deleteInvoiceState === "deleting" ? "rgba(248,81,73,0.5)"
                    : "transparent",
                  color: deleteInvoiceState === "confirm" ? "#fff" : "var(--red)",
                  transition: "all 0.15s",
                }}
              >
                {deleteInvoiceState === "confirm" ? "Confirm?" : deleteInvoiceState === "deleting" ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>

        {/* Date heading */}
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h2 style={{ fontFamily: "var(--font-display)", fontSize: 20, fontWeight: 700, color: "var(--text-primary)", margin: 0 }}>
            {fullDateLabel}
          </h2>
          <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>{shortDateLabel}</span>
        </div>

        {/* Print heading */}
        <div className="text-sm font-semibold text-zinc-900 hidden print:block">
          Daily Jobs Record — {fullDateLabel}
        </div>


        {/* Inline patch error */}
        {patchError && (
          <div className="alert alert-warn fade-up" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span>⚠ {patchError}</span>
            <button onClick={() => setPatchError(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--amber)", fontSize: 18 }}>×</button>
          </div>
        )}

        {/* Conflict banner */}
        {!loading && (noVanRows.length > 0 || outsourceNeededRows.length > 0 || doubleBookedRows.length > 0) && (
          <div className="alert alert-error fade-up" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase" }}>
              ⚠ CONFLICT — {noVanRows.length + outsourceNeededRows.length + doubleBookedRows.length} issue{noVanRows.length + outsourceNeededRows.length + doubleBookedRows.length !== 1 ? "s" : ""}
            </div>
            {(() => {
              const alphardOut = outsourceNeededRows.filter((r) => r.vehicleCategory === "Alphard");
              const carOut = outsourceNeededRows.filter((r) => r.vehicleCategory === "Car");
              const vanOut = outsourceNeededRows.filter((r) => r.vehicleCategory !== "Alphard" && r.vehicleCategory !== "Car");
              return <>
                {alphardOut.length > 0 && (
                  <div className="text-xs text-red-700 pl-4">
                    🚐 <strong>Outsource (Alphard)</strong> — {alphardOut.length} booking{alphardOut.length !== 1 ? "s" : ""} need outsource company
                    {alphardOut.map((r) => (
                      <div key={`oa-${r.id}`} className="pl-4">• {r.fromLocation}{r.toLocation ? ` → ${r.toLocation}` : ""}</div>
                    ))}
                  </div>
                )}
                {carOut.length > 0 && (
                  <div className="text-xs text-red-700 pl-4">
                    🚗 <strong>Outsource (Car)</strong> — {carOut.length} booking{carOut.length !== 1 ? "s" : ""} need outsource company
                    {carOut.map((r) => (
                      <div key={`oc-${r.id}`} className="pl-4">• {r.fromLocation}{r.toLocation ? ` → ${r.toLocation}` : ""}</div>
                    ))}
                  </div>
                )}
                {vanOut.length > 0 && (
                  <div className="text-xs text-red-700 pl-4">
                    🚐 <strong>Outsource (Van)</strong> — {vanOut.length} booking{vanOut.length !== 1 ? "s" : ""} need outsource company
                    {vanOut.map((r) => (
                      <div key={`on-${r.id}`} className="pl-4">• {r.fromLocation}{r.toLocation ? ` → ${r.toLocation}` : ""}</div>
                    ))}
                  </div>
                )}
              </>;
            })()}
            {noVanRows.map((r) => (
              <div key={r.id} className="text-xs text-red-700 pl-4">
                • {r.travelDate} | {r.fromLocation} → {r.toLocation} | {tripTypeLabel(r.tripType)} | <strong>NO VAN ASSIGNED</strong>
              </div>
            ))}
            {doubleBookedRows.map((r) => (
              <div key={`db-${r.id}`} className="text-xs text-red-700 pl-4">
                • {r.travelDate} | {r.fromLocation} → {r.toLocation} | {tripTypeLabel(r.tripType)} | <strong>DOUBLE-BOOKED — {r.vehiclePlate ?? `Van #${r.vanId}`}</strong>
              </div>
            ))}
          </div>
        )}

        {/* Summary bar */}
        {!loading && (
          <div className="no-print" style={{
            display: "flex", gap: 20, fontSize: 12, fontFamily: "var(--font-mono)",
            background: "var(--bg-surface)", border: "1px solid var(--border)",
            borderRadius: 8, padding: "8px 16px", width: "fit-content",
            color: "var(--text-secondary)",
          }}>
            <span>Rows: <strong style={{ color: "var(--text-primary)" }}>{rows.length}</strong></span>
            <span>Total: <strong style={{ color: "var(--amber)" }}>MYR {totalAmount.toFixed(2)}</strong></span>
            <span>Paid: <strong style={{ color: "var(--green)" }}>{paidCount}</strong></span>
            <span>Unpaid: <strong style={{ color: "var(--red)" }}>{unpaidCount}</strong></span>
          </div>
        )}

        {/* WhatsApp export modal */}
        {whatsappOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center no-print" style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }} onClick={() => setWhatsappOpen(false)}>
            <div className="fade-up" style={{
              background: "var(--bg-elevated)", border: "1px solid var(--border)",
              borderRadius: 14, width: "100%", maxWidth: 520,
              margin: "0 16px", display: "flex", flexDirection: "column",
              maxHeight: "90vh", boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
            }} onClick={(e) => e.stopPropagation()}>
              {/* Header */}
              <div style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "14px 18px",
                borderBottom: "1px solid var(--border)",
                background: "rgba(63,185,80,0.06)",
                flexShrink: 0, borderRadius: "14px 14px 0 0",
              }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14, color: "var(--text-primary)" }}>📱 WhatsApp Schedule</div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2, fontFamily: "var(--font-mono)" }}>{fullDateLabel}</div>
                </div>
                <button onClick={() => setWhatsappOpen(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: 20 }}>×</button>
              </div>
              {/* Scrollable job blocks */}
              <div style={{ overflowY: "auto", flex: 1, padding: "16px 18px", display: "flex", flexDirection: "column", gap: 14 }}>
                {whatsappBlocks.length === 0 && (
                  <div style={{ textAlign: "center", padding: "32px 0", fontSize: 13, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>No bookings</div>
                )}
                {whatsappBlocks.map((block) => (
                  <div key={block.key} style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", background: "var(--bg-muted)", borderBottom: "1px solid var(--border)" }}>
                      <span style={{ fontSize: 11, fontWeight: 600, fontFamily: "var(--font-mono)", color: "var(--text-secondary)" }}>{block.label}</span>
                      <button
                        onClick={async () => {
                          await navigator.clipboard.writeText(whatsappTexts[block.key] ?? block.text);
                          setWhatsappCopied(prev => ({ ...prev, [block.key]: true }));
                          setTimeout(() => setWhatsappCopied(prev => ({ ...prev, [block.key]: false })), 2500);
                        }}
                        style={{
                          fontSize: 11, fontWeight: 600, padding: "4px 12px", borderRadius: 6,
                          background: whatsappCopied[block.key] ? "rgba(63,185,80,0.3)" : "rgba(63,185,80,0.12)",
                          border: "1px solid rgba(63,185,80,0.4)", color: "var(--green)",
                          cursor: "pointer", transition: "all 0.15s",
                        }}
                      >
                        {whatsappCopied[block.key] ? "✓ Copied!" : "Copy"}
                      </button>
                    </div>
                    <textarea
                      style={{ width: "100%", fontSize: 12, fontFamily: "var(--font-mono)", background: "var(--bg-surface)", color: "var(--text-primary)", padding: 12, resize: "none", border: "none", outline: "none" }}
                      rows={10}
                      value={whatsappTexts[block.key] ?? block.text}
                      onChange={(e) => setWhatsappTexts(prev => ({ ...prev, [block.key]: e.target.value }))}
                    />
                  </div>
                ))}
              </div>
              {/* Footer */}
              <div className="px-5 py-3 border-t border-zinc-200 shrink-0">
                <button
                  onClick={() => setWhatsappOpen(false)}
                  className="btn btn-secondary"
                  style={{ width: "100%" }}
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Trip-type tables */}
        {loading ? (
          <div style={{ textAlign: "center", padding: "80px 0", fontSize: 13, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 48, textAlign: "center", fontSize: 13, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
            No bookings for {fullDateLabel}
          </div>
        ) : (
          <TripTable groupRows={rows} />
        )}
      </main>
    </div>
  );
}
