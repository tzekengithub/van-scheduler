"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";

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
}

const VAN_COLORS: Record<string, string> = {
  "1": "bg-blue-100 text-blue-800 border-blue-200",
  "2": "bg-emerald-100 text-emerald-800 border-emerald-200",
  "3": "bg-amber-100 text-amber-800 border-amber-200",
  "4": "bg-rose-100 text-rose-800 border-rose-200",
};

function VanBadge({ vanNumber }: { vanNumber: string | null }) {
  const colors =
    vanNumber && VAN_COLORS[vanNumber]
      ? VAN_COLORS[vanNumber]
      : "bg-zinc-100 text-zinc-600 border-zinc-200";
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${colors}`}
    >
      {vanNumber ? `Van ${vanNumber}` : "Unassigned"}
    </span>
  );
}

export default function DashboardPage() {
  const [bookings, setBookings] = useState<BookingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploadLoading, setUploadLoading] = useState(false);
  const [clearLoading, setClearLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchBookings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/bookings");
      if (!res.ok) throw new Error(await res.text());
      setBookings(await res.json());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBookings();
  }, [fetchBookings]);

  async function handleUpload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const file = fileInputRef.current?.files?.[0];
    if (!file) {
      setError("Please select a PDF file.");
      return;
    }

    setUploadLoading(true);
    setError(null);
    setSuccess(null);

    const form = new FormData();
    form.append("file", file);

    try {
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Upload failed");
      setSuccess(data.message);
      if (fileInputRef.current) fileInputRef.current.value = "";
      await fetchBookings();
    } catch (e) {
      setError(String(e));
    } finally {
      setUploadLoading(false);
    }
  }

  async function handleClear() {
    if (!confirm("Delete all bookings? This cannot be undone.")) return;
    setClearLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch("/api/clear", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Clear failed");
      setSuccess(data.message);
      await fetchBookings();
    } catch (e) {
      setError(String(e));
    } finally {
      setClearLoading(false);
    }
  }

  // Group bookings by date for visual separation
  const dates = [...new Set(bookings.map((b) => b.travelDate))];

  return (
    <div className="min-h-screen bg-zinc-50 font-sans">
      {/* Header */}
      <header className="bg-white border-b border-zinc-200 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-zinc-900">Van Scheduler</h1>
            <p className="text-sm text-zinc-500 mt-0.5">
              {loading
                ? "Loading…"
                : `${bookings.length} booking${bookings.length !== 1 ? "s" : ""}`}
            </p>
          </div>
          <nav className="flex gap-4 text-sm font-medium">
            <span className="text-zinc-900 border-b-2 border-zinc-900 pb-0.5">Dashboard</span>
            <Link
              href="/database"
              className="text-zinc-500 hover:text-zinc-900 transition-colors"
            >
              Raw Database
            </Link>
          </nav>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8 space-y-6">
        {/* Toolbar */}
        <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-end justify-between">
          <form onSubmit={handleUpload} className="flex gap-3 items-end flex-wrap">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">
                Upload Invoice PDF
              </label>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf"
                required
                className="text-sm text-zinc-700 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-zinc-900 file:text-white hover:file:bg-zinc-700 file:cursor-pointer cursor-pointer"
              />
            </div>
            <button
              type="submit"
              disabled={uploadLoading}
              className="h-9 px-4 rounded-lg bg-zinc-900 text-white text-sm font-medium hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
            >
              {uploadLoading ? "Uploading…" : "Upload"}
            </button>
          </form>

          <button
            onClick={handleClear}
            disabled={clearLoading || bookings.length === 0}
            className="h-9 px-4 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
          >
            {clearLoading ? "Clearing…" : "Clear All Bookings"}
          </button>
        </div>

        {/* Banners */}
        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800">
            {error}
          </div>
        )}
        {success && (
          <div className="rounded-lg bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-800">
            {success}
          </div>
        )}

        {/* Table */}
        {loading ? (
          <div className="flex items-center justify-center py-20 text-zinc-400 text-sm">
            Loading bookings…
          </div>
        ) : bookings.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-zinc-400 gap-2">
            <p className="text-4xl">📋</p>
            <p className="text-sm">No bookings yet. Upload a PDF invoice to get started.</p>
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden shadow-sm">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-zinc-50 border-b border-zinc-200">
                  <th className="px-4 py-3 text-left font-semibold text-zinc-600 whitespace-nowrap">
                    Date
                  </th>
                  <th className="px-4 py-3 text-left font-semibold text-zinc-600">From</th>
                  <th className="px-4 py-3 text-left font-semibold text-zinc-600">To</th>
                  <th className="px-4 py-3 text-left font-semibold text-zinc-600 whitespace-nowrap">
                    Round Trip
                  </th>
                  <th className="px-4 py-3 text-left font-semibold text-zinc-600">Van</th>
                  <th className="px-4 py-3 text-left font-semibold text-zinc-600">Details</th>
                </tr>
              </thead>
              <tbody>
                {dates.map((date, di) => {
                  const group = bookings.filter((b) => b.travelDate === date);
                  return group.map((booking, bi) => (
                    <tr
                      key={booking.id}
                      className={`border-b border-zinc-100 hover:bg-zinc-50 transition-colors ${
                        di % 2 === 0 ? "" : "bg-zinc-50/40"
                      }`}
                    >
                      <td className="px-4 py-3 font-mono text-xs text-zinc-600 whitespace-nowrap">
                        {bi === 0 ? booking.travelDate : ""}
                      </td>
                      <td className="px-4 py-3 text-zinc-800 font-medium">
                        {booking.fromLocation}
                      </td>
                      <td className="px-4 py-3 text-zinc-800 font-medium">
                        {booking.toLocation}
                      </td>
                      <td className="px-4 py-3">
                        {booking.isRoundTrip === 1 ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-violet-100 text-violet-700 border border-violet-200">
                            Yes
                          </span>
                        ) : (
                          <span className="text-zinc-400 text-xs">One-way</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <VanBadge vanNumber={booking.vanNumber} />
                      </td>
                      <td
                        className="px-4 py-3 text-zinc-500 text-xs max-w-xs truncate"
                        title={booking.details ?? ""}
                      >
                        {booking.details ?? "—"}
                      </td>
                    </tr>
                  ));
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Van legend */}
        {bookings.length > 0 && (
          <div className="flex flex-wrap gap-2 items-center text-xs text-zinc-500">
            <span className="font-medium">Legend:</span>
            {Object.entries(VAN_COLORS).map(([num, cls]) => (
              <span
                key={num}
                className={`px-2 py-0.5 rounded-full border font-medium ${cls}`}
              >
                Van {num}
              </span>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
