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

interface EditToastInfo {
  changes: Array<{ field: string; from: string; to: string }>;
  rescheduled: boolean;
  vanChanged: boolean;
  prevVan: string | null;
  newVan: string | null;
}

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
  is15PaxTrip: number | null;
  tourGuide: string | null;
  vehicleIndex: number | null;
  numberOfVehicles: number | null;
  vehicleCategory: string | null;
}

type PendingEdits = Record<number, Record<string, unknown>>;

function PendingInput({
  id,
  field,
  value,
  pendingEdits,
  onPendingChange,
  placeholder,
  type = "text",
  list,
}: {
  id: number;
  field: string;
  value: string | null;
  pendingEdits: PendingEdits;
  onPendingChange: (id: number, field: string, value: unknown) => void;
  placeholder?: string;
  type?: string;
  list?: string;
}) {
  const pending = pendingEdits[id];
  const displayValue = pending && field in pending ? String(pending[field] ?? "") : (value ?? "");
  const isDirty = pending && field in pending && String(pending[field] ?? "") !== (value ?? "");
  return (
    <input
      type={type}
      className={`w-full border rounded px-1 py-0.5 text-xs bg-white text-zinc-900 ${isDirty ? "border-amber-400 bg-amber-50" : "border-zinc-200"}`}
      value={displayValue}
      placeholder={placeholder ?? "—"}
      list={list}
      onChange={(e) => onPendingChange(id, field, e.target.value)}
    />
  );
}

