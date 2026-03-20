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

const BADGE_COLORS = [
  "bg-blue-50",
  "bg-emerald-50",
  "bg-amber-50",
  "bg-rose-50",
  "bg-violet-50",
  "bg-cyan-50",
  "bg-orange-50",
  "bg-pink-50",
];

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
  paidStatus: string | null;
  overtime: string | null;
  introducer: string | null;
  inHouseOrOutsourced: string | null;
  outsourcedCompany: string | null;
  day: string | null;
  month: string | null;
  year: string | null;
}

export default function DailyJobsPage() {
  const today = new Date();
  const [day, setDay] = useState(String(today.getDate()));
  const [month, setMonth] = useState(MONTHS_LIST[today.getMonth()]);
  const [year, setYear] = useState(String(today.getFullYear()));
  const [rows, setRows] = useState<BookingRow[]>([]);
  const [draftRow, setDraftRow] = useState(false);
  const [loading, setLoading] = useState(true);
  const [creatingDraft, setCreatingDraft] = useState(false);
  const [editingCell, setEditingCell] = useState<{ id: number; field: string } | null>(null);
  const [editValue, setEditValue] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/bookings?day=${encodeURIComponent(day)}&month=${encodeURIComponent(month)}&year=${encodeURIComponent(year)}`
      );
      if (res.ok) {
        const data: BookingRow[] = await res.json();
        setRows(data);
        setDraftRow(data.length === 0);
      }
    } finally {
      setLoading(false);
    }
  }, [day, month, year]);

  useEffect(() => { fetchRows(); }, [fetchRows]);

  async function patchRow(id: number, field: string, value: unknown) {
    await fetch(`/api/bookings/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: value }),
    });
    setRows((prev) => prev.map((r) => r.id === id ? { ...r, [field]: value } : r));
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
    await fetch(`/api/bookings/${id}`, { method: "DELETE" });
    setRows((prev) => prev.filter((r) => r.id !== id));
  }

  // Materialise the phantom draft row: POST to DB, then open the clicked field for edit
  async function materializeDraft(field: string) {
    if (creatingDraft) return;
    setCreatingDraft(true);
    try {
      const res = await fetch("/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ day, month, year }),
      });
      if (res.ok) {
        const newRow: BookingRow = await res.json();
        setRows([newRow]);
        setDraftRow(false);
        startEdit(newRow.id, field, "");
      }
    } finally {
      setCreatingDraft(false);
    }
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: formData });
      if (res.ok) {
        const { count } = await res.json();
        // Find the earliest date among the just-inserted rows
        const navRes = await fetch(`/api/bookings?recentCount=${count}`);
        if (navRes.ok) {
          const recent: BookingRow[] = await navRes.json();
          if (recent.length > 0) {
            const first = recent
              .filter((r) => r.day && r.month && r.year)
              .sort((a, b) => (a.travelDate ?? "").localeCompare(b.travelDate ?? ""))[0];
            if (first?.day && first?.month && first?.year) {
              setDay(first.day);
              setMonth(first.month);
              setYear(first.year);
              // useEffect will re-fetch with new day/month/year
            }
          }
        }
      } else {
        const err = await res.json().catch(() => ({ error: "Upload failed" }));
        alert(`Upload failed: ${err.error ?? "Unknown error"}`);
      }
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  // Summary bar calculations
  const totalAmount = rows.reduce((sum, r) => sum + parseFloat(r.amount ?? "0"), 0);
  const paidCount = rows.filter((r) => r.paidStatus === "P").length;
  const unpaidCount = rows.filter((r) => r.paidStatus !== "P").length;

  const seenInvoices = new Set<string>();

  function vanRowColor(vanId: number | null): string {
    if (vanId == null) return "";
    return BADGE_COLORS[(vanId - 1) % BADGE_COLORS.length];
  }

  function EditableText({ id, field, value }: { id: number; field: string; value: string | null }) {
    const isEditing = editingCell?.id === id && editingCell?.field === field;
    if (isEditing) {
      return (
        <input
          autoFocus
          className="w-full border border-blue-400 rounded px-1 py-0.5 text-xs bg-white"
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
        className="cursor-pointer hover:bg-blue-50 rounded px-1 min-w-[40px] inline-block text-xs"
        onClick={() => startEdit(id, field, value ?? "")}
      >
        {value || <span className="text-zinc-300">—</span>}
      </span>
    );
  }

  function EditableSelect({
    id, field, value, options,
  }: { id: number; field: string; value: string | null; options: string[] }) {
    return (
      <select
        className="text-xs border border-zinc-300 rounded px-1 py-0.5 w-full bg-white"
        value={value ?? options[0]}
        onChange={async (e) => { await patchRow(id, field, e.target.value); }}
      >
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }

  const colHeaders = [
    "Day", "I/O", "Outsourced Co.", "Vehicle Plate #", "Driver Name",
    "Invoice #", "Client's Details", "Amount (MYR)", "Passenger #",
    "Booking Details", "Overtime", "Introducer", "P/U", "",
  ];

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

      <header className="bg-white border-b border-zinc-200 px-6 py-4 no-print">
        <div className="max-w-full mx-auto flex items-center justify-between">
          <h1 className="text-xl font-semibold text-zinc-900">Daily Jobs Record</h1>
          <nav className="flex gap-4 text-sm font-medium">
            <Link href="/" className="text-zinc-500 hover:text-zinc-900 transition-colors">Dashboard</Link>
            <Link href="/database" className="text-zinc-500 hover:text-zinc-900 transition-colors">Raw Database</Link>
            <span className="text-zinc-900 border-b-2 border-zinc-900 pb-0.5">Daily Jobs</span>
          </nav>
        </div>
      </header>

      <main className="px-4 py-6">
        {/* Controls */}
        <div className="flex gap-3 items-end mb-4 no-print flex-wrap">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Day</label>
            <select
              className="h-9 px-3 rounded-lg border border-zinc-300 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-400"
              value={day}
              onChange={(e) => setDay(e.target.value)}
            >
              {DAYS_LIST.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Month</label>
            <select
              className="h-9 px-3 rounded-lg border border-zinc-300 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-400"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
            >
              {MONTHS_LIST.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Year</label>
            <select
              className="h-9 px-3 rounded-lg border border-zinc-300 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-400"
              value={year}
              onChange={(e) => setYear(e.target.value)}
            >
              {YEARS_LIST.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>

          <div className="flex gap-2 ml-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf"
              className="hidden"
              onChange={handleUpload}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="h-9 px-4 rounded-lg border border-zinc-300 bg-white text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 transition-colors"
            >
              {uploading ? "Uploading…" : "Upload PDF"}
            </button>
            <button
              onClick={() => window.print()}
              className="h-9 px-4 rounded-lg bg-zinc-900 text-white text-sm font-medium hover:bg-zinc-700 transition-colors"
            >
              Print as PDF
            </button>
          </div>
        </div>

        {/* Print heading */}
        <div className="mb-4 text-sm font-semibold text-zinc-600 hidden print:block">
          Daily Jobs — {day} {month} {year}
        </div>

        {/* Summary bar */}
        {!loading && (
          <div className="no-print flex gap-6 mb-4 text-sm text-zinc-600 bg-white rounded-lg border border-zinc-200 px-4 py-2 w-fit">
            <span>Rows: <strong>{rows.length}</strong></span>
            <span>Total: <strong>MYR {totalAmount.toFixed(2)}</strong></span>
            <span>Paid: <strong className="text-green-600">{paidCount}</strong></span>
            <span>Unpaid: <strong className="text-red-500">{unpaidCount}</strong></span>
          </div>
        )}

        {loading ? (
          <div className="text-center py-20 text-zinc-400 text-sm">Loading…</div>
        ) : (
          <div className="bg-white rounded-xl border border-zinc-200 overflow-auto shadow-sm">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="bg-zinc-50 border-b border-zinc-200">
                  {colHeaders.map((col, i) => (
                    <th
                      key={i}
                      className={`px-2 py-2.5 text-left font-semibold text-zinc-600 whitespace-nowrap${i === colHeaders.length - 1 ? " no-print" : ""}`}
                    >
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const isFirstInvoice = row.invoiceNo ? !seenInvoices.has(row.invoiceNo) : false;
                  if (row.invoiceNo) seenInvoices.add(row.invoiceNo);

                  return (
                    <tr key={row.id} className={`border-b border-zinc-100 hover:brightness-95 ${vanRowColor(row.vanId)}`}>
                      <td className="px-2 py-1.5 w-14">
                        <EditableSelect id={row.id} field="day" value={row.day} options={DAYS_LIST} />
                      </td>
                      <td className="px-2 py-1.5 w-14">
                        <EditableSelect id={row.id} field="inHouseOrOutsourced" value={row.inHouseOrOutsourced} options={["I", "O"]} />
                      </td>
                      <td className="px-2 py-1.5 min-w-[100px]">
                        <EditableText id={row.id} field="outsourcedCompany" value={row.outsourcedCompany} />
                      </td>
                      <td className="px-2 py-1.5 min-w-[80px]">
                        <EditableText id={row.id} field="vehiclePlate" value={row.vehiclePlate} />
                      </td>
                      <td className="px-2 py-1.5 min-w-[80px]">
                        <EditableText id={row.id} field="driverName" value={row.driverName} />
                      </td>
                      <td className="px-2 py-1.5 font-mono whitespace-nowrap text-zinc-500 text-xs">
                        {isFirstInvoice ? (row.invoiceNo ?? "") : ""}
                      </td>
                      <td className="px-2 py-1.5 min-w-[130px]">
                        <EditableText id={row.id} field="clientDetails" value={row.clientDetails} />
                      </td>
                      <td className="px-2 py-1.5 min-w-[80px]">
                        <EditableText id={row.id} field="amount" value={row.amount} />
                      </td>
                      <td className="px-2 py-1.5 w-14">
                        <EditableText id={row.id} field="passengerCount" value={row.passengerCount != null ? String(row.passengerCount) : ""} />
                      </td>
                      <td className="px-2 py-1.5 min-w-[160px]">
                        <EditableText id={row.id} field="details" value={row.details} />
                      </td>
                      <td className="px-2 py-1.5 w-20">
                        <EditableSelect id={row.id} field="overtime" value={row.overtime ?? "0"} options={OVERTIME_OPTIONS} />
                      </td>
                      <td className="px-2 py-1.5 min-w-[80px]">
                        <EditableText id={row.id} field="introducer" value={row.introducer} />
                      </td>
                      <td className="px-2 py-1.5 w-14">
                        <EditableSelect id={row.id} field="paidStatus" value={row.paidStatus} options={["P", "U"]} />
                      </td>
                      <td className="px-2 py-1.5 no-print">
                        <button
                          onClick={() => handleDelete(row.id)}
                          className="text-red-400 hover:text-red-600 font-bold text-base leading-none px-1"
                          title="Delete row"
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  );
                })}

                {/* Phantom draft row — shown when no rows exist for selected date */}
                {draftRow && (
                  <tr className="border-b border-zinc-100 bg-zinc-50 opacity-70">
                    <td className="px-2 py-1.5 w-14">
                      <span className="text-xs text-zinc-400 px-1">{day}</span>
                    </td>
                    <td className="px-2 py-1.5 w-14">
                      <span
                        className="cursor-pointer text-xs text-zinc-400 hover:text-zinc-600 px-1"
                        onClick={() => materializeDraft("inHouseOrOutsourced")}
                      >I</span>
                    </td>
                    {(["outsourcedCompany","vehiclePlate","driverName"] as const).map((f) => (
                      <td key={f} className="px-2 py-1.5 min-w-[80px]">
                        <span
                          className="cursor-pointer text-zinc-300 hover:text-zinc-500 text-xs px-1 min-w-[40px] inline-block"
                          onClick={() => materializeDraft(f)}
                        >—</span>
                      </td>
                    ))}
                    <td className="px-2 py-1.5 text-xs text-zinc-300">—</td>
                    {(["clientDetails","amount","passengerCount","details"] as const).map((f) => (
                      <td key={f} className="px-2 py-1.5 min-w-[80px]">
                        <span
                          className="cursor-pointer text-zinc-300 hover:text-zinc-500 text-xs px-1 min-w-[40px] inline-block"
                          onClick={() => materializeDraft(f)}
                        >—</span>
                      </td>
                    ))}
                    <td className="px-2 py-1.5 w-20">
                      <span className="text-xs text-zinc-300 px-1">0</span>
                    </td>
                    <td className="px-2 py-1.5 min-w-[80px]">
                      <span
                        className="cursor-pointer text-zinc-300 hover:text-zinc-500 text-xs px-1 min-w-[40px] inline-block"
                        onClick={() => materializeDraft("introducer")}
                      >—</span>
                    </td>
                    <td className="px-2 py-1.5 w-14">
                      <span className="text-xs text-zinc-400 px-1">U</span>
                    </td>
                    <td className="px-2 py-1.5 no-print">
                      <span className="text-zinc-200 font-bold text-base px-1">×</span>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
