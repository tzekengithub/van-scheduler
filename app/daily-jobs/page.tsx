"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";

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
  day: string | null;
  month: string | null;
  year: string | null;
  tripType: TripType | null;
  tourGuide: string | null;
  vehicleIndex: number | null;
  numberOfVehicles: number | null;
}

interface PreviewBooking {
  travelDate: string;
  day: string;
  month: string;
  year: string;
  invoiceNo: string;
  clientDetails: string;
  details: string;
  fromLocation: string;
  toLocation: string;
  numberOfVehicles: number;
  vehicleIndex: number;
  amount: number;
  tripType: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function clientName(row: BookingRow): string {
  return (row.clientDetails ?? "").split("\n")[0].trim();
}

function clientPhone(row: BookingRow): string {
  return (row.clientDetails ?? "").split("\n")[1]?.trim() ?? "";
}

function tripTypeBadge(t: TripType | null) {
  switch (t) {
    case "one_way_ride":
      return <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-blue-100 text-blue-800 whitespace-nowrap">🔵 One Way</span>;
    case "round_trip":
      return <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-green-100 text-green-800 whitespace-nowrap">🟢 Round Trip</span>;
    case "day_trip":
      return <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-yellow-100 text-yellow-800 whitespace-nowrap">🟡 Day Trip</span>;
    case "trip":
    default:
      return <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-orange-100 text-orange-800 whitespace-nowrap">🟠 Trip</span>;
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

  // Upload zone
  const [uploadOpen, setUploadOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [previewRows, setPreviewRows] = useState<PreviewBooking[] | null>(null);
  const [parsing, setParsing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [serviceStatus, setServiceStatus] = useState<"unknown" | "cold" | "starting" | "ready" | "error">("unknown");
  const [countdown, setCountdown] = useState(0);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

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

  useEffect(() => {
    const checkIfWarm = async () => {
      const serviceUrl = process.env.NEXT_PUBLIC_PDF_SERVICE_URL;
      if (!serviceUrl) { setServiceStatus("cold"); return; }
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      try {
        const res = await fetch(`${serviceUrl}/health`, { signal: controller.signal });
        clearTimeout(timeoutId);
        setServiceStatus(res.ok ? "ready" : "cold");
      } catch {
        clearTimeout(timeoutId);
        setServiceStatus("cold");
      }
    };
    checkIfWarm();
  }, []);

  useEffect(() => {
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

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
        setRows((prev) => prev.map((r) => r.id === id ? { ...r, [field]: value } : r));
        setCellStates((prev) => ({ ...prev, [key]: "saved" }));
        setTimeout(() => setCellStates((prev) => {
          const next = { ...prev }; delete next[key]; return next;
        }), 1000);
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
        setRows((prev) => prev.map((r) => r.id === id ? { ...r, ...updates } : r));
        setCellStates((prev) => ({ ...prev, [key]: "saved" }));
        setTimeout(() => setCellStates((prev) => {
          const next = { ...prev }; delete next[key]; return next;
        }), 1000);
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
    if (res.ok) await fetchRows();
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

  // ── Upload ─────────────────────────────────────────────────────────────────
  async function handleFilesSelected(files: File[]) {
    setUploadFiles(files);
    setPreviewRows(null);
    setUploadError(null);
    if (files.length === 0) return;
    setParsing(true);
    try {
      const allBookings: PreviewBooking[] = [];
      for (const file of files) {
        const formData = new FormData();
        formData.append("file", file);
        const res = await fetch("/api/preview", { method: "POST", body: formData });
        if (res.ok) {
          const { bookings } = await res.json();
          allBookings.push(...bookings);
        } else {
          const err = await res.json().catch(() => ({}));
          setUploadError(err.error ?? `Failed to parse ${file.name}`);
          return;
        }
      }
      setPreviewRows(allBookings);
    } finally {
      setParsing(false);
    }
  }

  async function handleConfirmUpload() {
    if (uploadFiles.length === 0) return;
    setConfirming(true);
    try {
      let totalCount = 0;
      for (const file of uploadFiles) {
        const formData = new FormData();
        formData.append("file", file);
        const res = await fetch("/api/upload", { method: "POST", body: formData });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          setUploadError(err.error ?? `Upload failed for ${file.name}`);
          return;
        }
        const data = await res.json();
        totalCount += data.inserted ?? 0;
      }
      setUploadOpen(false);
      setUploadFiles([]);
      setPreviewRows(null);
      setUploadError(null);
      // Navigate to first inserted booking's date
      const navRes = await fetch(`/api/bookings?recentCount=${totalCount}`);
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
      await fetchRows();
    } finally {
      setConfirming(false);
    }
  }

  function handleCancelUpload() {
    setUploadFiles([]);
    setPreviewRows(null);
    setUploadError(null);
    setUploadOpen(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  const startService = async () => {
    setServiceStatus("starting");
    setCountdown(60);
    const serviceUrl = process.env.NEXT_PUBLIC_PDF_SERVICE_URL;
    if (!serviceUrl) { setServiceStatus("error"); return; }
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) { if (timerRef.current) clearInterval(timerRef.current); return 0; }
        return prev - 1;
      });
    }, 1000);
    for (let attempts = 0; attempts < 20; attempts++) {
      await new Promise((r) => setTimeout(r, 3000));
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      try {
        const res = await fetch(`${serviceUrl}/health`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (res.ok) {
          if (timerRef.current) clearInterval(timerRef.current);
          setCountdown(0);
          setServiceStatus("ready");
          return;
        }
      } catch { clearTimeout(timeoutId); }
    }
    if (timerRef.current) clearInterval(timerRef.current);
    setServiceStatus("error");
  };

  // ── Computed ───────────────────────────────────────────────────────────────
  const totalAmount = rows.reduce((sum, r) => sum + parseFloat(r.amount ?? "0"), 0);
  const paidCount = rows.filter((r) => r.paidStatus === "P").length;
  const unpaidCount = rows.filter((r) => r.paidStatus !== "P").length;


  // No-van conflicts: vanId is null (unassigned due to insufficient vans)
  const noVanRows = rows.filter((r) =>
    r.vanId === null &&
    r.invoiceNo &&
    r.inHouseOrOutsourced !== "O" &&
    r.inHouseOrOutsourced !== "outsourced"
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
    "Tour Guide", "Pax", "Overtime", "I/O", "Outsourced Co.", "Amount (MYR)", "P/U", "",
  ];

  function TripTable({ groupRows }: { groupRows: BookingRow[] }) {
    if (groupRows.length === 0) return null;
    return (
      <div className="bg-white rounded-xl border border-zinc-200 overflow-auto shadow-sm">
        <table className="w-full text-xs border-collapse">
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
                <td className="px-3 py-2 font-mono whitespace-nowrap text-zinc-700 min-w-[110px]">
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
                          const updated = await res.json();
                          setRows((prev) => prev.map((r) => r.id === row.id ? { ...r, ...updated } : r));
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
                {/* Outsourced Company */}
                <td className="px-3 py-2 min-w-[150px]">
                  {(row.inHouseOrOutsourced === "O" || row.inHouseOrOutsourced === "outsourced") ? (
                    <input
                      className={`w-full border rounded px-1 py-0.5 text-xs text-zinc-900 bg-white ${
                        cellStates[`${row.id}-outsourcedCompany`] === "saving" ? "border-zinc-300 animate-pulse" :
                        cellStates[`${row.id}-outsourcedCompany`] === "saved"  ? "border-green-400" : "border-zinc-300"
                      }`}
                      defaultValue={row.outsourcedCompany ?? ""}
                      placeholder="Company name"
                      key={`oc-${row.id}`}
                      onBlur={(e) => patchRow(row.id, "outsourcedCompany", e.target.value)}
                    />
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
    <div className="min-h-screen bg-zinc-50 font-sans">
      <style>{`
        @media print {
          .no-print { display: none !important; }
          @page { size: A3 landscape; margin: 10mm; }
          body { background: white; }
          table { font-size: 10px; }
        }
      `}</style>

      {/* Header */}
      <header className="bg-white border-b border-zinc-200 px-6 py-4 no-print">
        <div className="max-w-full mx-auto flex items-center justify-between">
          <h1 className="text-xl font-semibold text-zinc-900">Daily Jobs Record</h1>
          <nav className="flex gap-4 text-sm font-medium">
            <Link href="/" className="text-zinc-500 hover:text-zinc-900 transition-colors">Dashboard</Link>
            <Link href="/all-jobs" className="text-zinc-500 hover:text-zinc-900 transition-colors">All Jobs</Link>
            <Link href="/van-schedule" className="text-zinc-500 hover:text-zinc-900 transition-colors">Van Schedule</Link>
            <span className="text-zinc-900 border-b-2 border-zinc-900 pb-0.5">Daily Jobs</span>
          </nav>
        </div>
      </header>

      <main className="px-4 py-6 space-y-4">

        {/* Top bar — date nav + actions */}
        <div className="flex gap-3 items-end flex-wrap no-print">
          {/* Prev/next arrows */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => navigateDay(-1)}
              className="w-8 h-9 flex items-center justify-center rounded-lg border border-zinc-300 bg-white hover:bg-zinc-50 text-zinc-700 font-bold"
              title="Previous day"
            >
              ←
            </button>
          </div>

          {/* Day selector */}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Day</label>
            <select
              className="h-9 px-3 rounded-lg border border-zinc-300 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-400"
              value={day}
              onChange={(e) => setDay(e.target.value)}
            >
              {DAYS_LIST.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Month</label>
            <select
              className="h-9 px-3 rounded-lg border border-zinc-300 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-400"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
            >
              {MONTHS_LIST.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Year</label>
            <select
              className="h-9 px-3 rounded-lg border border-zinc-300 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-400"
              value={year}
              onChange={(e) => setYear(e.target.value)}
            >
              {YEARS_LIST.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>

          {/* Next arrow */}
          <button
            onClick={() => navigateDay(1)}
            className="w-8 h-9 flex items-center justify-center rounded-lg border border-zinc-300 bg-white hover:bg-zinc-50 text-zinc-700 font-bold self-end"
            title="Next day"
          >
            →
          </button>

          <div className="flex gap-2 ml-2 self-end">
            <button
              onClick={() => setUploadOpen(true)}
              disabled={serviceStatus !== "ready"}
              title={serviceStatus !== "ready" ? "Click Start PDF Service first" : ""}
              className={`h-9 px-4 rounded-lg text-sm font-medium transition-colors ${
                serviceStatus === "ready"
                  ? "border border-zinc-300 bg-white text-zinc-900 hover:bg-zinc-50"
                  : "bg-gray-200 text-gray-400 cursor-not-allowed"
              }`}
            >
              Upload Invoice PDF
            </button>
            <button
              onClick={handleAddRow}
              className="h-9 px-4 rounded-lg border border-zinc-300 bg-white text-sm font-medium text-zinc-900 hover:bg-zinc-50 transition-colors"
            >
              + Add Row
            </button>
            <button
              onClick={() => window.print()}
              className="h-9 px-4 rounded-lg bg-zinc-900 text-white text-sm font-medium hover:bg-zinc-700 transition-colors"
            >
              Print as PDF
            </button>
          </div>
        </div>

        {/* Date heading */}
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-bold text-zinc-900">
            📅 {fullDateLabel}
          </h2>
          <span className="text-xs text-zinc-400">{shortDateLabel}</span>
        </div>

        {/* Print heading */}
        <div className="text-sm font-semibold text-zinc-900 hidden print:block">
          Daily Jobs Record — {fullDateLabel}
        </div>

        {/* PDF Service status bar */}
        <div className="no-print">
          {serviceStatus === "unknown" && (
            <div className="flex items-center gap-3 p-3 bg-gray-50 border border-gray-200 rounded-lg">
              <div className="w-2 h-2 rounded-full bg-gray-400" />
              <span className="text-sm text-gray-500">Checking PDF service...</span>
            </div>
          )}
          {serviceStatus === "cold" && (
            <div className="flex items-center gap-3 p-3 bg-amber-50 border border-amber-200 rounded-lg">
              <div className="w-2 h-2 rounded-full bg-amber-400" />
              <span className="text-sm text-amber-700">PDF service is sleeping</span>
              <button
                onClick={startService}
                className="ml-auto px-4 py-1.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700"
              >
                Start PDF Service
              </button>
            </div>
          )}
          {serviceStatus === "starting" && (
            <div className="flex items-center gap-3 p-3 bg-amber-50 border border-amber-200 rounded-lg">
              <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
              <span className="text-sm text-amber-700">Starting PDF service...</span>
              <span className="ml-auto text-sm font-mono text-amber-600">{countdown}s</span>
            </div>
          )}
          {serviceStatus === "ready" && (
            <div className="flex items-center gap-3 p-3 bg-green-50 border border-green-200 rounded-lg">
              <div className="w-2 h-2 rounded-full bg-green-500" />
              <span className="text-sm text-green-700">PDF service ready — you can upload invoices</span>
            </div>
          )}
          {serviceStatus === "error" && (
            <div className="flex items-center gap-3 p-3 bg-red-50 border border-red-200 rounded-lg">
              <div className="w-2 h-2 rounded-full bg-red-500" />
              <span className="text-sm text-red-700">PDF service failed to start — try again</span>
              <button
                onClick={startService}
                className="ml-auto px-4 py-1.5 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700"
              >
                Retry
              </button>
            </div>
          )}
        </div>

        {/* Upload zone */}
        {uploadOpen && (
          <div className="no-print bg-white rounded-xl border border-zinc-200 shadow-sm p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-zinc-900">Upload Invoice PDF</h2>
              <button onClick={handleCancelUpload} className="text-zinc-400 hover:text-zinc-700 text-lg font-bold">×</button>
            </div>

            {uploadFiles.length === 0 && (
              <div
                className={`border-2 border-dashed rounded-lg p-10 text-center cursor-pointer transition-colors ${
                  dragOver ? "border-zinc-500 bg-zinc-50" : "border-zinc-300 hover:border-zinc-400"
                }`}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  const files = Array.from(e.dataTransfer.files).filter((f) => f.type === "application/pdf");
                  if (files.length > 0) handleFilesSelected(files);
                }}
                onClick={() => fileInputRef.current?.click()}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    if (files.length > 0) handleFilesSelected(files);
                  }}
                />
                <p className="text-sm text-zinc-500">Drop one or more PDFs here, or click to select</p>
                <p className="text-xs text-zinc-400 mt-1">Invoice PDFs only</p>
              </div>
            )}

            {parsing && (
              <div className="flex items-center gap-3 py-6 justify-center text-zinc-500 text-sm">
                <svg className="animate-spin h-5 w-5 text-zinc-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                </svg>
                Parsing PDF…
              </div>
            )}

            {uploadError && (
              <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800 mt-3">
                {uploadError}
              </div>
            )}

            {previewRows && previewRows.length > 0 && (
              <div className="mt-4">
                <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">
                  Preview — {previewRows.length} row{previewRows.length !== 1 ? "s" : ""} found
                </p>
                <div className="overflow-auto rounded-lg border border-zinc-200">
                  <table className="w-full text-xs border-collapse">
                    <thead>
                      <tr className="bg-zinc-50 border-b border-zinc-200">
                        {["Date", "Invoice #", "Client", "Route", "Type", "Veh", "Amount (MYR)"].map((h) => (
                          <th key={h} className="px-3 py-2 text-left font-semibold text-zinc-600 whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {previewRows.map((r, i) => (
                        <tr key={i} className="border-b border-zinc-100">
                          <td className="px-3 py-1.5 text-zinc-900 whitespace-nowrap">{r.day} {r.month} {r.year}</td>
                          <td className="px-3 py-1.5 text-zinc-500 font-mono whitespace-nowrap">{r.invoiceNo}</td>
                          <td className="px-3 py-1.5 text-zinc-900">{(r.clientDetails ?? "").split("\n")[0]}</td>
                          <td className="px-3 py-1.5 text-zinc-900 whitespace-nowrap">{r.fromLocation} → {r.toLocation}</td>
                          <td className="px-3 py-1.5">{tripTypeBadge(r.tripType as TripType)}</td>
                          <td className="px-3 py-1.5 text-zinc-500 text-center">
                            {(r.numberOfVehicles ?? 1) > 1 ? `v${r.vehicleIndex}/${r.numberOfVehicles}` : "1"}
                          </td>
                          <td className="px-3 py-1.5 text-zinc-900 font-mono">{Number(r.amount).toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex gap-2 mt-4">
                  <button
                    onClick={handleConfirmUpload}
                    disabled={confirming}
                    className="h-9 px-5 rounded-lg bg-zinc-900 text-white text-sm font-medium hover:bg-zinc-700 disabled:opacity-50"
                  >
                    {confirming ? "Inserting…" : `Confirm — Insert ${previewRows.length} row${previewRows.length !== 1 ? "s" : ""}`}
                  </button>
                  <button
                    onClick={handleCancelUpload}
                    className="h-9 px-4 rounded-lg border border-zinc-300 bg-white text-sm font-medium text-zinc-700 hover:bg-zinc-50"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {previewRows && previewRows.length === 0 && !parsing && (
              <div className="mt-3 text-sm text-zinc-500">No bookings found in this PDF. Check the file format.</div>
            )}
          </div>
        )}

        {/* Conflict banner */}
        {!loading && (noVanRows.length > 0 || doubleBookedRows.length > 0) && (
          <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 space-y-1">
            <div className="font-bold text-red-800 text-sm">
              ⚠️ CONFLICT — {noVanRows.length + doubleBookedRows.length} issue{noVanRows.length + doubleBookedRows.length !== 1 ? "s" : ""} found
            </div>
            {noVanRows.map((r) => (
              <div key={r.id} className="text-xs text-red-700 pl-4">
                • {r.travelDate} | {r.fromLocation} → {r.toLocation} | {tripTypeLabel(r.tripType)} | <strong>NO VAN ASSIGNED — REQUIRES OUTSOURCED COMPANY</strong>
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
          <div className="no-print flex gap-6 text-sm text-zinc-900 bg-white rounded-lg border border-zinc-200 px-4 py-2 w-fit">
            <span>Rows: <strong>{rows.length}</strong></span>
            <span>Total: <strong>MYR {totalAmount.toFixed(2)}</strong></span>
            <span>Paid: <strong className="text-green-600">{paidCount}</strong></span>
            <span>Unpaid: <strong className="text-red-500">{unpaidCount}</strong></span>
          </div>
        )}

        {/* Trip-type tables */}
        {loading ? (
          <div className="text-center py-20 text-zinc-400 text-sm">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="bg-white rounded-xl border border-zinc-200 p-12 text-center text-zinc-400 text-sm">
            No bookings for {fullDateLabel}
          </div>
        ) : (
          <TripTable groupRows={rows} />
        )}
      </main>
    </div>
  );
}
