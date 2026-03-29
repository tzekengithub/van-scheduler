"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";

const LOCATIONS = ["KL", "Singapore", "Penang", "Johor Bahru", "Ipoh", "Melaka", "Kuantan", "Kota Kinabalu", "Kuching", "Other"];

interface Van {
  id: number;
  vanNumber: string;
  driverName: string | null;
  driverContact: string | null;
  singaporeEnabled: number;
  thailandEnabled: number;
  maxPaxCapacity: number | null;
  location: string | null;
}

const BADGE_COLORS = [
  "bg-blue-100 text-blue-800 border-blue-200",
  "bg-emerald-100 text-emerald-800 border-emerald-200",
  "bg-amber-100 text-amber-800 border-amber-200",
  "bg-rose-100 text-rose-800 border-rose-200",
  "bg-violet-100 text-violet-800 border-violet-200",
  "bg-cyan-100 text-cyan-800 border-cyan-200",
  "bg-orange-100 text-orange-800 border-orange-200",
  "bg-pink-100 text-pink-800 border-pink-200",
];

export default function DashboardPage() {
  const [vans, setVans] = useState<Van[]>([]);
  const [vanLoading, setVanLoading] = useState(false);
  const [newPlate, setNewPlate] = useState("");
  const [newDriverName, setNewDriverName] = useState("");
  const [newDriverContact, setNewDriverContact] = useState("");
  const [newSingapore, setNewSingapore] = useState(false);
  const [newThailand, setNewThailand] = useState(false);
  const [newMaxPax, setNewMaxPax] = useState(4);
  const [newLocation, setNewLocation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [showClearAllModal, setShowClearAllModal] = useState(false);
  const [showClearDuplicatesModal, setShowClearDuplicatesModal] = useState(false);
  const [actionMessage, setActionMessage] = useState('');
  const [rechecking, setRechecking] = useState(false);
  const [recheckLogs, setRecheckLogs] = useState<string[]>([]);
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [aiReasoning, setAiReasoning] = useState<Array<{ bookingId: number; van: string | null; action: string; reasoning: string }>>([]);
  const [showReasoning, setShowReasoning] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [recheckLogs]);

  const fetchVans = useCallback(async () => {
    try {
      const res = await fetch("/api/vans");
      if (res.ok) setVans(await res.json());
    } catch {}
  }, []);

  useEffect(() => { fetchVans(); }, [fetchVans]);

  async function handleAddVan(e: React.FormEvent) {
    e.preventDefault();
    if (!newPlate.trim() || !newDriverName.trim()) return;
    setVanLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch("/api/vans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vanNumber: newPlate,
          driverName: newDriverName,
          driverContact: newDriverContact,
          singaporeEnabled: newSingapore,
          thailandEnabled: newThailand,
          maxPaxCapacity: newMaxPax,
          location: newLocation,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to add van");
      setSuccess(`Van ${data.vanNumber} added`);
      setNewPlate("");
      setNewDriverName("");
      setNewDriverContact("");
      setNewSingapore(false);
      setNewThailand(false);
      setNewMaxPax(4);
      setNewLocation("");
      await fetchVans();
    } catch (e) {
      setError(String(e));
    } finally {
      setVanLoading(false);
    }
  }

  async function handleToggleCapability(id: number, field: "singaporeEnabled" | "thailandEnabled", current: number) {
    setError(null);
    try {
      const res = await fetch("/api/vans", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, [field]: current === 1 ? 0 : 1 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to update van");
      await fetchVans();
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleDeleteVan(id: number, plate: string) {
    if (!confirm(`Remove van ${plate}? It will be unassigned from any bookings.`)) return;
    setError(null);
    try {
      const res = await fetch("/api/vans", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to delete van");
      setSuccess(`Van ${plate} removed`);
      await fetchVans();
    } catch (e) {
      setError(String(e));
    }
  }

  const handleClearAll = async () => {
    setShowClearAllModal(false);
    const res = await fetch('/api/clear', { method: 'POST' });
    if (res.ok) {
      setActionMessage('All bookings deleted successfully');
    } else {
      setActionMessage('Failed to delete bookings');
    }
  };

  const handleClearDuplicates = async () => {
    setShowClearDuplicatesModal(false);
    const res = await fetch('/api/bookings/duplicates', { method: 'DELETE' });
    if (res.ok) {
      setActionMessage('Duplicate bookings removed successfully');
    } else {
      setActionMessage('Failed to remove duplicates');
    }
  };

  const handleRecheck = async () => {
    setRechecking(true);
    setActionMessage('');
    setRecheckLogs([]);
    setAiSummary(null);
    setAiReasoning([]);
    setShowReasoning(false);
    try {
      const res = await fetch('/api/reassign', { method: 'POST' });
      if (!res.ok || !res.body) {
        setActionMessage('❌ Recheck failed: network error');
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith('data: ')) continue;
          let payload: string;
          try { payload = JSON.parse(line.slice(6)); } catch { continue; }
          if (payload === '[DONE]') {
            setActionMessage('✅ Van assignments rechecked — same invoice = same van enforced, no double-bookings.');
          } else if (payload.startsWith('[ERROR]')) {
            setActionMessage(`❌ Recheck failed: ${payload.slice(7).trim()}`);
          } else if (payload.startsWith('[AI_SUMMARY]')) {
            try {
              const aiData = JSON.parse(payload.slice('[AI_SUMMARY]'.length));
              setAiSummary(aiData.summary ?? '');
              setAiReasoning(aiData.reasoning ?? []);
            } catch {}
          } else {
            setRecheckLogs(prev => [...prev, payload]);
          }
        }
      }
    } catch {
      setActionMessage('❌ Recheck failed: network error');
    } finally {
      setRechecking(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-50 font-sans">
      <header className="bg-white border-b border-zinc-200 px-6 py-4">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-zinc-900">Van Scheduler</h1>
            <p className="text-sm text-zinc-500 mt-0.5">Manage vans and drivers</p>
          </div>
          <nav className="flex gap-4 text-sm font-medium">
            <span className="text-zinc-900 border-b-2 border-zinc-900 pb-0.5">Dashboard</span>
            <Link href="/daily-jobs" className="text-zinc-500 hover:text-zinc-900 transition-colors">Daily Jobs</Link>
            <Link href="/all-jobs" className="text-zinc-500 hover:text-zinc-900 transition-colors">All Jobs</Link>
            <Link href="/van-schedule" className="text-zinc-500 hover:text-zinc-900 transition-colors">Van Schedule</Link>
          </nav>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-8 space-y-4">
        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800">{error}</div>
        )}
        {success && (
          <div className="rounded-lg bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-800">{success}</div>
        )}

        <div className="bg-white rounded-xl border border-zinc-200 shadow-sm p-5">
          <h2 className="text-sm font-semibold text-zinc-700 mb-4">Van / Plate Management</h2>
          <form onSubmit={handleAddVan} className="flex flex-wrap gap-2 mb-4 items-end">
            <input
              type="text"
              value={newPlate}
              onChange={(e) => setNewPlate(e.target.value)}
              placeholder="e.g. VKB 8468"
              required
              className="h-9 w-36 px-3 rounded-lg border border-zinc-300 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-400 uppercase"
            />
            <input
              type="text"
              value={newDriverName}
              onChange={(e) => setNewDriverName(e.target.value)}
              placeholder="e.g. Lee Yoke Khuan"
              required
              className="h-9 flex-1 min-w-[160px] px-3 rounded-lg border border-zinc-300 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-400"
            />
            <input
              type="text"
              value={newDriverContact}
              onChange={(e) => setNewDriverContact(e.target.value)}
              placeholder="e.g. +60 12-xxx xxxx"
              className="h-9 w-40 px-3 rounded-lg border border-zinc-300 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-400"
            />
            <select
              value={newLocation}
              onChange={(e) => setNewLocation(e.target.value)}
              className="h-9 px-2 rounded-lg border border-zinc-300 text-sm text-zinc-900 bg-white focus:outline-none focus:ring-2 focus:ring-zinc-400"
            >
              <option value="">📍 Base</option>
              {LOCATIONS.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
            <div className="flex items-center gap-1.5 h-9 px-3 rounded-lg border border-zinc-300 bg-white text-sm text-zinc-700">
              <span className="text-zinc-500">👥</span>
              <input
                type="number"
                min={1}
                max={50}
                value={newMaxPax}
                onChange={(e) => setNewMaxPax(Number(e.target.value))}
                className="w-10 text-center focus:outline-none text-zinc-900"
                title="Max passenger capacity"
              />
              <span className="text-zinc-400 text-xs">total seats</span>
            </div>
            <label className="flex items-center gap-1.5 h-9 px-3 rounded-lg border border-zinc-300 bg-white text-sm text-zinc-700 cursor-pointer select-none hover:bg-zinc-50">
              <input
                type="checkbox"
                checked={newSingapore}
                onChange={(e) => setNewSingapore(e.target.checked)}
                className="accent-red-500"
              />
              🇸🇬 SG
            </label>
            <label className="flex items-center gap-1.5 h-9 px-3 rounded-lg border border-zinc-300 bg-white text-sm text-zinc-700 cursor-pointer select-none hover:bg-zinc-50">
              <input
                type="checkbox"
                checked={newThailand}
                onChange={(e) => setNewThailand(e.target.checked)}
                className="accent-blue-500"
              />
              🇹🇭 TH
            </label>
            <button
              type="submit"
              disabled={vanLoading || !newPlate.trim() || !newDriverName.trim()}
              className="h-9 px-4 rounded-lg bg-zinc-900 text-white text-sm font-medium hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
            >
              {vanLoading ? "Adding…" : "Add Van"}
            </button>
          </form>

          {vans.length === 0 ? (
            <p className="text-xs text-zinc-400">No vans added yet.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {vans.map((van, i) => (
                <div
                  key={van.id}
                  className={`flex items-start gap-2 px-3 py-2 rounded-xl border text-xs font-semibold ${BADGE_COLORS[i % BADGE_COLORS.length]}`}
                >
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span>{van.vanNumber}</span>
                    {van.driverName && (
                      <span className="font-normal opacity-70">Driver: {van.driverName}</span>
                    )}
                    {van.driverContact && (
                      <span className="font-normal opacity-60">{van.driverContact}</span>
                    )}
                    {van.maxPaxCapacity != null && (
                      <span className="font-normal opacity-60 text-[11px]">👥 {(van.maxPaxCapacity ?? 1) - 1}+1 seats</span>
                    )}
                    <div className="flex gap-1 mt-1">
                      <button
                        onClick={() => handleToggleCapability(van.id, "singaporeEnabled", van.singaporeEnabled)}
                        title={van.singaporeEnabled ? "Singapore enabled — click to disable" : "Singapore disabled — click to enable"}
                        className={`px-1.5 py-0.5 rounded text-[10px] font-semibold transition-all ${
                          van.singaporeEnabled
                            ? "bg-red-100 text-red-700 border border-red-300 hover:bg-red-200"
                            : "bg-zinc-100 text-zinc-400 border border-zinc-200 hover:bg-zinc-200 line-through"
                        }`}
                      >
                        🇸🇬 SG
                      </button>
                      <button
                        onClick={() => handleToggleCapability(van.id, "thailandEnabled", van.thailandEnabled)}
                        title={van.thailandEnabled ? "Thailand enabled — click to disable" : "Thailand disabled — click to enable"}
                        className={`px-1.5 py-0.5 rounded text-[10px] font-semibold transition-all ${
                          van.thailandEnabled
                            ? "bg-blue-100 text-blue-700 border border-blue-300 hover:bg-blue-200"
                            : "bg-zinc-100 text-zinc-400 border border-zinc-200 hover:bg-zinc-200 line-through"
                        }`}
                      >
                        🇹🇭 TH
                      </button>
                    </div>
                  </div>
                  <button
                    onClick={() => handleDeleteVan(van.id, van.vanNumber)}
                    className="opacity-50 hover:opacity-100 transition-opacity font-bold leading-none mt-0.5"
                    title="Remove van"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Van Assignment Recheck */}
        <div className="bg-white rounded-xl border border-blue-200 shadow-sm p-5">
          <h2 className="text-sm font-semibold text-blue-700 mb-1">Van Assignment Recheck</h2>
          <p className="text-xs text-zinc-500 mb-4">
            Re-runs the full van scheduler from scratch: enforces <strong>same invoice = same van</strong>,
            eliminates all double-bookings, and outsources any trips that cannot fit.
          </p>
          {actionMessage && (
            <div className={`rounded-lg px-4 py-3 text-sm mb-4 border ${actionMessage.startsWith('✅') ? 'bg-green-50 border-green-200 text-green-800' : 'bg-red-50 border-red-200 text-red-800'}`}>
              {actionMessage}
            </div>
          )}
          <button
            onClick={handleRecheck}
            disabled={rechecking}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
          >
            {rechecking ? (
              <>
                <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                </svg>
                Rechecking…
              </>
            ) : (
              <>
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Recheck Van Assignments
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-300 text-amber-900 uppercase tracking-wide">AI</span>
              </>
            )}
          </button>

          {/* AI summary box */}
          {aiSummary && !rechecking && (
            <div className="mt-4 border-l-4 border-amber-400 bg-amber-50 rounded-r-lg px-4 py-3">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-200 text-amber-800 uppercase tracking-wide">AI Scheduler</span>
              </div>
              <p className="text-sm text-amber-900">{aiSummary}</p>
              {aiReasoning.length > 0 && (
                <div className="mt-2">
                  <button
                    onClick={() => setShowReasoning((v) => !v)}
                    className="text-xs text-amber-700 hover:text-amber-900 underline underline-offset-2 transition-colors"
                  >
                    {showReasoning ? "Hide" : "View"} assignment reasoning ({aiReasoning.length})
                  </button>
                  {showReasoning && (
                    <div className="mt-2 space-y-1 max-h-48 overflow-y-auto">
                      {aiReasoning.map((r, i) => (
                        <div key={i} className="flex items-start gap-2 text-xs">
                          <span className={`shrink-0 font-bold ${r.action === 'outsourced' ? 'text-orange-600' : 'text-green-700'}`}>
                            {r.action === 'outsourced' ? '⚠' : '✓'}
                          </span>
                          <span className="text-amber-900">
                            <span className="font-medium">#{r.bookingId}</span>
                            {r.van && <span className="text-amber-700"> → {r.van}</span>}
                            {': '}{r.reasoning}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Terminal log panel */}
          {recheckLogs.length > 0 && (
            <div className="mt-4">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-mono text-zinc-500">recheck log</span>
                <button
                  onClick={() => setRecheckLogs([])}
                  className="text-xs text-zinc-400 hover:text-zinc-600 transition-colors"
                >
                  clear
                </button>
              </div>
              <div className="bg-zinc-900 rounded-lg p-3 h-64 overflow-y-auto font-mono text-xs leading-relaxed">
                {recheckLogs.map((line, i) => {
                  const isStep = line.startsWith("Step ") || line.startsWith("━━━");
                  const isOk = line.includes("OK ") || line.includes("✓") || line.includes("done") || line.includes("COMPLETE");
                  const isConflict = line.includes("CONFLICT") || line.includes("outsourced") || line.includes("❌");
                  const isBump = line.includes("BUMP") || line.includes("displaced") || line.includes("swapped");
                  const isEnforce = line.includes("[enforceInvoice]");
                  const isDouble = line.includes("[eliminateDoubleBookings]");
                  let color = "text-zinc-400";
                  if (isStep) color = "text-cyan-400 font-semibold";
                  else if (isOk) color = "text-green-400";
                  else if (isConflict) color = "text-red-400";
                  else if (isBump) color = "text-yellow-400";
                  else if (isEnforce || isDouble) color = "text-purple-400";
                  return (
                    <div key={i} className={`${color} whitespace-pre-wrap break-all`}>
                      {line}
                    </div>
                  );
                })}
                {rechecking && (
                  <div className="text-zinc-500 animate-pulse">▋</div>
                )}
                <div ref={logEndRef} />
              </div>
            </div>
          )}
        </div>

        {/* Danger Zone */}
        <div className="bg-white rounded-xl border border-red-200 shadow-sm p-5">
          <h2 className="text-sm font-semibold text-red-700 mb-1">Danger Zone</h2>
          <p className="text-xs text-zinc-500 mb-4">These actions are irreversible. Use with caution.</p>
          <div className="flex flex-wrap gap-3">
            <button
              onClick={() => setShowClearAllModal(true)}
              className="px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700"
            >
              Clear All Bookings
            </button>
            <button
              onClick={() => setShowClearDuplicatesModal(true)}
              className="px-4 py-2 bg-orange-500 text-white text-sm font-medium rounded-lg hover:bg-orange-600"
            >
              Remove Duplicate Bookings
            </button>
          </div>
        </div>
      </main>

      {/* Clear All modal */}
      {showClearAllModal && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
          onClick={() => setShowClearAllModal(false)}
        >
          <div
            className="bg-white rounded-xl p-6 max-w-md w-full mx-4 shadow-xl"
            onClick={e => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-gray-900 mb-2">Clear all bookings?</h2>
            <p className="text-sm text-gray-600 mb-6">
              This will permanently delete ALL booking rows from the database. This cannot be undone.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setShowClearAllModal(false)}
                className="px-4 py-2 border border-gray-300 text-gray-700 text-sm rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleClearAll}
                className="px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700"
              >
                Yes, delete everything
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Remove Duplicates modal */}
      {showClearDuplicatesModal && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
          onClick={() => setShowClearDuplicatesModal(false)}
        >
          <div
            className="bg-white rounded-xl p-6 max-w-md w-full mx-4 shadow-xl"
            onClick={e => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-gray-900 mb-2">Remove duplicate bookings?</h2>
            <p className="text-sm text-gray-600 mb-6">
              This will delete all rows where the same invoice number, date and amount appear more than once.
              The first entry of each duplicate will be kept.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setShowClearDuplicatesModal(false)}
                className="px-4 py-2 border border-gray-300 text-gray-700 text-sm rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleClearDuplicates}
                className="px-4 py-2 bg-orange-500 text-white text-sm font-medium rounded-lg hover:bg-orange-600"
              >
                Yes, remove duplicates
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
