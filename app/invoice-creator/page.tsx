"use client";

import { useState } from "react";
import Link from "next/link";
import { useUploadContext } from "@/app/upload-context";

interface ExtractedItem {
  route: string;          // "KL - Penang" or "KL - Penang - KL" or "KL Day Trip"
  travelDate: string;
  vehicleCount: number;
  unitPrice: number;
  isOneWay: boolean;
  isAlphard: boolean;
  is15Pax: boolean;
  isCar: boolean;
}

interface ExtractedInvoice {
  customerName: string;
  contactPerson: string;
  customerDetails: string;
  invoiceDate: string;
  items: ExtractedItem[];
  notes: string;
}

const EMPTY_ITEM: ExtractedItem = {
  route: "",
  travelDate: "",
  vehicleCount: 1,
  unitPrice: 0,
  isOneWay: false,
  isAlphard: false,
  is15Pax: false,
  isCar: false,
};

function AnnotationTag({
  label,
  active,
  color,
  onClick,
}: {
  label: string;
  active: boolean;
  color: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2 py-0.5 rounded text-[11px] font-semibold border transition-colors ${
        active
          ? `${color} border-transparent`
          : "bg-white text-zinc-400 border-zinc-300 hover:border-zinc-400"
      }`}
    >
      {label}
    </button>
  );
}

export default function InvoiceCreatorPage() {
  const { setPreviewRows, setUploadOpen } = useUploadContext();

  const [rawText, setRawText] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);

  const [invoice, setInvoice] = useState<ExtractedInvoice | null>(null);
  const [pdfBlob, setPdfBlob] = useState<Blob | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [invoiceNo, setInvoiceNo] = useState<string | null>(null);

  async function handleExtract() {
    setExtractError(null);
    setExtracting(true);
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    setPdfBlob(null);
    setPdfUrl(null);
    setInvoiceNo(null);
    try {
      const res = await fetch("/api/invoice/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: rawText }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Extraction failed");
      setInvoice({
        customerName: data.customerName ?? "",
        contactPerson: data.contactPerson ?? "",
        customerDetails: data.customerDetails ?? "",
        invoiceDate: data.invoiceDate ?? "",
        items: (data.items ?? []).map((it: Partial<ExtractedItem>) => ({
          route: it.route ?? "",
          travelDate: it.travelDate ?? "",
          vehicleCount: Number(it.vehicleCount) || 1,
          unitPrice: Number(it.unitPrice) || 0,
          isOneWay: Boolean(it.isOneWay),
          isAlphard: Boolean(it.isAlphard),
          is15Pax: Boolean(it.is15Pax),
          isCar: Boolean(it.isCar),
        })),
        notes: data.notes ?? "",
      });
    } catch (e) {
      setExtractError(e instanceof Error ? e.message : String(e));
    } finally {
      setExtracting(false);
    }
  }

  async function handleGenerate() {
    if (!invoice) return;
    setGenerateError(null);
    setGenerating(true);
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    setPdfBlob(null);
    setPdfUrl(null);
    setInvoiceNo(null);
    try {
      const res = await fetch("/api/invoice/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(invoice),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "PDF generation failed");
      const bytes = Uint8Array.from(atob(data.pdfBase64), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: "application/pdf" });
      setPdfBlob(blob);
      setPdfUrl(URL.createObjectURL(blob));
      setInvoiceNo(data.invoiceNo);
    } catch (e) {
      setGenerateError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  }

  async function handleConfirmAndSchedule() {
    if (!pdfBlob || !invoiceNo) return;
    setScheduling(true);
    setGenerateError(null);
    try {
      const file = new File([pdfBlob], `${invoiceNo}.pdf`, { type: "application/pdf" });
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/preview", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Parse failed");
      setPreviewRows(data.bookings ?? []);
      setUploadOpen(true);
    } catch (e) {
      setGenerateError(e instanceof Error ? e.message : String(e));
    } finally {
      setScheduling(false);
    }
  }

  function updateItem(idx: number, patch: Partial<ExtractedItem>) {
    if (!invoice) return;
    setInvoice({
      ...invoice,
      items: invoice.items.map((it, i) => (i === idx ? { ...it, ...patch } : it)),
    });
  }

  function addItem() {
    if (!invoice) return;
    setInvoice({ ...invoice, items: [...invoice.items, { ...EMPTY_ITEM }] });
  }

  function removeItem(idx: number) {
    if (!invoice) return;
    setInvoice({ ...invoice, items: invoice.items.filter((_, i) => i !== idx) });
  }

  const runningTotal = invoice
    ? invoice.items.reduce((s, it) => s + (Number(it.vehicleCount) || 0) * (Number(it.unitPrice) || 0), 0)
    : 0;

  return (
    <div className="min-h-screen bg-zinc-50">
      <header className="bg-white border-b border-zinc-200 px-6 py-3 flex items-center gap-6 text-sm">
        <Link href="/" className="font-semibold text-zinc-900 hover:text-blue-600">Home</Link>
        <Link href="/daily-jobs" className="text-zinc-600 hover:text-blue-600">Daily Jobs</Link>
        <Link href="/all-jobs" className="text-zinc-600 hover:text-blue-600">All Jobs</Link>
        <Link href="/van-schedule" className="text-zinc-600 hover:text-blue-600">Van Schedule</Link>
        <span className="text-blue-600 font-semibold">Invoice Creator</span>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8 space-y-6">
        <h1 className="text-2xl font-bold text-zinc-900">Create Invoice</h1>

        {/* Step 1 */}
        <section className="bg-white rounded-xl border border-zinc-200 p-6 space-y-3">
          <h2 className="text-sm font-semibold text-zinc-700 uppercase tracking-wide">Step 1 — Paste booking info</h2>
          <textarea
            className="w-full h-44 border border-zinc-300 rounded-lg p-3 text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder={
              "Paste customer name, trip details, dates, prices...\n\n" +
              "Example:\n" +
              "Customer: ABM Travel Agency\n" +
              "Contact: Ah Chong +60 12-345 6789\n\n" +
              "1. KLIA - KL, 18 April 2026, 2 vans, RM 350/van (One-Way Ride)\n" +
              "2. KL - Malacca - KL, 19 April 2026, 1 van, RM 1000 (Alphard)\n" +
              "3. KL Day Trip, 20 April 2026, 1 van, RM 800 (15 Pax)"
            }
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
          />
          {extractError && <p className="text-red-600 text-sm">{extractError}</p>}
          <button
            onClick={handleExtract}
            disabled={extracting || rawText.trim().length === 0}
            className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            {extracting ? "Extracting…" : "Extract with AI"}
          </button>
        </section>

        {/* Step 2 */}
        {invoice && (
          <section className="bg-white rounded-xl border border-zinc-200 p-6 space-y-5">
            <h2 className="text-sm font-semibold text-zinc-700 uppercase tracking-wide">Step 2 — Review &amp; edit</h2>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-zinc-600 mb-1">Customer Name</label>
                <input className="w-full border border-zinc-300 rounded-lg px-3 py-2 text-sm"
                  value={invoice.customerName}
                  onChange={(e) => setInvoice({ ...invoice, customerName: e.target.value })} />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-600 mb-1">Contact Person</label>
                <input className="w-full border border-zinc-300 rounded-lg px-3 py-2 text-sm"
                  value={invoice.contactPerson}
                  onChange={(e) => setInvoice({ ...invoice, contactPerson: e.target.value })} />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-600 mb-1">Customer Details (phone, WeChat, etc.)</label>
                <input className="w-full border border-zinc-300 rounded-lg px-3 py-2 text-sm"
                  value={invoice.customerDetails}
                  onChange={(e) => setInvoice({ ...invoice, customerDetails: e.target.value })} />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-600 mb-1">Invoice Date</label>
                <input className="w-full border border-zinc-300 rounded-lg px-3 py-2 text-sm"
                  value={invoice.invoiceDate}
                  onChange={(e) => setInvoice({ ...invoice, invoiceDate: e.target.value })} />
              </div>
            </div>

            {/* Items */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-zinc-600 uppercase tracking-wide">Trip Items</span>
                <button onClick={addItem} className="text-xs text-blue-600 hover:underline">+ Add item</button>
              </div>

              {/* Column headers */}
              <div className="grid grid-cols-[1fr_130px_70px_100px_28px] gap-2 px-1">
                <span className="text-[11px] text-zinc-400">Route (use From - To format)</span>
                <span className="text-[11px] text-zinc-400">Travel Date</span>
                <span className="text-[11px] text-zinc-400">Vans</span>
                <span className="text-[11px] text-zinc-400">MYR/Van</span>
                <span />
              </div>

              {invoice.items.map((item, idx) => {
                const isDayTrip = /day.?trip/i.test(item.route);
                return (
                <div key={idx} className="border border-zinc-100 rounded-lg p-3 space-y-2 bg-zinc-50">
                  <div className="grid grid-cols-[1fr_130px_70px_100px_28px] gap-2 items-center">
                    <div className="space-y-0.5">
                      <input
                        className="w-full border border-zinc-300 rounded-lg px-3 py-2 text-sm bg-white"
                        placeholder="KLIA - KL  /  KL - Penang - KL  /  KL Day Trip"
                        value={item.route}
                        onChange={(e) => updateItem(idx, { route: e.target.value })}
                      />
                      {isDayTrip && (
                        <p className="text-[11px] text-emerald-600 pl-1">Day Trip — no destination needed</p>
                      )}
                    </div>
                    <input
                      className="border border-zinc-300 rounded-lg px-3 py-2 text-sm bg-white"
                      placeholder="18 April 2026"
                      value={item.travelDate}
                      onChange={(e) => updateItem(idx, { travelDate: e.target.value })}
                    />
                    <input
                      className="border border-zinc-300 rounded-lg px-3 py-2 text-sm bg-white"
                      type="number" min={1}
                      value={item.vehicleCount}
                      onChange={(e) => updateItem(idx, { vehicleCount: Number(e.target.value) })}
                    />
                    <input
                      className="border border-zinc-300 rounded-lg px-3 py-2 text-sm bg-white"
                      type="number" min={0} step={0.01}
                      value={item.unitPrice}
                      onChange={(e) => updateItem(idx, { unitPrice: Number(e.target.value) })}
                    />
                    <button
                      onClick={() => removeItem(idx)}
                      className="text-zinc-400 hover:text-red-500 text-xl leading-none text-center"
                      title="Remove"
                    >×</button>
                  </div>

                  {/* Annotation tags */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[11px] text-zinc-400 mr-1">Tags:</span>
                    <AnnotationTag
                      label="One-Way Ride"
                      active={item.isOneWay}
                      color="bg-blue-100 text-blue-700"
                      onClick={() => updateItem(idx, { isOneWay: !item.isOneWay })}
                    />
                    <AnnotationTag
                      label="Alphard"
                      active={item.isAlphard}
                      color="bg-purple-100 text-purple-700"
                      onClick={() => updateItem(idx, { isAlphard: !item.isAlphard, isCar: false })}
                    />
                    <AnnotationTag
                      label="15 Pax"
                      active={item.is15Pax}
                      color="bg-orange-100 text-orange-700"
                      onClick={() => updateItem(idx, { is15Pax: !item.is15Pax })}
                    />
                    <AnnotationTag
                      label="Car (outsource)"
                      active={item.isCar}
                      color="bg-zinc-200 text-zinc-600"
                      onClick={() => updateItem(idx, { isCar: !item.isCar, isAlphard: false })}
                    />
                    <span className="text-[11px] text-zinc-300 ml-1">
                      {[
                        item.isOneWay && "(One-Way Ride Only)",
                        item.isAlphard && "(Alphard)",
                        item.is15Pax && "(15 Pax)",
                        item.isCar && "(5-Seater Car)",
                      ].filter(Boolean).join(" ")}
                    </span>
                  </div>
                </div>
              )})}

              <div className="text-right text-sm font-semibold text-zinc-800 pt-1">
                Total: MYR {runningTotal.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-600 mb-1">Notes</label>
              <textarea
                className="w-full border border-zinc-300 rounded-lg px-3 py-2 text-sm resize-none h-16"
                value={invoice.notes}
                onChange={(e) => setInvoice({ ...invoice, notes: e.target.value })}
              />
            </div>

            {generateError && <p className="text-red-600 text-sm">{generateError}</p>}
            <button
              onClick={handleGenerate}
              disabled={generating || invoice.items.length === 0}
              className="px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 disabled:opacity-50"
            >
              {generating ? "Generating PDF…" : "Generate Invoice PDF"}
            </button>
          </section>
        )}

        {/* Step 3 */}
        {pdfUrl && invoiceNo && (
          <section className="bg-white rounded-xl border border-zinc-200 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-zinc-700 uppercase tracking-wide">
                Step 3 — Preview &amp; confirm
              </h2>
              <span className="text-xs text-zinc-500 font-mono bg-zinc-100 px-2 py-1 rounded">{invoiceNo}</span>
            </div>

            <iframe
              src={pdfUrl}
              className="w-full border border-zinc-200 rounded-lg"
              style={{ height: "700px" }}
              title="Invoice Preview"
            />

            <div className="flex items-center gap-3 flex-wrap">
              <a
                href={pdfUrl}
                download={`${invoiceNo} (Scheduler).pdf`}
                className="px-4 py-2 bg-zinc-700 text-white text-sm font-medium rounded-lg hover:bg-zinc-800"
              >
                Download PDF
              </a>
              <button
                onClick={handleConfirmAndSchedule}
                disabled={scheduling}
                className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {scheduling ? "Parsing & opening scheduler…" : "Confirm & Schedule"}
              </button>
              <span className="text-xs text-zinc-400">Sends invoice to van scheduler for van assignment</span>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