function PendingSelect({
  id,
  field,
  value,
  options,
  pendingEdits,
  onPendingChange,
}: {
  id: number;
  field: string;
  value: string | null;
  options: string[];
  pendingEdits: PendingEdits;
  onPendingChange: (id: number, field: string, value: unknown) => void;
}) {
  const pending = pendingEdits[id];
  const displayValue = pending && field in pending ? String(pending[field] ?? options[0]) : (value ?? options[0]);
  const isDirty = pending && field in pending && String(pending[field] ?? "") !== (value ?? "");
  return (
    <select
      className={`text-xs border ${isDirty ? "border-amber-400 bg-amber-50" : "border-zinc-300 bg-white"} rounded px-1 py-0.5 w-full text-zinc-900`}
      value={displayValue}
      onChange={(e) => onPendingChange(id, field, e.target.value)}
    >
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
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

// ── Edit toast helpers ────────────────────────────────────────────────────────

const EDIT_FIELD_LABELS: Record<string, string> = {
  fromLocation: "From", toLocation: "To", tripType: "Trip Type",
  vehicleCategory: "Vehicle Type", invoiceNo: "Invoice #", clientDetails: "Client",
  amount: "Amount", paidStatus: "Paid Status", passengerCount: "Pax",
  overtime: "Overtime", tourGuide: "Tour Guide", vehiclePlate: "Van Plate",
  driverName: "Driver", driverContact: "Driver Contact",
  outsourcedCompany: "Outsourced Co.", details: "Remarks",
  is15PaxTrip: "15-Pax",
};

function formatEditFieldValue(field: string, val: unknown): string {
  if (field === "tripType") return tripTypeLabel(val as TripType | null);
  if (field === "paidStatus") return val === "P" ? "Paid" : val === "U" ? "Unpaid" : String(val ?? "—");
  if (field === "is15PaxTrip") return val === 1 ? "15-Pax" : "Standard";
  return String(val ?? "") || "—";
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function AllJobsPage() {
  const [rows, setRows] = useState<BookingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [cellStates, setCellStates] = useState<Record<string, "saving" | "saved" | "error">>({});
  const [pendingEdits, setPendingEdits] = useState<Record<number, Record<string, unknown>>>({});
  const [rechecking, setRechecking] = useState(false);
  const [recheckMsg, setRecheckMsg] = useState<string | null>(null);
  const [editToast, setEditToast] = useState<EditToastInfo | null>(null);

  const [search, setSearch] = useState("");
  const [sortField, setSortField] = useState<SortField>("travelDate");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const router = useRouter();
  const { uploadOpen, setUploadOpen, serviceStatus } = useUploadContext();

  // ── Data fetching ──────────────────────────────────────────────────────────
  const fetchRows = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch("/api/bookings");
      if (res.ok) {
        const data: BookingRow[] = await res.json();
        setRows(data);
        return data;
      }
    } finally {
      if (!silent) setLoading(false);
    }
    return null;
  }, []);

  useEffect(() => { fetchRows(); }, [fetchRows]);

  // Refresh data after PDF upload
  useEffect(() => {
    const handler = () => fetchRows();
    window.addEventListener("bookings-uploaded", handler);
    return () => window.removeEventListener("bookings-uploaded", handler);
  }, [fetchRows]);

  // Auto-dismiss edit toast
  useEffect(() => {
    if (!editToast) return;
    const t = setTimeout(() => setEditToast(null), 6000);
    return () => clearTimeout(t);
  }, [editToast]);

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
      await fetchRows(true);
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

  // Double-booked conflicts: same van assigned to multiple bookings on the same date.
  // Groups where any booking has manualChange=1 are excluded — user explicitly approved.
  const doubleBookedRows = useMemo(() => {
    const groups = new Map<string, BookingRow[]>();
    for (const r of rows) {
      if (r.vanId == null) continue;
      if (r.inHouseOrOutsourced === "O" || r.inHouseOrOutsourced === "outsourced") continue;
      const key = `${r.vanId}-${r.travelDate}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(r);
    }
    return [...groups.values()]
      .filter((g) => g.length > 1 && g.every((r) => r.manualChange !== 1))
      .flat();
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
        await fetchRows(true);
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
        await fetchRows(true);
      } else {
        setCellStates((prev) => ({ ...prev, [key]: "error" }));
      }
    } catch {
      setCellStates((prev) => ({ ...prev, [key]: "error" }));
    }
  }

  function setPending(id: number, field: string, value: unknown) {
    setPendingEdits((prev) => ({ ...prev, [id]: { ...(prev[id] ?? {}), [field]: value } }));
  }

  async function confirmEdit(row: BookingRow) {
    const edits = pendingEdits[row.id];
    if (!edits || Object.keys(edits).length === 0) return;

    const from = (edits.fromLocation as string | undefined) ?? row.fromLocation ?? "";
    const to   = (edits.toLocation   as string | undefined) ?? row.toLocation ?? "";

    // Snapshot for toast (before any updates)
    const prevVanPlate = row.vehiclePlate;
    const toastChanges = Object.entries(edits)
      .filter(([field]) => field !== "isAlphardTrip" && field in EDIT_FIELD_LABELS)
      .map(([field, newVal]) => {
        const rawOld = field === "clientDetails"
          ? clientName(row)
          : (row as unknown as Record<string, unknown>)[field];
        return {
          field: EDIT_FIELD_LABELS[field],
          from: formatEditFieldValue(field, rawOld),
          to:   formatEditFieldValue(field, newVal),
        };
      })
      .filter(ch => ch.from !== ch.to);

    const updates: Record<string, unknown> = { ...edits };
    if ("invoiceNo" in updates) {
      const invoiceNo = String(updates.invoiceNo ?? "").trim();
      updates.invoiceNo = invoiceNo || null;
    }
    if ("passengerCount" in updates) {
      const passengerCount = String(updates.passengerCount ?? "").trim();
      const parsedPassengerCount = parseInt(passengerCount, 10);
      updates.passengerCount = passengerCount === "" || Number.isNaN(parsedPassengerCount) ? null : parsedPassengerCount;
    }
    if ("toLocation" in edits && (edits.toLocation as string) === "" && (row.toLocation ?? "") !== "") {
      updates.tripType = "day_trip";
    }
    if ("toLocation" in edits && (edits.toLocation as string) !== "" && (row.toLocation ?? "") === "" && row.tripType === "day_trip") {
      updates.tripType = "trip";
    }
    if (("fromLocation" in edits || "toLocation" in edits) && !("details" in edits)) {
      updates.details = to ? `${from} -> ${to}` : from;
    }
    if ("clientDetails" in updates) {
      const newName = String(updates.clientDetails ?? "").trim();
      const existingLines = (row.clientDetails ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
      if (existingLines.length <= 1) {
        updates.clientDetails = newName || null;
      } else {
        updates.clientDetails = newName
          ? `${newName}\n${existingLines.slice(1).join("\n")}`
          : existingLines.slice(1).join("\n") || null;
      }
    }

    const needsReassign = "fromLocation" in edits || "toLocation" in edits ||
      "tripType" in edits || "vehicleCategory" in edits || "isAlphardTrip" in edits || "is15PaxTrip" in edits;

    const key = `${row.id}-confirm`;
    setCellStates((prev) => ({ ...prev, [key]: "saving" }));
    try {
      const res = await fetch(`/api/bookings/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (res.ok) {
        setCellStates((prev) => ({ ...prev, [key]: "saved" }));
        setTimeout(() => setCellStates((prev) => { const n = { ...prev }; delete n[key]; return n; }), 1500);
        setPendingEdits((prev) => { const n = { ...prev }; delete n[row.id]; return n; });
        let newData = await fetchRows(true);
        if (needsReassign) {
          let siblingIds: number[] = [];
          if (row.invoiceNo) {
            const sibRes = await fetch(`/api/bookings?invoiceNo=${encodeURIComponent(row.invoiceNo)}`);
            if (sibRes.ok) {
              const siblings: BookingRow[] = await sibRes.json();
              siblingIds = siblings.map((s) => s.id).filter((sid) => sid !== row.id);
            }
          }
          await fetch(`/api/bookings/${row.id}/reassign`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ siblingIds }),
          });
          newData = await fetchRows(true);
        }
        const updatedRow = newData?.find((r) => r.id === row.id);
        const newVanPlate = updatedRow?.vehiclePlate ?? null;
        setEditToast({
          changes: toastChanges,
          rescheduled: needsReassign,
          vanChanged: prevVanPlate !== newVanPlate,
          prevVan: prevVanPlate,
          newVan: newVanPlate,
        });
      } else {
        setCellStates((prev) => ({ ...prev, [key]: "error" }));
      }
    } catch {
      setCellStates((prev) => ({ ...prev, [key]: "error" }));
    }
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

  // ── Trip-type table ───────────────────────────────────────────────────────
  const thSort = "px-3 py-2.5 text-left font-semibold text-zinc-700 whitespace-nowrap cursor-pointer select-none hover:bg-zinc-100 text-xs";
  const thPlain = "px-3 py-2.5 text-left font-semibold text-zinc-700 whitespace-nowrap text-xs";

  function renderTripTable(groupRows: BookingRow[]) {
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
              <th className={`${thPlain} no-print`}>Confirm</th>
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
                  <PendingInput
                    id={row.id}
                    field="invoiceNo"
                    value={row.invoiceNo}
                    list={`inv-list-${row.id}`}
                    placeholder="Invoice #"
                    pendingEdits={pendingEdits}
                    onPendingChange={setPending}
                  />
                  {(row.numberOfVehicles ?? 1) > 1 && (
                    <span className="text-[10px] text-zinc-400">v{row.vehicleIndex}/{row.numberOfVehicles}</span>
                  )}
                </td>
                {/* Client Name */}
                <td className="px-3 py-2 min-w-[140px]">
                  <PendingInput id={row.id} field="clientDetails" value={clientName(row)} placeholder="Client name" pendingEdits={pendingEdits} onPendingChange={setPending} />
                </td>
                {/* Client Phone */}
                <td className="px-3 py-2 min-w-[130px] text-zinc-600 whitespace-nowrap">
                  {clientPhone(row) || <span className="text-zinc-300">—</span>}
                </td>
                {/* Location */}
                <td className="px-3 py-2 min-w-[220px]">
                  <div className="flex flex-col gap-0.5">
                    <PendingInput id={row.id} field="fromLocation" value={row.fromLocation} placeholder="From" pendingEdits={pendingEdits} onPendingChange={setPending} />
                    <span className="text-zinc-300 text-[10px] px-1">↓</span>
                    <PendingInput id={row.id} field="toLocation" value={row.toLocation} placeholder="To (blank = day trip)" pendingEdits={pendingEdits} onPendingChange={setPending} />
                  </div>
                </td>
                {/* Trip Type — button group selector */}
                <td className="px-3 py-2 whitespace-nowrap min-w-[130px]">
                  {(() => {
                    const types: TripType[] = ["trip", "one_way_ride"];
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
                {/* Requirements — vehicle type toggle */}
                <td className="px-3 py-2 min-w-[140px]">
                  <div className="flex flex-col gap-1">
                    {(() => {
                      const pendingCat = pendingEdits[row.id]?.vehicleCategory as string | undefined;
                      const pendingAlph = pendingEdits[row.id]?.isAlphardTrip as number | undefined;
                      const pending15 = pendingEdits[row.id]?.is15PaxTrip as number | undefined;
                      const effectiveCat = pendingCat ?? row.vehicleCategory;
                      const effectiveAlph = pendingAlph ?? row.isAlphardTrip;
                      const effective15 = pending15 !== undefined ? pending15 : (row.is15PaxTrip ?? 0);
                      const sel = effectiveAlph === 1 || effectiveCat === "Alphard" ? "Alphard"
                        : effectiveCat === "Car" ? "Car"
                        : effective15 === 1 ? "15-Pax"
                        : "Van";
                      const origSel = (row.isAlphardTrip === 1 || row.vehicleCategory === "Alphard") ? "Alphard"
                        : row.vehicleCategory === "Car" ? "Car"
                        : (row.is15PaxTrip ?? 0) === 1 ? "15-Pax"
                        : "Van";
                      const isDirty = sel !== origSel;
                      type Opt = { label: string; cat: string; alph: number; pax15: number; active: string };
                      const opts: Opt[] = [
                        { label: "Van",    cat: "Van",    alph: 0, pax15: 0, active: "bg-blue-600 text-white"   },
                        { label: "Alphard",cat: "Alphard",alph: 1, pax15: 0, active: "bg-purple-600 text-white" },
                        { label: "Car",    cat: "Car",    alph: 0, pax15: 0, active: "bg-zinc-600 text-white"    },
                        { label: "15-Pax", cat: "Van",    alph: 0, pax15: 1, active: "bg-orange-500 text-white"  },
                      ];
                      return (
                        <div className={`inline-flex rounded border overflow-hidden text-[10px] font-semibold ${isDirty ? "border-amber-400" : "border-zinc-200"}`}>
                          {opts.map((opt) => (
                            <button key={opt.label} type="button"
                              onClick={() => {
                                if (sel === opt.label) return;
                                setPending(row.id, "vehicleCategory", opt.cat);
                                setPending(row.id, "isAlphardTrip", opt.alph);
                                setPending(row.id, "is15PaxTrip", opt.pax15);
                              }}
                              className={`px-2 py-1 leading-none transition-colors border-l border-zinc-200 first:border-l-0 ${
                                sel === opt.label ? opt.active : isDirty ? "bg-amber-50 text-zinc-400 hover:text-zinc-700" : "bg-white text-zinc-400 hover:text-zinc-700"
                              }`}
                            >{opt.label}</button>
                          ))}
                        </div>
                      );
                    })()}
                    <span className="text-zinc-500 text-[10px]">{tripTypeLabel(row.tripType)}</span>
                  </div>
                </td>
                {/* Van Plate */}
                <td className="px-3 py-2 min-w-[110px]">
                  <PendingInput id={row.id} field="vehiclePlate" value={row.vehiclePlate} placeholder="—" pendingEdits={pendingEdits} onPendingChange={setPending} />
                </td>
                {/* Driver Name */}
                <td className="px-3 py-2 min-w-[140px]">
                  <PendingInput id={row.id} field="driverName" value={row.driverName} placeholder="—" pendingEdits={pendingEdits} onPendingChange={setPending} />
                </td>
                {/* Driver Contact */}
                <td className="px-3 py-2 min-w-[130px]">
                  <PendingInput id={row.id} field="driverContact" value={row.driverContact} placeholder="—" pendingEdits={pendingEdits} onPendingChange={setPending} />
                </td>
                {/* Tour Guide */}
                <td className="px-3 py-2 min-w-[120px]">
                  <PendingInput id={row.id} field="tourGuide" value={row.tourGuide} placeholder="—" pendingEdits={pendingEdits} onPendingChange={setPending} />
                </td>
                {/* Pax */}
                <td className="px-3 py-2 min-w-[72px]">
                  <PendingInput id={row.id} field="passengerCount" value={row.passengerCount != null ? String(row.passengerCount) : ""} placeholder="0" type="number" pendingEdits={pendingEdits} onPendingChange={setPending} />
                </td>
                {/* Overtime */}
                <td className="px-3 py-2 min-w-[96px]">
                  <PendingSelect id={row.id} field="overtime" value={row.overtime ?? "0"} options={OVERTIME_OPTIONS} pendingEdits={pendingEdits} onPendingChange={setPending} />
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
                          await fetchRows(true);
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
                      <PendingInput
                        id={row.id}
                        field="outsourcedCompany"
                        value={row.outsourcedCompany}
                        placeholder="Company name"
                        pendingEdits={pendingEdits}
                        onPendingChange={setPending}
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
                  <PendingInput id={row.id} field="amount" value={row.amount} placeholder="0" pendingEdits={pendingEdits} onPendingChange={setPending} />
                </td>
                {/* Paid Status */}
                <td className="px-3 py-2 min-w-[68px]">
                  <PendingSelect id={row.id} field="paidStatus" value={row.paidStatus} options={["U", "P"]} pendingEdits={pendingEdits} onPendingChange={setPending} />
                </td>
                {/* Confirm Edit */}
                <td className="px-3 py-2 no-print">
                  {(() => {
                    const hasPending = Object.keys(pendingEdits[row.id] ?? {}).length > 0;
                    const state = cellStates[`${row.id}-confirm`];
                    return (
                      <button
                        onClick={() => confirmEdit(row)}
                        disabled={!hasPending || state === "saving"}
                        className={`px-2 py-1 rounded text-[11px] font-semibold border transition-colors whitespace-nowrap ${
                          state === "saving" ? "bg-zinc-100 text-zinc-400 border-zinc-200 cursor-wait" :
                          state === "saved"  ? "bg-green-100 text-green-700 border-green-300" :
                          state === "error"  ? "bg-red-100 text-red-600 border-red-300" :
                          hasPending        ? "bg-amber-500 text-white border-amber-500 hover:bg-amber-600 cursor-pointer" :
                                              "bg-white text-zinc-300 border-zinc-200 cursor-not-allowed"
                        }`}
                      >
                        {state === "saving" ? "Saving…" : state === "saved" ? "✓ Saved" : state === "error" ? "Error" : "Confirm Edit"}
                      </button>
                    );
                  })()}
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
          renderTripTable(displayRows)
        )}
      </main>

      {/* Edit saved toast */}
      {editToast && (
        <div className="fixed bottom-6 right-6 z-50 bg-white border border-zinc-200 rounded-2xl shadow-2xl p-4 no-print" style={{ maxWidth: 340, width: "calc(100% - 48px)" }}>
          <div className="flex justify-between items-start mb-2">
            <span className="font-bold text-green-600 text-sm">✓ Edit Saved</span>
            <button onClick={() => setEditToast(null)} className="text-zinc-400 hover:text-zinc-600 text-xl leading-none ml-2">×</button>
          </div>
          {editToast.changes.length > 0 && (
            <div className="space-y-1 text-xs mb-3">
              {editToast.changes.map((ch, i) => (
                <div key={i} className="flex flex-wrap gap-x-1 items-baseline">
                  <span className="text-zinc-500 font-medium shrink-0">{ch.field}:</span>
                  <span className="text-zinc-400 line-through shrink-0">{ch.from}</span>
                  <span className="text-zinc-400 shrink-0">→</span>
                  <span className="text-zinc-800 font-semibold">{ch.to}</span>
                </div>
              ))}
            </div>
          )}
          <div className="pt-2 border-t border-zinc-100 text-xs">
            {editToast.rescheduled ? (
              editToast.vanChanged ? (
                <span className="text-blue-600 font-medium">🔄 Reassigned: {editToast.prevVan ?? "no van"} → {editToast.newVan ?? "no van"}</span>
              ) : (
                <span className="text-zinc-500">🔄 Reassigned — kept {editToast.newVan ?? "same van"}</span>
              )
            ) : (
              <span className="text-zinc-400">No reassignment triggered</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
