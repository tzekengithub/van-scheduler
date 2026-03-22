"use client";

import { createContext, useContext, useState, useEffect, useRef } from "react";
import type { ReactNode } from "react";

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

interface UploadContextValue {
  uploadOpen: boolean;
  setUploadOpen: (v: boolean) => void;
  serviceStatus: "unknown" | "cold" | "starting" | "ready" | "error";
  parsing: boolean;
  previewRows: PreviewBooking[] | null;
}

const UploadContext = createContext<UploadContextValue | null>(null);

export function useUploadContext() {
  const ctx = useContext(UploadContext);
  if (!ctx) throw new Error("useUploadContext must be used within UploadProvider");
  return ctx;
}

function tripTypeBadge(t: string | null) {
  switch (t) {
    case "one_way_ride": return <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-blue-100 text-blue-800 whitespace-nowrap">🔵 One Way</span>;
    case "round_trip":   return <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-green-100 text-green-800 whitespace-nowrap">🟢 Round Trip</span>;
    case "day_trip":     return <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-yellow-100 text-yellow-800 whitespace-nowrap">🟡 Day Trip</span>;
    default:             return <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-orange-100 text-orange-800 whitespace-nowrap">🟠 Trip</span>;
  }
}

export function UploadProvider({ children }: { children: ReactNode }) {
  const [uploadOpen, setUploadOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [previewRows, setPreviewRows] = useState<PreviewBooking[] | null>(null);
  const [parsing, setParsing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [serviceStatus, setServiceStatus] = useState<"unknown" | "cold" | "starting" | "ready" | "error">("unknown");
  const [countdown, setCountdown] = useState(0);
  const [minimised, setMinimised] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [uploadResults, setUploadResults] = useState<{ fileName: string; inserted: number; error?: string }[] | null>(null);
  const [insertProgress, setInsertProgress] = useState<{
    inserted: number;
    total: number;
    phase: "inserting" | "rechecking";
  } | null>(null);

  const [parseProgress, setParseProgress] = useState<{
    phase: "preview" | "upload";
    current: number;
    total: number;
    currentFile: string;
    startTime: number;
    etaMs: number | null;
  } | null>(null);
  const [progressTick, setProgressTick] = useState(0);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const progressTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Check service health once on mount
  useEffect(() => {
    const check = async () => {
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
    check();
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  // Tick every second while a parse/upload progress bar is active
  useEffect(() => {
    if (!parseProgress) { setProgressTick(0); return; }
    if (progressTimerRef.current) clearInterval(progressTimerRef.current);
    progressTimerRef.current = setInterval(() => setProgressTick((t) => t + 1), 500);
    return () => { if (progressTimerRef.current) clearInterval(progressTimerRef.current); };
  }, [parseProgress]);

  // Auto-show panel when parsing starts or preview is ready
  useEffect(() => {
    if (parsing || previewRows !== null) setUploadOpen(true);
  }, [parsing, previewRows]);

  async function handleFilesSelected(files: File[]) {
    setUploadFiles(files);
    setPreviewRows(null);
    setUploadError(null);
    if (files.length === 0) return;
    setParsing(true);
    const startTime = Date.now();
    try {
      const allBookings: PreviewBooking[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        setParseProgress({
          phase: "preview",
          current: i + 1,
          total: files.length,
          currentFile: file.name,
          startTime,
          etaMs: null,
        });
        const formData = new FormData();
        formData.append("file", file);
        const res = await fetch("/api/preview", { method: "POST", body: formData });
        if (res.ok) {
          const { bookings } = await res.json();
          allBookings.push(...bookings);
        } else {
          const err = await res.json().catch(() => ({}));
          setUploadError(err.error ?? `Failed to parse ${file.name}`);
          setParseProgress(null);
          return;
        }
        // After each file, compute ETA from average time per file so far
        const elapsed = Date.now() - startTime;
        const avgPerFile = elapsed / (i + 1);
        const remaining = files.length - (i + 1);
        setParseProgress((prev) => prev ? { ...prev, etaMs: remaining * avgPerFile } : prev);
      }
      setPreviewRows(allBookings);
    } finally {
      setParsing(false);
      setParseProgress(null);
    }
  }

  async function handleConfirmUpload() {
    if (uploadFiles.length === 0) return;
    setConfirming(true);
    setUploadResults(null);
    setInsertProgress(null);
    const startTime = Date.now();
    try {
      let totalCount = 0;
      const results: { fileName: string; inserted: number; error?: string }[] = [];
      for (let i = 0; i < uploadFiles.length; i++) {
        const file = uploadFiles[i];
        setParseProgress({
          phase: "upload",
          current: i + 1,
          total: uploadFiles.length,
          currentFile: file.name,
          startTime,
          etaMs: null,
        });
        setInsertProgress(null);
        const formData = new FormData();
        formData.append("file", file);
        const res = await fetch("/api/upload", { method: "POST", body: formData });

        let fileInserted = 0;
        let fileError: string | undefined;

        if (res.body) {
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
              if (!part.startsWith("data: ")) continue;
              try {
                const event = JSON.parse(part.slice(6));
                if (event.type === "parsed") {
                  setInsertProgress({ inserted: 0, total: event.total, phase: "inserting" });
                } else if (event.type === "progress") {
                  setInsertProgress({ inserted: event.inserted, total: event.total, phase: "inserting" });
                } else if (event.type === "recheck") {
                  setInsertProgress((prev) => prev ? { ...prev, phase: "rechecking" } : { inserted: 0, total: 0, phase: "rechecking" });
                } else if (event.type === "done") {
                  fileInserted = event.inserted ?? 0;
                } else if (event.type === "error") {
                  fileError = Array.isArray(event.details) && event.details.length > 0
                    ? event.details[0] : (event.error ?? "Upload failed");
                }
              } catch {}
            }
          }
        }

        results.push({ fileName: file.name, inserted: fileInserted, error: fileError });
        totalCount += fileInserted;
        const elapsed = Date.now() - startTime;
        const avgPerFile = elapsed / (i + 1);
        const remaining = uploadFiles.length - (i + 1);
        setParseProgress((prev) => prev ? { ...prev, etaMs: remaining * avgPerFile } : prev);
      }
      setInsertProgress(null);
      window.dispatchEvent(new CustomEvent("bookings-uploaded", { detail: { count: totalCount } }));
      setUploadResults(results);
      setPreviewRows(null);
      setUploadError(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } finally {
      setConfirming(false);
      setParseProgress(null);
      setInsertProgress(null);
    }
  }

  function handleCancelUpload() {
    setUploadFiles([]);
    setPreviewRows(null);
    setUploadError(null);
    setUploadResults(null);
    setUploadOpen(false);
    setMinimised(false);
    setFullscreen(false);
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
    for (let i = 0; i < 20; i++) {
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

  const showPanel = uploadOpen || parsing || previewRows !== null || confirming || uploadResults !== null;

  return (
    <UploadContext.Provider value={{ uploadOpen, setUploadOpen, serviceStatus, parsing, previewRows }}>
      {children}

      {/* ── Floating upload panel (persists across page navigation) ── */}
      {showPanel && (
        <div className={`fixed z-50 flex flex-col bg-white shadow-2xl border border-zinc-200 overflow-hidden no-print transition-all duration-200 ${
          fullscreen
            ? "inset-0 rounded-none"
            : `bottom-4 right-4 w-[640px] rounded-xl${minimised ? "" : " max-h-[82vh]"}`
        }`}>

          {/* Header */}
          <div
            className="flex items-center justify-between px-4 py-3 bg-zinc-50 border-b border-zinc-200 shrink-0 select-none"
            onDoubleClick={() => { setMinimised((m) => !m); setFullscreen(false); }}
          >
            <div className="flex items-center gap-3">
              <span className="text-sm font-semibold text-zinc-900">Upload Invoice PDF</span>
              {parsing && (
                <span className="flex items-center gap-1.5 text-xs text-amber-600">
                  <svg className="animate-spin h-3.5 w-3.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                  </svg>
                  Parsing…
                </span>
              )}
              {confirming && (
                <span className="text-xs text-blue-600">
                  {insertProgress?.phase === "rechecking"
                    ? "Rechecking vans…"
                    : insertProgress
                    ? `Inserting ${insertProgress.inserted} / ${insertProgress.total} rows…`
                    : "Uploading…"}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              {/* Minimise / restore */}
              <button
                onClick={() => { setMinimised((m) => !m); setFullscreen(false); }}
                className="text-zinc-400 hover:text-zinc-700 px-1.5 py-0.5 rounded hover:bg-zinc-200 transition-colors"
                title={minimised ? "Restore" : "Minimise"}
              >
                {minimised ? (
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M14.707 12.293a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 111.414-1.414L10 15.586l3.293-3.293a1 1 0 011.414 0z" clipRule="evenodd"/>
                    <path fillRule="evenodd" d="M5.293 7.707a1 1 0 010-1.414l4-4a1 1 0 011.414 0l4 4a1 1 0 01-1.414 1.414L10 4.414 6.707 7.707a1 1 0 01-1.414 0z" clipRule="evenodd"/>
                  </svg>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clipRule="evenodd"/>
                  </svg>
                )}
              </button>
              {/* Fullscreen / exit fullscreen */}
              <button
                onClick={() => { setFullscreen((f) => !f); setMinimised(false); }}
                className="text-zinc-400 hover:text-zinc-700 px-1.5 py-0.5 rounded hover:bg-zinc-200 transition-colors"
                title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
              >
                {fullscreen ? (
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M5 4a1 1 0 00-1 1v3a1 1 0 01-2 0V5a3 3 0 013-3h3a1 1 0 010 2H5zm10 0h-3a1 1 0 010-2h3a3 3 0 013 3v3a1 1 0 01-2 0V5a1 1 0 00-1-1zM4 15a1 1 0 001 1h3a1 1 0 010 2H5a3 3 0 01-3-3v-3a1 1 0 012 0v3zm12 0v-3a1 1 0 012 0v3a3 3 0 01-3 3h-3a1 1 0 010-2h3a1 1 0 001-1z" clipRule="evenodd"/>
                  </svg>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M3 4a1 1 0 011-1h4a1 1 0 010 2H6.414l2.293 2.293a1 1 0 11-1.414 1.414L5 6.414V8a1 1 0 01-2 0V4zm9 1a1 1 0 010-2h4a1 1 0 011 1v4a1 1 0 01-2 0V6.414l-2.293 2.293a1 1 0 11-1.414-1.414L13.586 5H12zm-9 7a1 1 0 012 0v1.586l2.293-2.293a1 1 0 111.414 1.414L6.414 15H8a1 1 0 010 2H4a1 1 0 01-1-1v-4zm13-1a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 010-2h1.586l-2.293-2.293a1 1 0 111.414-1.414L15 13.586V12a1 1 0 011-1z" clipRule="evenodd"/>
                  </svg>
                )}
              </button>
              {/* Close */}
              <button
                onClick={handleCancelUpload}
                disabled={confirming}
                className="text-zinc-400 hover:text-zinc-700 text-xl font-bold leading-none disabled:opacity-30 px-1.5 py-0.5 rounded hover:bg-zinc-200 transition-colors"
                title="Close"
              >
                ×
              </button>
            </div>
          </div>

          {/* Body — hidden when minimised */}
          {!minimised && <>

          {/* Service status bar */}
          <div className="px-4 pt-3 shrink-0">
            {serviceStatus === "unknown" && (
              <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-xs">
                <div className="w-2 h-2 rounded-full bg-gray-400 shrink-0" />
                <span className="text-gray-500">Checking PDF service…</span>
              </div>
            )}
            {serviceStatus === "cold" && (
              <div className="flex items-center gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-xs">
                <div className="w-2 h-2 rounded-full bg-amber-400 shrink-0" />
                <span className="text-amber-700">PDF service is sleeping</span>
                <button onClick={startService} className="ml-auto px-3 py-1 bg-blue-600 text-white text-xs font-medium rounded-lg hover:bg-blue-700">
                  Start PDF Service
                </button>
              </div>
            )}
            {serviceStatus === "starting" && (
              <div className="flex items-center gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-xs">
                <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse shrink-0" />
                <span className="text-amber-700">Starting PDF service…</span>
                <span className="ml-auto font-mono text-amber-600">{countdown}s</span>
              </div>
            )}
            {serviceStatus === "ready" && (
              <div className="flex items-center gap-2 px-3 py-2 bg-green-50 border border-green-200 rounded-lg text-xs">
                <div className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
                <span className="text-green-700">PDF service ready — you can upload invoices</span>
              </div>
            )}
            {serviceStatus === "error" && (
              <div className="flex items-center gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-xs">
                <div className="w-2 h-2 rounded-full bg-red-500 shrink-0" />
                <span className="text-red-700">PDF service failed to start</span>
                <button onClick={startService} className="ml-auto px-3 py-1 bg-red-600 text-white text-xs font-medium rounded-lg hover:bg-red-700">
                  Retry
                </button>
              </div>
            )}
          </div>

          {/* Scrollable body */}
          <div className="overflow-y-auto flex-1 p-4">

            {/* Drop zone (shown when no files picked and not parsing) */}
            {uploadFiles.length === 0 && !parsing && (
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

            {/* Parsing / upload progress */}
            {(parsing || confirming) && parseProgress && (() => {
              const elapsedMs = Date.now() - parseProgress.startTime + (progressTick * 0); // progressTick triggers re-render
              const elapsedMs2 = Date.now() - parseProgress.startTime;
              const elapsedSec = Math.floor(elapsedMs2 / 1000);
              const pct = Math.round((parseProgress.current - 1) / parseProgress.total * 100);
              const etaSec = parseProgress.etaMs != null ? Math.ceil(parseProgress.etaMs / 1000) : null;
              const phaseLabel = parseProgress.phase === "preview" ? "Parsing" : "Uploading";
              return (
                <div className="py-6 px-2 space-y-4">
                  {/* File counter + phase */}
                  <div className="flex items-center justify-between text-xs font-medium text-zinc-700">
                    <span className="flex items-center gap-1.5">
                      <svg className="animate-spin h-3.5 w-3.5 text-amber-500 shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                      </svg>
                      {phaseLabel} file {parseProgress.current} of {parseProgress.total}
                    </span>
                    <span className="text-zinc-400 font-mono">{pct}%</span>
                  </div>

                  {/* Progress bar */}
                  <div className="w-full h-2 bg-zinc-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-amber-400 rounded-full transition-all duration-300"
                      style={{ width: `${pct}%` }}
                    />
                  </div>

                  {/* Current file name */}
                  <div className="text-xs text-zinc-500 truncate" title={parseProgress.currentFile}>
                    📄 {parseProgress.currentFile}
                  </div>

                  {/* Elapsed + ETA */}
                  <div className="flex items-center justify-between text-xs text-zinc-400">
                    <span>Elapsed: <span className="font-mono text-zinc-600">{elapsedSec < 60 ? `${elapsedSec}s` : `${Math.floor(elapsedSec/60)}m ${elapsedSec%60}s`}</span></span>
                    <span>
                      {etaSec === null
                        ? "Estimating…"
                        : etaSec === 0
                        ? "Almost done"
                        : <>ETA: <span className="font-mono text-zinc-600">~{etaSec < 60 ? `${etaSec}s` : `${Math.floor(etaSec/60)}m ${etaSec%60}s`}</span></>
                      }
                    </span>
                  </div>

                  {/* Per-file chips */}
                  {parseProgress.total > 1 && (
                    <div className="flex flex-wrap gap-1.5 mt-1">
                      {uploadFiles.map((f, i) => {
                        const done = i < parseProgress.current - 1;
                        const active = i === parseProgress.current - 1;
                        return (
                          <span
                            key={i}
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border truncate max-w-[160px] ${
                              done    ? "bg-green-50 border-green-200 text-green-700" :
                              active  ? "bg-amber-50 border-amber-300 text-amber-700" :
                                        "bg-zinc-50 border-zinc-200 text-zinc-400"
                            }`}
                            title={f.name}
                          >
                            {done ? "✓" : active ? "⟳" : "○"} {f.name}
                          </span>
                        );
                      })}
                    </div>
                  )}

                  {/* Row-level insertion progress (upload phase only) */}
                  {confirming && insertProgress && (
                    <div className="mt-3 space-y-1.5 border-t border-zinc-100 pt-3">
                      {insertProgress.phase === "rechecking" ? (
                        <div className="flex items-center gap-2 text-xs text-indigo-600">
                          <svg className="animate-spin h-3 w-3 shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                          </svg>
                          Rechecking van assignments…
                        </div>
                      ) : (
                        <>
                          <div className="flex items-center justify-between text-xs text-zinc-600">
                            <span>Inserting rows</span>
                            <span className="font-mono tabular-nums">
                              {insertProgress.inserted} / {insertProgress.total}
                            </span>
                          </div>
                          <div className="w-full h-1.5 bg-zinc-100 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-blue-500 rounded-full transition-all duration-150"
                              style={{ width: `${insertProgress.total > 0 ? Math.round(insertProgress.inserted / insertProgress.total * 100) : 0}%` }}
                            />
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Simple spinner fallback when no progress state yet */}
            {parsing && !parseProgress && (
              <div className="flex items-center gap-3 py-8 justify-center text-zinc-500 text-sm">
                <svg className="animate-spin h-5 w-5 text-zinc-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                </svg>
                Parsing…
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
              <div className="mt-2">
                <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">
                  Preview — {previewRows.length} row{previewRows.length !== 1 ? "s" : ""} found
                  {uploadFiles.length > 0 && ` in ${uploadFiles.map((f) => f.name).join(", ")}`}
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
                          <td className="px-3 py-1.5">{tripTypeBadge(r.tripType)}</td>
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
                    disabled={confirming}
                    className="h-9 px-4 rounded-lg border border-zinc-300 bg-white text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {previewRows && previewRows.length === 0 && !parsing && (
              <div className="mt-3 text-sm text-zinc-500">No bookings found in this PDF. Check the file format.</div>
            )}

            {/* Upload results screen */}
            {uploadResults && (
              <div className="mt-3">
                <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">
                  Upload Complete — {uploadResults.reduce((s, r) => s + r.inserted, 0)} row{uploadResults.reduce((s, r) => s + r.inserted, 0) !== 1 ? "s" : ""} inserted
                </p>
                <div className="rounded-lg border border-zinc-200 overflow-hidden">
                  {uploadResults.map((r, i) => (
                    <div key={i} className={`flex items-center gap-3 px-4 py-2.5 text-sm border-b border-zinc-100 last:border-b-0 ${r.error ? "bg-red-50" : r.inserted === 0 ? "bg-amber-50" : "bg-white"}`}>
                      <span className="text-base leading-none shrink-0">
                        {r.error ? "❌" : r.inserted === 0 ? "⚠️" : "✅"}
                      </span>
                      <span className="font-mono text-zinc-700 truncate flex-1">{r.fileName}</span>
                      <span className={`shrink-0 font-medium ${r.error ? "text-red-600" : r.inserted === 0 ? "text-amber-600" : "text-green-700"}`}>
                        {r.error ? "Failed" : r.inserted === 0 ? "0 rows (skipped)" : `${r.inserted} row${r.inserted !== 1 ? "s" : ""}`}
                      </span>
                    </div>
                  ))}
                </div>
                {uploadResults.some((r) => r.error) && (
                  <p className="mt-2 text-xs text-red-600">{uploadResults.find((r) => r.error)?.error}</p>
                )}
                {uploadResults.some((r) => r.inserted === 0 && !r.error) && (
                  <p className="mt-2 text-xs text-amber-600">⚠️ Skipped files had no parseable booking rows (e.g. overtime-only invoices).</p>
                )}
                <button
                  onClick={handleCancelUpload}
                  className="mt-4 h-9 px-5 rounded-lg bg-zinc-900 text-white text-sm font-medium hover:bg-zinc-700"
                >
                  Done
                </button>
              </div>
            )}
          </div>

          </>}
        </div>
      )}
    </UploadContext.Provider>
  );
}
