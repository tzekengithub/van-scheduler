"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useUploadContext } from "@/app/upload-context";

const MONTHS_LIST = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];
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
  isAlphardTrip: number | null;
  tourGuide: string | null;
  vehicleIndex: number | null;
  numberOfVehicles: number | null;
  vehicleCategory: string | null;
}

type SortField = "travelDate" | "invoiceNo" | "amount";
type SortDir = "asc" | "desc";

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

function formatDate(row: BookingRow): string {
  const monthNum = MONTHS_LIST.indexOf(row.month ?? "");
  if (monthNum === -1 || !row.day || !row.year) return row.travelDate;
  const d = new Date(Number(row.year), monthNum, Number(row.day));
  const weekday = d.toLocaleDateString("en-GB", { weekday: "short" });
  const mm = String(monthNum + 1).padStart(2, "0");
  const dd = String(row.day).padStart(2, "0");
  return `${dd}/${mm}/${row.year} (${weekday})`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function AllJobsPage() {
  const [rows, setRows] = useState<BookingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingCell, setEditingCell] = useState<{ id: number; field: string } | null>(null);
  const [editValue, setEditValue] = useState("");
  const [cellStates, setCellStates] = useState<Record<string, "saving" | "saved" | "error">>({});
  const [rechecking, setRechecking] = useState(false);
  const [recheckMsg, setRecheckMsg] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [sortField, setSortField] = useState<SortField>("travelDate");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const router = useRouter();
  const { uploadOpen, setUploadOpen, serviceStatus } = useUploadContext();

  // ── Data fetching ──────────────────────────────────────────────────────────
  const fetchRows = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/bookings");
      if (res.ok) {
        const data: BookingRow[] = await res.json();
        setRows(data);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchRows(); }, [fetchRows]);

  // Refresh data after PDF upload
  useEffect(() => {
    const handler = () => fetchRows();
    window.addEventListener("bookings-uploaded", handler);
    return () => window.removeEventListener("bookings-uploaded", handler);
  }, [fetchRows]);

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

  // All unique invoice numbers (for dropdown datalists)
  const allInvoiceNos = useMemo(
    () => [...new Set(rows.map((r) => r.invoiceNo).filter(Boolean) as string[])].sort(),
    [rows]
  );

  // ── Sort & filter ──────────────────────────────────────────────────────────
  const displayRows = useMemo(() => {
    let filtered = rows;
    if (search.trim()) {
      const q = search.toLowerCase();
      filtered = rows.filter((r) =>
        (r.clientDetails ?? "").toLowerCase().includes(q) ||
        (r.invoiceNo ?? "").toLowerCase().includes(q) ||
        (r.details ?? "").toLowerCase().includes(q) ||
        (r.vehiclePlate ?? "").toLowerCase().includes(q) ||
        (r.driverName ?? "").toLowerCase().includes(q) ||
        (r.fromLocation ?? "").toLowerCase().includes(q) ||
        (r.toLocation ?? "").toLowerCase().includes(q)
      );
    }
    return [...filtered].sort((a, b) => {
      let aVal: string | number = "";
      let bVal: string | number = "";
      if (sortField === "travelDate") { aVal = a.travelDate ?? ""; bVal = b.travelDate ?? ""; }
      else if (sortField === "invoiceNo") { aVal = a.invoiceNo ?? ""; bVal = b.invoiceNo ?? ""; }
      else if (sortField === "amount") { aVal = parseFloat(a.amount ?? "0"); bVal = parseFloat(b.amount ?? "0"); }
      if (aVal < bVal) return sortDir === "asc" ? -1 : 1;
      if (aVal > bVal) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
  }, [rows, search, sortField, sortDir]);

  function toggleSort(field: SortField) {
    if (sortField === field) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortField(field); setSortDir("asc"); }
  }

  function sortArrow(field: SortField) {
    if (sortField !== field) return "";
    return sortDir === "asc" ? " ↑" : " ↓";
  }


  // No-van conflicts: vanId=null, in-house, has invoice (shouldn't happen after recheck)
  const noVanRows = useMemo(
    () => rows.filter((r) =>
      r.vanId === null &&
      r.invoiceNo &&
      r.inHouseOrOutsourced !== "O" &&
      r.inHouseOrOutsourced !== "outsourced"
    ),
    [rows]
  );

  // Outsource needed: marked outsourced but no company name entered yet
  const outsourceNeededRows = useMemo(
    () => rows.filter((r) =>
      (r.inHouseOrOutsourced === "O" || r.inHouseOrOutsourced === "outsourced") &&
      !r.outsourcedCompany?.trim() &&
      r.invoiceNo
    ),
    [rows]
  );

  // Double-booked conflicts: same van assigned to multiple bookings on the same date
  const doubleBookedRows = useMemo(() => {
    const groups = new Map<string, BookingRow[]>();
    for (const r of rows) {
      if (r.vanId == null) continue;
      if (r.inHouseOrOutsourced === "O" || r.inHouseOrOutsourced === "outsourced") continue;
      const key = `${r.vanId}-${r.travelDate}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(r);
    }
    return [...groups.values()].filter((g) => g.length > 1).flat();
  }, [rows]);


  // ── Patch / edit ──────────────────────────────────────────────────────────
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

  const [deleteInvoiceInput, setDeleteInvoiceInput] = useState("");
  const [deleteInvoiceState, setDeleteInvoiceState] = useState<"idle" | "confirm" | "deleting">("idle");

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
      if (res.ok) {
        setDeleteInvoiceInput("");
        setDeleteInvoiceState("idle");
        await fetchRows();
        router.refresh();
      } else {
        const data = await res.json();
        alert(data.error ?? "Delete failed");
        setDeleteInvoiceState("idle");
      }
    } catch {
      alert("Network error");
      setDeleteInvoiceState("idle");
    }
  }

  async function handleAddRow() {
    const today = new Date();
    const res = await fetch("/api/bookings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        day: String(today.getDate()),
        month: MONTHS_LIST[today.getMonth()],
        year: String(today.getFullYear()),
      }),
    });
    if (res.ok) await fetchRows();
  }


  // ── Computed totals ───────────────────────────────────────────────────────
  const totalAmount = rows.reduce((sum, r) => sum + parseFloat(r.amount ?? "0"), 0);
  const paidCount = rows.filter((r) => r.paidStatus === "P").length;
  const unpaidCount = rows.filter((r) => r.paidStatus !== "P").length;

  // ── Editable cell components ──────────────────────────────────────────────
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

  // ── Trip-type table ───────────────────────────────────────────────────────
  const thSort = "px-3 py-2.5 text-left font-semibold text-zinc-700 whitespace-nowrap cursor-pointer select-none hover:bg-zinc-100 text-xs";
  const thPlain = "px-3 py-2.5 text-left font-semibold text-zinc-700 whitespace-nowrap text-xs";

  function TripTable({ groupRows }: { groupRows: BookingRow[] }) {
    if (groupRows.length === 0) return null;
    return (
      <div style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 12, overflow: "auto" }}>
        <table className="data-table">
          <thead>
            <tr className="bg-zinc-50 border-b border-zinc-200">
              <th className={thSort} onClick={() => toggleSort("travelDate")}>
                Date{sortArrow("travelDate")}
              </th>
              <th className={thSort} onClick={() => toggleSort("invoiceNo")}>
                Invoice #{sortArrow("invoiceNo")}
              </th>
              <th className={thPlain}>Client Name</th>
              <th className={thPlain}>Client Phone</th>
              <th className={thPlain}>Location (From → To)</th>
              <th className={thPlain}>Type</th>
              <th className={thPlain}>Requirements</th>
              <th className={thPlain}>Van Plate</th>
              <th className={thPlain}>Driver Name</th>
              <th className={thPlain}>Driver Contact</th>
              <th className={thPlain}>Tour Guide</th>
              <th className={thPlain}>Pax</th>
              <th className={thPlain}>Overtime</th>
              <th className={thPlain}>I/O</th>
              <th className={thPlain}>Outsourced Co.</th>
              <th className={thSort} onClick={() => toggleSort("amount")}>
                Amount (MYR){sortArrow("amount")}
              </th>
              <th className={thPlain}>P/U</th>
              <th className={`${thPlain} no-print`}></th>
            </tr>
          </thead>
          <tbody>
            {groupRows.map((row) => (
              <tr key={row.id} className="border-b border-zinc-100 hover:bg-zinc-50">
                {/* Date */}
                <td className="px-3 py-2 whitespace-nowrap text-zinc-600 text-xs min-w-[100px]">
                  {formatDate(row)}
                </td>
                {/* Invoice # */}
                <td className="px-3 py-2 min-w-[180px]">
                  <datalist id={`inv-list-${row.id}`}>
                    {allInvoiceNos.map((inv) => <option key={inv} value={inv} />)}
                  </datalist>
                  <input
                    type="text"
                    list={`inv-list-${row.id}`}
                    defaultValue={row.invoiceNo ?? ""}
                    placeholder="Invoice #"
                    className={`w-full font-mono text-xs border rounded px-1.5 py-0.5 bg-white text-zinc-900 focus:outline-none focus:ring-1 focus:ring-blue-400 ${
                      cellStates[`${row.id}-invoiceNo`] === "saving" ? "border-zinc-300 animate-pulse" :
                      cellStates[`${row.id}-invoiceNo`] === "saved"  ? "border-green-400" :
                      cellStates[`${row.id}-invoiceNo`] === "error"  ? "border-red-400" : "border-zinc-200"
                    }`}
                    onBlur={(e) => {
                      const val = e.target.value.trim();
                      if (val !== (row.invoiceNo ?? "")) patchRow(row.id, "invoiceNo", val || null);
                    }}
                  />
                  {(row.numberOfVehicles ?? 1) > 1 && (
                    <span className="text-[10px] text-zinc-400">v{row.vehicleIndex}/{row.numberOfVehicles}</span>
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
                <td className="px-3 py-2 min-w-[220px]">
                  <div className="flex flex-col gap-0.5">
                    <EditableText id={row.id} field="fromLocation" value={row.fromLocation} placeholder="From" />
                    {(row.fromLocation || row.toLocation) && <span className="text-zinc-300 text-[10px] px-1">↓</span>}
                    <EditableText id={row.id} field="toLocation" value={row.toLocation} placeholder="To" />
                  </div>
                </td>
                {/* Trip Type — button group selector */}
                <td className="px-3 py-2 whitespace-nowrap min-w-[130px]">
                  {(() => {
                    const types: TripType[] = ["trip", "one_way_ride", "round_trip", "day_trip"];
                    const labels: Record<TripType, string> = { trip: "Trip", one_way_ride: "1-Way", round_trip: "Round", day_trip: "Day" };
                    const saving = cellStates[`${row.id}-tripType`] === "saving";
                    const saved  = cellStates[`${row.id}-tripType`] === "saved";
                    return (
                      <div className={`flex flex-wrap gap-0.5 ${saving ? "opacity-50 pointer-events-none" : ""}`}>
                        {types.map((t) => (
                          <button
                            key={t}
                            type="button"
                            onClick={async () => { if (row.tripType !== t) await patchRow(row.id, "tripType", t); }}
                            className={`px-1.5 py-0.5 rounded text-[10px] font-semibold border transition-colors ${
                              row.tripType === t
                                ? t === "one_way_ride" ? "bg-blue-500 text-white border-blue-500"
                                : t === "round_trip"   ? "bg-green-500 text-white border-green-500"
                                : t === "day_trip"     ? "bg-yellow-500 text-white border-yellow-500"
                                :                        "bg-orange-500 text-white border-orange-500"
                                : `bg-white text-zinc-400 border-zinc-200 hover:border-zinc-400 ${saved ? "border-green-300" : ""}`
                            }`}
                          >{labels[t]}</button>
                        ))}
                      </div>
                    );
                  })()}
                </td>
                {/* Requirements — special flags */}
                <td className="px-3 py-2 min-w-[120px]">
                  <div className="flex flex-col gap-0.5">
                    {row.isAlphardTrip === 1 && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-purple-100 text-purple-800 border border-purple-300 whitespace-nowrap">★ Alphard</span>
                    )}
                    {row.vehicleCategory === "Car" && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-zinc-100 text-zinc-600 border border-zinc-300 whitespace-nowrap">🚗 Car</span>
                    )}
                    {row.vehicleCategory === "Alphard" && row.isAlphardTrip !== 1 && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-purple-50 text-purple-700 border border-purple-200 whitespace-nowrap">Alphard</span>
                    )}
                    <span className="text-zinc-500 text-[10px]">{tripTypeLabel(row.tripType)}</span>
                  </div>
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
                        placeholder="Company name"
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

  // ── Render ────────────────────────────────────────────────────────────────
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

        {/* Top bar */}
        <div className="flex gap-3 items-end flex-wrap no-print">
          <input
            type="text"
            placeholder="Search by client, invoice, route, plate, driver…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input-base"
            style={{ height: 34, padding: "0 12px", width: 320, fontSize: 13 }}
          />
          <div className="flex gap-2 ml-2 items-center flex-wrap">
            <button onClick={() => setUploadOpen(true)} className="btn btn-secondary">↑ Upload PDF</button>
            <button onClick={handleAddRow} className="btn btn-secondary">+ Add Row</button>
            <button
              onClick={handleRecheck}
              disabled={rechecking}
              className="btn"
              style={{ background: "rgba(88,166,255,0.1)", border: "1px solid rgba(88,166,255,0.3)", color: "var(--blue)" }}
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
              <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: recheckMsg.startsWith("✅") ? "var(--green)" : "var(--red)" }}>
                {recheckMsg}
              </span>
            )}
            <button
              onClick={() => window.print()}
              className="btn btn-secondary"
            >
              Print as PDF
            </button>
          </div>
          {/* Delete by invoice */}
          <div className="flex items-center gap-2">
            <datalist id="delete-inv-list">
              {allInvoiceNos.map((inv) => <option key={inv} value={inv} />)}
            </datalist>
            <input
              type="text"
              list="delete-inv-list"
              placeholder="Invoice # to delete"
              value={deleteInvoiceInput}
              onChange={(e) => { setDeleteInvoiceInput(e.target.value); setDeleteInvoiceState("idle"); }}
              className="h-9 px-3 rounded-lg border border-zinc-300 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-red-400 w-44"
            />
            <button
              onClick={handleDeleteByInvoice}
              disabled={!deleteInvoiceInput.trim() || deleteInvoiceState === "deleting"}
              className={`h-9 px-4 rounded-lg text-sm font-medium transition-colors ${
                deleteInvoiceState === "confirm"
                  ? "bg-red-600 text-white hover:bg-red-700"
                  : deleteInvoiceState === "deleting"
                  ? "bg-red-300 text-white cursor-not-allowed"
                  : "border border-red-400 text-red-600 bg-white hover:bg-red-50"
              }`}
            >
              {deleteInvoiceState === "confirm" ? "Confirm delete?" : deleteInvoiceState === "deleting" ? "Deleting…" : "Delete Invoice"}
            </button>
          </div>
        </div>

        {/* Print heading */}
        <div className="text-sm font-semibold text-zinc-900 hidden print:block">All Jobs Record</div>


        {/* Summary bar */}
        {!loading && (
          <div className="no-print flex gap-6 text-sm text-zinc-900 bg-white rounded-lg border border-zinc-200 px-4 py-2 w-fit">
            <span>Rows: <strong>{rows.length}</strong></span>
            {search && <span className="text-zinc-500">Showing: <strong>{displayRows.length}</strong></span>}
            <span>Total: <strong>MYR {totalAmount.toFixed(2)}</strong></span>
            <span>Paid: <strong className="text-green-600">{paidCount}</strong></span>
            <span>Unpaid: <strong className="text-red-500">{unpaidCount}</strong></span>
          </div>
        )}

        {/* Conflict banner */}
        {!loading && (noVanRows.length > 0 || outsourceNeededRows.length > 0 || doubleBookedRows.length > 0) && (
          <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 space-y-1">
            <div className="font-bold text-red-800 text-sm">
              ⚠️ CONFLICT — {noVanRows.length + outsourceNeededRows.length + doubleBookedRows.length} issue{noVanRows.length + outsourceNeededRows.length + doubleBookedRows.length !== 1 ? "s" : ""} found
            </div>
            {(() => {
              const alphardOut = outsourceNeededRows.filter((r) => r.vehicleCategory === "Alphard");
              const carOut     = outsourceNeededRows.filter((r) => r.vehicleCategory === "Car");
              const vanOut     = outsourceNeededRows.filter((r) => r.vehicleCategory !== "Alphard" && r.vehicleCategory !== "Car");
              return <>
                {alphardOut.length > 0 && (
                  <div className="text-xs text-red-700 pl-4">
                    🚐 <strong>Outsource (Alphard)</strong> — {alphardOut.length} booking{alphardOut.length !== 1 ? "s" : ""} need outsource company
                    {alphardOut.map((r) => (
                      <div key={`oa-${r.id}`} className="pl-4">• {formatDate(r)} | {r.fromLocation}{r.toLocation ? ` → ${r.toLocation}` : ""} | {tripTypeLabel(r.tripType)}</div>
                    ))}
                  </div>
                )}
                {carOut.length > 0 && (
                  <div className="text-xs text-red-700 pl-4">
                    🚗 <strong>Outsource (Car)</strong> — {carOut.length} booking{carOut.length !== 1 ? "s" : ""} need outsource company
                    {carOut.map((r) => (
                      <div key={`oc-${r.id}`} className="pl-4">• {formatDate(r)} | {r.fromLocation}{r.toLocation ? ` → ${r.toLocation}` : ""} | {tripTypeLabel(r.tripType)}</div>
                    ))}
                  </div>
                )}
                {vanOut.length > 0 && (
                  <div className="text-xs text-red-700 pl-4">
                    🚐 <strong>Outsource (Van)</strong> — {vanOut.length} booking{vanOut.length !== 1 ? "s" : ""} need outsource company
                    {vanOut.map((r) => (
                      <div key={`on-${r.id}`} className="pl-4">• {formatDate(r)} | {r.fromLocation}{r.toLocation ? ` → ${r.toLocation}` : ""} | {tripTypeLabel(r.tripType)}</div>
                    ))}
                  </div>
                )}
              </>;
            })()}
            {noVanRows.map((r) => (
              <div key={r.id} className="text-xs text-red-700 pl-4">
                • {formatDate(r)} | {r.fromLocation} → {r.toLocation} | {tripTypeLabel(r.tripType)} | <strong>NO VAN ASSIGNED</strong>
              </div>
            ))}
            {doubleBookedRows.map((r) => (
              <div key={`db-${r.id}`} className="text-xs text-red-700 pl-4">
                • {formatDate(r)} | {r.fromLocation} → {r.toLocation} | {tripTypeLabel(r.tripType)} | <strong>DOUBLE-BOOKED — {r.vehiclePlate ?? `Van #${r.vanId}`}</strong>
              </div>
            ))}
          </div>
        )}

        {/* Trip-type tables */}
        {loading ? (
          <div className="text-center py-20 text-zinc-400 text-sm">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="bg-white rounded-xl border border-zinc-200 p-12 text-center text-zinc-400 text-sm">
            No bookings found.
          </div>
        ) : displayRows.length === 0 ? (
          <div className="bg-white rounded-xl border border-zinc-200 p-12 text-center text-zinc-400 text-sm">
            No rows match your search.
          </div>
        ) : (
          <TripTable groupRows={displayRows} />
        )}
      </main>
    </div>
  );
}
