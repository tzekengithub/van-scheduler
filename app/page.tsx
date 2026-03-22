"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";

interface Van {
  id: number;
  vanNumber: string;
  driverName: string | null;
  driverContact: string | null;
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
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [showClearAllModal, setShowClearAllModal] = useState(false);
  const [showClearDuplicatesModal, setShowClearDuplicatesModal] = useState(false);
  const [actionMessage, setActionMessage] = useState('');
  const [rechecking, setRechecking] = useState(false);

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
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to add van");
      setSuccess(`Van ${data.vanNumber} added`);
      setNewPlate("");
      setNewDriverName("");
      setNewDriverContact("");
      await fetchVans();
    } catch (e) {
      setError(String(e));
    } finally {
      setVanLoading(false);
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
    try {
      const res = await fetch('/api/reassign', { method: 'POST' });
      if (res.ok) {
        setActionMessage('✅ Van assignments rechecked — same invoice = same van enforced, no double-bookings.');
      } else {
        const data = await res.json().catch(() => ({}));
        setActionMessage(`❌ Recheck failed: ${data.error ?? 'unknown error'}`);
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
              </>
            )}
          </button>
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
