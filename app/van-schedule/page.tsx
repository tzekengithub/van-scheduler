"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import Link from "next/link";

const MONTH_NAMES = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];
const MONTH_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

interface Van {
  id: number;
  vanNumber: string;
  driverName: string | null;
  driverContact: string | null;
}

interface BookingRow {
  id: number;
  travelDate: string;
  day: string | null;
  month: string | null;
  year: string | null;
  invoiceNo: string | null;
  clientDetails: string | null;
  details: string | null;
  vehiclePlate: string | null;
  driverName: string | null;
  amount: string | null;
  paidStatus: string | null;
  fromLocation: string;
  toLocation: string;
  tripType: string | null;
  vanId: number | null;
}

interface ConflictItem {
  type: "double-booked" | "no-van" | "no-driver";
  label: string;
  bookings: BookingRow[];
}

interface PopupState {
  bookings: BookingRow[];
  vanLabel: string;
  dayNum: number;
}

function clientFirstLine(b: BookingRow): string {
  return (b.clientDetails ?? "").split("\n")[0].trim();
}

function cellBg(bks: BookingRow[], isNoVan: boolean): string {
  if (isNoVan || bks.length > 1) return "bg-red-100 border-red-300 text-red-900";
  if (!bks[0].driverName?.trim()) return "bg-amber-100 border-amber-300 text-amber-900";
  return "bg-blue-100 border-blue-300 text-blue-900";
}

