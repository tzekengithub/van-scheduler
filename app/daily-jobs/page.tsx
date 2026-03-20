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
  "bg-blue-50","bg-emerald-50","bg-amber-50","bg-rose-50",
  "bg-violet-50","bg-cyan-50","bg-orange-50","bg-pink-50",
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
  amount: number;
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
  const [cellStates, setCellStates] = useState<Record<string, "saving" | "saved" | "error">>({});

  // Upload zone
  const [uploadOpen, setUploadOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [previewRows, setPreviewRows] = useState<PreviewBooking[] | null>(null);
  const [parsing, setParsing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

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
          const next = { ...prev };
          delete next[key];
          return next;
        }), 1000);
      } else {
        console.error("Failed to save:", field, value);
        setCellStates((prev) => ({ ...prev, [key]: "error" }));
      }
    } catch (err) {
      console.error("patchRow network error:", err);
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
    if (res.ok) {
      await fetchRows();
    }
  }

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

  async function handleAddRow() {
    const res = await fetch("/api/bookings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ day, month, year }),
    });
    if (res.ok) {
      const newRow: BookingRow = await res.json();
      setRows((prev) => [...prev, newRow]);
      setDraftRow(false);
    }
  }

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
        if (res.ok) {
          const { count } = await res.json();
          totalCount += count;
        } else {
          const err = await res.json().catch(() => ({}));
          setUploadError(err.error ?? `Upload failed for ${file.name}`);
          return;
        }
      }
      setUploadOpen(false);
      setUploadFiles([]);
      setPreviewRows(null);
      setUploadError(null);
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
        }
      }
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

  function openUploadZone() {
    setUploadOpen(true);
    setUploadFiles([]);
    setPreviewRows(null);
    setUploadError(null);
  }

  const totalAmount = rows.reduce((sum, r) => sum + parseFloat(r.amount ?? "0"), 0);
  const paidCount = rows.filter((r) => r.paidStatus === "P").length;
  const unpaidCount = rows.filter((r) => r.paidStatus !== "P").length;

  function vanRowColor(vanId: number | null): string {
    if (vanId == null) return "";
    return BADGE_COLORS[(vanId - 1) % BADGE_COLORS.length];
  }

  function EditableText({ id, field, value }: { id: number; field: string; value: string | null }) {
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
        {value || <span className="text-zinc-300">—</span>}
      </span>
    );
  }

  function EditableSelect({ id, field, value, options }: { id: number; field: string; value: string | null; options: string[] }) {
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

      {/* Header */}
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

      <main className="px-4 py-6 space-y-4">

        {/* Section 1 — Top bar */}
        <div className="flex gap-3 items-end flex-wrap no-print">
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
          <div className="flex gap-2 ml-2">
            <button
              onClick={openUploadZone}
              className="h-9 px-4 rounded-lg border border-zinc-300 bg-white text-sm font-medium text-zinc-900 hover:bg-zinc-50 transition-colors"
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

        {/* Print heading */}
        <div className="text-sm font-semibold text-zinc-900 hidden print:block">
          Daily Jobs Record — {day} {month} {year}
        </div>

        {/* Section 2 — Upload zone (collapsible) */}
        {uploadOpen && (
          <div className="no-print bg-white rounded-xl border border-zinc-200 shadow-sm p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-zinc-900">Upload Invoice PDF</h2>
              <button
                onClick={handleCancelUpload}
                className="text-zinc-400 hover:text-zinc-700 text-lg leading-none font-bold"
              >
                ×
              </button>
            </div>

            {/* Drop zone */}
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

            {/* Parsing spinner */}
            {parsing && (
              <div className="flex items-center gap-3 py-6 justify-center text-zinc-500 text-sm">
                <svg className="animate-spin h-5 w-5 text-zinc-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                </svg>
                Parsing PDF…
              </div>
            )}

            {/* Error */}
            {uploadError && (
              <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800 mt-3">
                {uploadError}
              </div>
            )}

            {/* Preview table */}
            {previewRows && previewRows.length > 0 && (
              <div className="mt-4">
                <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">
                  Preview — {previewRows.length} booking{previewRows.length !== 1 ? "s" : ""} found in {uploadFiles.map((f) => f.name).join(", ")}
                </p>
                <div className="overflow-auto rounded-lg border border-zinc-200">
                  <table className="w-full text-xs border-collapse">
                    <thead>
                      <tr className="bg-zinc-50 border-b border-zinc-200">
                        {["Date", "Invoice #", "Client", "Details", "Pax", "Amount (MYR)"].map((h) => (
                          <th key={h} className="px-3 py-2 text-left font-semibold text-zinc-600 whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {previewRows.map((r, i) => (
                        <tr key={i} className="border-b border-zinc-100">
                          <td className="px-3 py-1.5 text-zinc-900 whitespace-nowrap">{r.day} {r.month} {r.year}</td>
                          <td className="px-3 py-1.5 text-zinc-500 font-mono whitespace-nowrap">{r.invoiceNo}</td>
                          <td className="px-3 py-1.5 text-zinc-900">{r.clientDetails}</td>
                          <td className="px-3 py-1.5 text-zinc-900">{r.details}</td>
                          <td className="px-3 py-1.5 text-zinc-900 text-center">{r.numberOfVehicles}</td>
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
                    className="h-9 px-5 rounded-lg bg-zinc-900 text-white text-sm font-medium hover:bg-zinc-700 disabled:opacity-50 transition-colors"
                  >
                    {confirming ? "Inserting…" : `Confirm — Insert ${previewRows.length} row${previewRows.length !== 1 ? "s" : ""}`}
                  </button>
                  <button
                    onClick={handleCancelUpload}
                    className="h-9 px-4 rounded-lg border border-zinc-300 bg-white text-sm font-medium text-zinc-700 hover:bg-zinc-50 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {previewRows && previewRows.length === 0 && !parsing && (
              <div className="mt-3 text-sm text-zinc-500">
                No bookings found in this PDF. Check the file format.
              </div>
            )}
          </div>
        )}

        {/* Section 3 — Summary bar */}
        {!loading && (
          <div className="no-print flex gap-6 text-sm text-zinc-900 bg-white rounded-lg border border-zinc-200 px-4 py-2 w-fit">
            <span>Rows: <strong>{rows.length}</strong></span>
            <span>Total: <strong>MYR {totalAmount.toFixed(2)}</strong></span>
            <span>Paid: <strong className="text-green-600">{paidCount}</strong></span>
            <span>Unpaid: <strong className="text-red-500">{unpaidCount}</strong></span>
          </div>
        )}

        {/* Section 4 — Daily jobs table */}
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
                      className={`px-2 py-2.5 text-left font-semibold text-zinc-900 whitespace-nowrap${i === colHeaders.length - 1 ? " no-print" : ""}`}
                    >
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  return (
                    <tr key={row.id} className={`border-b border-zinc-100 hover:brightness-95 ${vanRowColor(row.vanId)}`}>
                      <td className="px-2 py-1.5 w-14">
                        <EditableSelect id={row.id} field="day" value={row.day} options={DAYS_LIST} />
                      </td>
                      <td className="px-2 py-1.5 w-14">
                        <select
                          className={`text-xs border rounded px-1 py-0.5 w-full bg-white text-zinc-900 ${
                            cellStates[`${row.id}-inHouseOrOutsourced`] === "saving" ? "border-zinc-300 animate-pulse" :
                            cellStates[`${row.id}-inHouseOrOutsourced`] === "saved"  ? "border-green-400" :
                            cellStates[`${row.id}-inHouseOrOutsourced`] === "error"  ? "border-red-400" : "border-zinc-300"
                          }`}
                          value={row.inHouseOrOutsourced ?? "I"}
                          onChange={async (e) => {
                            const val = e.target.value;
                            if (val === "I") {
                              await patchRow(row.id, "inHouseOrOutsourced", "I");
                              await patchRow(row.id, "outsourcedCompany", "");
                            } else {
                              await patchRow(row.id, "inHouseOrOutsourced", val);
                            }
                          }}
                        >
                          <option value="I">I</option>
                          <option value="O">O</option>
                        </select>
                      </td>
                      <td className="px-2 py-1.5 min-w-[100px]">
                        {row.inHouseOrOutsourced === "O" ? (
                          <input
                            autoFocus
                            className={`w-full border rounded px-1 py-0.5 text-xs text-zinc-900 bg-white ${
                              cellStates[`${row.id}-outsourcedCompany`] === "saving" ? "border-zinc-300 animate-pulse" :
                              cellStates[`${row.id}-outsourcedCompany`] === "saved"  ? "border-green-400" :
                              cellStates[`${row.id}-outsourcedCompany`] === "error"  ? "border-red-400" : "border-zinc-300"
                            }`}
                            defaultValue={row.outsourcedCompany ?? ""}
                            placeholder="Company name"
                            key={`oc-${row.id}`}
                            onBlur={(e) => patchRow(row.id, "outsourcedCompany", e.target.value)}
                          />
                        ) : (
                          <span className="text-xs text-zinc-400 px-1 block bg-zinc-100 rounded cursor-not-allowed">—</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 min-w-[80px]">
                        <EditableText id={row.id} field="vehiclePlate" value={row.vehiclePlate} />
                      </td>
                      <td className="px-2 py-1.5 min-w-[80px]">
                        <EditableText id={row.id} field="driverName" value={row.driverName} />
                      </td>
                      <td className="px-2 py-1.5 font-mono whitespace-nowrap text-zinc-900 text-xs">
                        {row.invoiceNo ?? ""}
                      </td>
                      <td className="px-2 py-1.5 min-w-[130px]">
                        <EditableText id={row.id} field="clientDetails" value={row.clientDetails} />
                      </td>
                      <td className="px-2 py-1.5 min-w-[80px]">
                        <EditableText id={row.id} field="amount" value={row.amount} />
                      </td>
                      <td className="px-2 py-1.5 w-14">
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
                        <EditableSelect id={row.id} field="paidStatus" value={row.paidStatus} options={["P","U"]} />
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

                {/* Phantom draft row */}
                {draftRow && (
                  <tr className="border-b border-zinc-100 bg-zinc-50 opacity-70">
                    <td className="px-2 py-1.5 w-14">
                      <span className="text-xs text-zinc-900 px-1">{day}</span>
                    </td>
                    <td className="px-2 py-1.5 w-14">
                      <span className="cursor-pointer text-xs text-zinc-400 hover:text-zinc-600 px-1" onClick={() => materializeDraft("inHouseOrOutsourced")}>I</span>
                    </td>
                    {(["outsourcedCompany","vehiclePlate","driverName"] as const).map((f) => (
                      <td key={f} className="px-2 py-1.5 min-w-[80px]">
                        <span className="cursor-pointer text-zinc-300 hover:text-zinc-500 text-xs px-1 min-w-[40px] inline-block" onClick={() => materializeDraft(f)}>—</span>
                      </td>
                    ))}
                    <td className="px-2 py-1.5 text-xs text-zinc-300">—</td>
                    {(["clientDetails","amount","passengerCount","details"] as const).map((f) => (
                      <td key={f} className="px-2 py-1.5 min-w-[80px]">
                        <span className="cursor-pointer text-zinc-300 hover:text-zinc-500 text-xs px-1 min-w-[40px] inline-block" onClick={() => materializeDraft(f)}>—</span>
                      </td>
                    ))}
                    <td className="px-2 py-1.5 w-20"><span className="text-xs text-zinc-300 px-1">0</span></td>
                    <td className="px-2 py-1.5 min-w-[80px]">
                      <span className="cursor-pointer text-zinc-300 hover:text-zinc-500 text-xs px-1 min-w-[40px] inline-block" onClick={() => materializeDraft("introducer")}>—</span>
                    </td>
                    <td className="px-2 py-1.5 w-14"><span className="text-xs text-zinc-400 px-1">U</span></td>
                    <td className="px-2 py-1.5 no-print"><span className="text-zinc-200 font-bold text-base px-1">×</span></td>
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