export default function VanSchedulePage() {
  const today = new Date();
  const [viewMonth, setViewMonth] = useState(today.getMonth()); // 0–11
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [vans, setVans] = useState<Van[]>([]);
  const [bookings, setBookings] = useState<BookingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [popup, setPopup] = useState<PopupState | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const monthName = MONTH_NAMES[viewMonth];
      const [bRes, vRes] = await Promise.all([
        fetch(`/api/bookings?month=${encodeURIComponent(monthName)}&year=${viewYear}`),
        fetch("/api/vans"),
      ]);
      if (bRes.ok) setBookings(await bRes.json());
      if (vRes.ok) setVans(await vRes.json());
    } finally {
      setLoading(false);
    }
  }, [viewMonth, viewYear]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Close popup on outside click
  useEffect(() => {
    if (!popup) return;
    function handler(e: MouseEvent) {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        setPopup(null);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [popup]);

  function prevMonth() {
    if (viewMonth === 0) { setViewMonth(11); setViewYear((y) => y - 1); }
    else setViewMonth((m) => m - 1);
  }
  function nextMonth() {
    if (viewMonth === 11) { setViewMonth(0); setViewYear((y) => y + 1); }
    else setViewMonth((m) => m + 1);
  }

  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const days = Array.from({ length: daysInMonth }, (_, i) => i + 1);
  const isCurrentMonth = viewMonth === today.getMonth() && viewYear === today.getFullYear();

  // bookingMap: plate (or "" for unassigned/no-van) → dayNum → BookingRow[]
  // Bookings with vanId=null are always placed in the "" bucket (UNASSIGNED row)
  const bookingMap = useMemo(() => {
    const map = new Map<string, Map<number, BookingRow[]>>();
    for (const b of bookings) {
      // If vanId is null, treat as unassigned regardless of vehiclePlate
      const plate = b.vanId == null ? "" : (b.vehiclePlate?.trim() ?? "");
      const dayNum = parseInt(b.day ?? "0", 10);
      if (!dayNum) continue;
      if (!map.has(plate)) map.set(plate, new Map());
      const dm = map.get(plate)!;
      if (!dm.has(dayNum)) dm.set(dayNum, []);
      dm.get(dayNum)!.push(b);
    }
    return map;
  }, [bookings]);

  const noVanMap = bookingMap.get("") ?? new Map<number, BookingRow[]>();

  // Plates seen in bookings that aren't in the registered vans list
  const knownPlates = useMemo(() => new Set(vans.map((v) => v.vanNumber)), [vans]);
  const extraPlates = useMemo(
    () => [...bookingMap.keys()].filter((p) => p && !knownPlates.has(p)).sort(),
    [bookingMap, knownPlates]
  );

  // All van rows to render (registered vans + any unregistered plates found in bookings)
  const vanRows = useMemo(() => [
    ...vans.map((v) => ({ plate: v.vanNumber, driver: v.driverName ?? "" })),
    ...extraPlates.map((p) => ({ plate: p, driver: "" })),
  ], [vans, extraPlates]);

  // Detect conflicts and warnings
  const { conflicts, warnings } = useMemo(() => {
    const conflicts: ConflictItem[] = [];
    const warnings: ConflictItem[] = [];

    for (const [plate, dayMap] of bookingMap) {
      if (!plate) continue;
      for (const [dayNum, bks] of dayMap) {
        // Conflict 1: same van, same day, multiple bookings
        if (bks.length > 1) {
          conflicts.push({
            type: "double-booked",
            label: `${MONTH_SHORT[viewMonth]} ${dayNum} — ${plate} has ${bks.length} bookings`,
            bookings: bks,
          });
        }
        // Conflict 2: plate set but no driver name on booking
        for (const b of bks) {
          if (!b.driverName?.trim()) {
            warnings.push({
              type: "no-driver",
              label: `${MONTH_SHORT[viewMonth]} ${dayNum} — ${plate} has no driver assigned`,
              bookings: [b],
            });
          }
        }
      }
    }

    // Conflict 3: no van assigned
    for (const [dayNum, bks] of noVanMap) {
      for (const b of bks) {
        conflicts.push({
          type: "no-van",
          label: `${MONTH_SHORT[viewMonth]} ${dayNum} — Booking has no van`,
          bookings: [b],
        });
      }
    }

    return { conflicts, warnings };
  }, [bookingMap, noVanMap, viewMonth]);

  const totalIssues = conflicts.length + warnings.length;

  return (
    <div className="min-h-screen bg-zinc-50 font-sans">
      {/* Popup overlay */}
      {popup && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-24 bg-black/20">
          <div
            ref={popupRef}
            className="bg-white rounded-xl border border-zinc-200 shadow-xl p-4 w-72 text-sm"
          >
            <div className="font-semibold text-zinc-900 mb-3 pb-2 border-b border-zinc-100">
              {popup.vanLabel} — {MONTH_SHORT[viewMonth]} {popup.dayNum}
            </div>
            {popup.bookings.map((b, i) => (
              <div
                key={b.id}
                className={`space-y-1 text-xs text-zinc-700 ${i > 0 ? "mt-3 pt-3 border-t border-zinc-100" : ""}`}
              >
                <div>
                  <span className="font-medium text-zinc-500 w-14 inline-block">Driver:</span>{" "}
                  {b.driverName?.trim() ? b.driverName : <span className="text-amber-600">Not assigned</span>}
                </div>
                <div>
                  <span className="font-medium text-zinc-500 w-14 inline-block">Client:</span>{" "}
                  {clientFirstLine(b) || "—"}
                </div>
                <div>
                  <span className="font-medium text-zinc-500 w-14 inline-block">Route:</span>{" "}
                  {b.details || (b.fromLocation && b.toLocation ? `${b.fromLocation} → ${b.toLocation}` : "—")}
                </div>
                <div>
                  <span className="font-medium text-zinc-500 w-14 inline-block">Invoice:</span>{" "}
                  {b.invoiceNo || "—"}
                </div>
                <div>
                  <span className="font-medium text-zinc-500 w-14 inline-block">Amount:</span>{" "}
                  MYR {Number(b.amount ?? 0).toFixed(2)}
                </div>
                <div>
                  <span className="font-medium text-zinc-500 w-14 inline-block">Status:</span>{" "}
                  {b.paidStatus === "P"
                    ? <span className="text-green-600 font-medium">Paid</span>
                    : <span className="text-red-500 font-medium">Unpaid</span>}
                </div>
              </div>
            ))}
            <button
              onClick={() => setPopup(null)}
              className="mt-4 text-xs text-zinc-400 hover:text-zinc-600 underline"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="bg-white border-b border-zinc-200 px-6 py-4">
        <div className="max-w-full mx-auto flex items-center justify-between">
          <h1 className="text-xl font-semibold text-zinc-900">Van Schedule</h1>
          <nav className="flex gap-4 text-sm font-medium">
            <Link href="/" className="text-zinc-500 hover:text-zinc-900 transition-colors">Dashboard</Link>
            <Link href="/daily-jobs" className="text-zinc-500 hover:text-zinc-900 transition-colors">Daily Jobs</Link>
            <Link href="/all-jobs" className="text-zinc-500 hover:text-zinc-900 transition-colors">All Jobs</Link>
            <span className="text-zinc-900 border-b-2 border-zinc-900 pb-0.5">Van Schedule</span>
          </nav>
        </div>
      </header>

      <main className="px-4 py-6 space-y-4">
        {/* Month nav + issue badge */}
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <button
              onClick={prevMonth}
              className="w-8 h-8 flex items-center justify-center rounded-lg border border-zinc-300 bg-white hover:bg-zinc-50 text-zinc-700 font-bold transition-colors"
            >
              ←
            </button>
            <span className="text-base font-semibold text-zinc-900 w-36 text-center">
              {MONTH_NAMES[viewMonth]} {viewYear}
            </span>
            <button
              onClick={nextMonth}
              className="w-8 h-8 flex items-center justify-center rounded-lg border border-zinc-300 bg-white hover:bg-zinc-50 text-zinc-700 font-bold transition-colors"
            >
              →
            </button>
          </div>
          {!loading && (
            totalIssues > 0 ? (
              <span className="px-3 py-1 rounded-full bg-red-100 border border-red-200 text-red-700 text-xs font-semibold">
                ⚠ {totalIssues} conflict{totalIssues !== 1 ? "s" : ""} found
              </span>
            ) : (
              <span className="px-3 py-1 rounded-full bg-green-100 border border-green-200 text-green-700 text-xs font-semibold">
                ✓ All clear
              </span>
            )
          )}
          {/* Legend */}
          {!loading && (
            <div className="flex items-center gap-3 ml-auto text-xs text-zinc-500">
              <span className="flex items-center gap-1">
                <span className="w-3 h-3 rounded-sm bg-blue-200 border border-blue-300 inline-block" />
                Normal
              </span>
              <span className="flex items-center gap-1">
                <span className="w-3 h-3 rounded-sm bg-amber-200 border border-amber-300 inline-block" />
                No driver
              </span>
              <span className="flex items-center gap-1">
                <span className="w-3 h-3 rounded-sm bg-red-200 border border-red-300 inline-block" />
                Conflict / No van
              </span>
            </div>
          )}
        </div>

        {loading ? (
          <div className="text-center py-20 text-zinc-400 text-sm">Loading…</div>
        ) : (
          <>
            {/* Calendar grid */}
            <div className="bg-white rounded-xl border border-zinc-200 shadow-sm overflow-auto">
              <table className="border-collapse text-xs">
                <thead>
                  <tr className="border-b border-zinc-200">
                    <th className="sticky left-0 z-20 bg-zinc-50 px-3 py-2.5 text-left font-semibold text-zinc-600 border-r border-zinc-200 min-w-[160px] whitespace-nowrap">
                      Van / Driver
                    </th>
                    {days.map((d) => {
                      const isToday = isCurrentMonth && d === today.getDate();
                      return (
                        <th
                          key={d}
                          className={`px-2 py-2.5 text-center font-semibold whitespace-nowrap border-r border-zinc-100 w-24 ${
                            isToday ? "bg-blue-50 text-blue-700" : "bg-zinc-50 text-zinc-500"
                          }`}
                        >
                          {d}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {/* Van rows */}
                  {vanRows.map(({ plate, driver }) => {
                    const dayMap = bookingMap.get(plate) ?? new Map<number, BookingRow[]>();
                    return (
                      <tr key={plate} className="border-b border-zinc-100">
                        <td className="sticky left-0 z-10 bg-white border-r border-zinc-200 px-3 py-2 min-w-[160px]">
                          <div className="font-semibold text-zinc-900 text-xs">{plate}</div>
                          {driver && (
                            <div className="text-zinc-400 text-[10px] truncate max-w-[140px]">{driver}</div>
                          )}
                        </td>
                        {days.map((d) => {
                          const isToday = isCurrentMonth && d === today.getDate();
                          const bks = dayMap.get(d);
                          if (!bks || bks.length === 0) {
                            return (
                              <td
                                key={d}
                                className={`border-r border-zinc-100 w-24 px-0.5 py-0.5 align-top ${isToday ? "bg-blue-50/20" : ""}`}
                              />
                            );
                          }
                          const color = cellBg(bks, false);
                          return (
                            <td
                              key={d}
                              className={`border-r border-zinc-100 w-24 px-0.5 py-0.5 align-top ${isToday ? "bg-blue-50/20" : ""}`}
                            >
                              <div
                                className={`rounded border px-1.5 py-1 cursor-pointer hover:opacity-80 transition-opacity ${color}`}
                                onClick={() => setPopup({ bookings: bks, vanLabel: plate, dayNum: d })}
                              >
                                <div className="font-semibold truncate max-w-[84px] leading-tight">
                                  {clientFirstLine(bks[0]) || "—"}
                                </div>
                                <div className="truncate max-w-[84px] opacity-75 leading-tight mt-0.5">
                                  {bks[0].fromLocation && bks[0].toLocation
                                    ? `${bks[0].fromLocation}→${bks[0].toLocation}`
                                    : bks[0].details || "—"}
                                </div>
                                {bks[0].tripType && (
                                  <div className="text-[9px] leading-tight mt-0.5 opacity-80">
                                    {bks[0].tripType === "one_way_ride" ? "🔵 One Way" :
                                     bks[0].tripType === "round_trip"   ? "🟢 Round Trip" :
                                     bks[0].tripType === "day_trip"     ? "🟡 Day Trip" : "🟠 Trip"}
                                  </div>
                                )}
                                {bks.length > 1 && (
                                  <div className="text-[10px] font-bold mt-0.5">⚠️ CONFLICT +{bks.length - 1}</div>
                                )}
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}

                  {/* No Van row — only when there are unassigned bookings */}
                  {noVanMap.size > 0 && (
                    <tr className="border-b border-zinc-100">
                      <td className="sticky left-0 z-10 bg-red-50 border-r border-zinc-200 px-3 py-2 min-w-[160px]">
                        <div className="font-semibold text-red-700 text-xs">⚠️ UNASSIGNED</div>
                        <div className="text-red-400 text-[10px]">Conflict / No van</div>
                      </td>
                      {days.map((d) => {
                        const isToday = isCurrentMonth && d === today.getDate();
                        const bks = noVanMap.get(d);
                        if (!bks || bks.length === 0) {
                          return (
                            <td
                              key={d}
                              className={`border-r border-zinc-100 w-24 px-0.5 py-0.5 bg-red-50/30 align-top ${isToday ? "bg-blue-50/20" : ""}`}
                            />
                          );
                        }
                        return (
                          <td
                            key={d}
                            className={`border-r border-zinc-100 w-24 px-0.5 py-0.5 align-top ${isToday ? "bg-blue-50/20" : ""}`}
                          >
                            {bks.map((b) => (
                              <div
                                key={b.id}
                                className="rounded border px-1.5 py-1 mb-0.5 cursor-pointer hover:opacity-80 transition-opacity bg-red-100 border-red-300 text-red-900"
                                onClick={() => setPopup({ bookings: [b], vanLabel: "No Van", dayNum: d })}
                              >
                                <div className="font-semibold truncate max-w-[84px] leading-tight">
                                  {clientFirstLine(b) || "—"}
                                </div>
                                <div className="truncate max-w-[84px] opacity-75 leading-tight mt-0.5">
                                  {b.details || `${b.fromLocation}→${b.toLocation}`}
                                </div>
                                <div className="truncate max-w-[84px] opacity-60 text-[10px] leading-tight mt-0.5">
                                  {b.invoiceNo}
                                </div>
                              </div>
                            ))}
                          </td>
                        );
                      })}
                    </tr>
                  )}

                  {/* Empty state */}
                  {vanRows.length === 0 && noVanMap.size === 0 && (
                    <tr>
                      <td
                        colSpan={daysInMonth + 1}
                        className="px-4 py-12 text-center text-zinc-400 text-sm"
                      >
                        No vans registered and no bookings this month.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Conflicts & warnings panel */}
            <div className={`rounded-xl border shadow-sm p-4 bg-white ${totalIssues > 0 ? "border-red-200" : "border-green-200"}`}>
              {totalIssues > 0 ? (
                <>
                  <h2 className="text-sm font-semibold text-red-700 mb-3">
                    ⚠ {totalIssues} Conflict{totalIssues !== 1 ? "s" : ""} Found
                  </h2>
                  <div className="space-y-3">
                    {conflicts.map((c, i) => (
                      <div key={`c-${i}`} className="text-xs">
                        <div className="font-semibold text-red-700">🔴 {c.label}</div>
                        <ul className="mt-1 pl-4 space-y-0.5 text-zinc-600">
                          {c.bookings.map((b) => (
                            <li key={b.id}>
                              • {b.invoiceNo || "No invoice"} — {clientFirstLine(b) || b.details || "No details"}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                    {warnings.map((w, i) => (
                      <div key={`w-${i}`} className="text-xs">
                        <div className="font-semibold text-amber-700">🟡 {w.label}</div>
                        <ul className="mt-1 pl-4 space-y-0.5 text-zinc-600">
                          {w.bookings.map((b) => (
                            <li key={b.id}>
                              • {b.invoiceNo || "No invoice"} — {clientFirstLine(b) || b.details || "No details"}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <p className="text-sm text-green-700 font-medium">✓ All clear — no conflicts this month</p>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
