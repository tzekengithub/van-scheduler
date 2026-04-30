"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
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
  singaporeEnabled: number | null;
  thailandEnabled: number | null;
  vehicleType: string | null;
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
  driverContact: string | null;
  amount: string | null;
  myrPerVehicle: string | null;
  passengerCount: number | null;
  paidStatus: string | null;
  fromLocation: string;
  toLocation: string;
  isRoundTrip: number | null;
  tripType: string | null;
  vanId: number | null;
  manualChange: number | null;
  inHouseOrOutsourced: string | null;
  outsourcedCompany: string | null;
  outsourceReason: string | null;
  overtime: string | null;
  introducer: string | null;
  tourGuide: string | null;
  vehicleCategory: string | null;
}

interface EditForm {
  invoiceNo: string;
  travelDate: string;
  fromLocation: string;
  toLocation: string;
  tripType: string;
  details: string;
  clientDetails: string;
  passengerCount: string;
  amount: string;
  myrPerVehicle: string;
  paidStatus: string;
  vanId: string;
  vehiclePlate: string;
  driverName: string;
  driverContact: string;
  manualChange: boolean;
  inHouseOrOutsourced: string;
  outsourcedCompany: string;
  outsourceReason: string;
  overtime: string;
  introducer: string;
  tourGuide: string;
}

interface ConflictItem {
  type: "double-booked" | "no-van" | "no-driver";
  label: string;
  bookings: BookingRow[];
  dayNum: number;
  plate: string;
}

interface EditPanelState {
  booking: BookingRow;
  vanLabel: string;
}

function isOutsourced(b: BookingRow): boolean {
  const v = b.inHouseOrOutsourced;
  return v === "outsourced" || v === "O";
}

function tripDestinationFlags(b: BookingRow): { sg: boolean; th: boolean } {
  const combined = `${b.fromLocation ?? ""} ${b.toLocation ?? ""} ${b.details ?? ""}`.toLowerCase();
  return {
    sg: combined.includes("singapore"),
    th: combined.includes("thailand") || combined.includes("hatyai") || combined.includes("hat yai") || combined.includes("padang besar"),
  };
}

/** True only when outsourced AND the company name is filled in — has its own calendar row. */
function isConfirmedOutsourced(b: BookingRow): boolean {
  return isOutsourced(b) && (b.outsourcedCompany?.trim() ?? "") !== "";
}

function clientFirstLine(b: BookingRow): string {
  return (b.clientDetails ?? "").split("\n")[0].trim();
}

function cellBg(bks: BookingRow[], isNoVan: boolean): string {
  if (isNoVan) return "bg-red-100 border-red-300 text-red-900";
  const outsourced = bks[0] ? isOutsourced(bks[0]) : false;
  if (outsourced) return "bg-purple-100 border-purple-300 text-purple-900";
  if (bks.length > 1 && !bks.every((b) => b.manualChange === 1)) return "bg-red-100 border-red-300 text-red-900";
  if (!bks[0]?.driverName?.trim()) return "bg-amber-100 border-amber-300 text-amber-900";
  return "bg-blue-100 border-blue-300 text-blue-900";
}

export default function VanSchedulePage() {
  const today = new Date();
  const [viewMonth, setViewMonth] = useState(today.getMonth());
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [vans, setVans] = useState<Van[]>([]);
  const [bookings, setBookings] = useState<BookingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editPanel, setEditPanel] = useState<EditPanelState | null>(null);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [editSaving, setEditSaving] = useState(false);

  // Action table state
  const [selectedVan, setSelectedVan] = useState<Record<number, string>>({});
  const [outsourcingInput, setOutsourcingInput] = useState<Record<number, string>>({});
  const [actionLoading, setActionLoading] = useState<Record<number, boolean>>({});
  const [actionDone, setActionDone] = useState<Record<number, boolean>>({});

  // Drag-and-drop state
  const [dragBookingId, setDragBookingId] = useState<number | null>(null);
  const [dragSourcePlate, setDragSourcePlate] = useState<string | null>(null);
  const [dragSourceDay, setDragSourceDay] = useState<number | null>(null);
  const [dragOverCell, setDragOverCell] = useState<{ plate: string; day: number } | null>(null);

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
      setSelectedVan({});
      setOutsourcingInput({});
      setActionDone({});
    } finally {
      setLoading(false);
    }
  }, [viewMonth, viewYear]);

  useEffect(() => { fetchData(); }, [fetchData]);


  function printSchedule() {
    const monthName = MONTH_NAMES[viewMonth];
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const days = Array.from({ length: daysInMonth }, (_, i) => i + 1);

    // Build rows: registered vans + extra plates (skip outsourced company rows for print)
    const printRows = vanRows.filter((r) => !r.isOutsourced);

    const getDayLabel = (d: number) => {
      const date = new Date(viewYear, viewMonth, d);
      const dow = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][date.getDay()];
      return `${d}\n${dow}`;
    };

    const cellsHtml = printRows.map((row) => {
      const dayMap = bookingMap.get(row.plate);
      const rowCells = days.map((d) => {
        const bks = dayMap?.get(d) ?? [];
        if (!bks.length) return `<td></td>`;
        const content = bks.map((b) => {
          const route = [b.fromLocation, b.toLocation].filter(Boolean).join(" → ");
          const client = clientFirstLine(b);
          const outsourced = isOutsourced(b);
          const lines = [
            route ? `<span class="route">${route}</span>` : "",
            client ? `<span class="client">${client}</span>` : "",
            outsourced ? `<span class="tag-out">OUT</span>` : "",
          ].filter(Boolean).join("");
          return `<div class="booking ${outsourced ? "out" : ""}">${lines}</div>`;
        }).join("");
        const isDouble = bks.length > 1;
        return `<td class="${isDouble ? "conflict" : ""}">${content}</td>`;
      }).join("");
      const flags = [
        row.sgEnabled ? "🇸🇬" : "",
        row.thEnabled ? "🇹🇭" : "",
        row.isAlphard ? "★" : "",
      ].filter(Boolean).join(" ");
      return `<tr>
        <td class="van-cell"><strong>${row.plate}</strong><br><span class="driver">${row.label}</span>${flags ? `<br><span class="flags">${flags}</span>` : ""}</td>
        ${rowCells}
      </tr>`;
    }).join("");

    const dayHeaders = days.map((d) => {
      const date = new Date(viewYear, viewMonth, d);
      const dow = ["Su","Mo","Tu","We","Th","Fr","Sa"][date.getDay()];
      const isWeekend = date.getDay() === 0 || date.getDay() === 6;
      return `<th class="${isWeekend ? "weekend" : ""}">${d}<br><span class="dow">${dow}</span></th>`;
    }).join("");

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Van Schedule — ${monthName} ${viewYear}</title>
<style>
  @page { size: A4 landscape; margin: 10mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 7pt; color: #111; }
  h1 { font-size: 11pt; font-weight: 700; margin-bottom: 4mm; text-align: center; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th, td { border: 0.4pt solid #bbb; padding: 1.5pt 2pt; vertical-align: top; overflow: hidden; }
  th { background: #f0f0f0; text-align: center; font-size: 6.5pt; font-weight: 600; white-space: nowrap; }
  th.weekend { background: #e8e0f0; }
  th .dow { font-size: 5.5pt; font-weight: 400; color: #555; display: block; }
  td.van-cell { width: 18mm; background: #f7f7f7; font-size: 6.5pt; white-space: nowrap; }
  td.van-cell .driver { color: #555; font-size: 5.5pt; }
  td.van-cell .flags { font-size: 5.5pt; }
  td.conflict { background: #fee2e2; }
  .booking { padding: 0.5pt 0; border-bottom: 0.3pt solid #ddd; line-height: 1.3; }
  .booking:last-child { border-bottom: none; }
  .booking.out { color: #6b21a8; }
.route { font-size: 6pt; display: block; color: #1d4ed8; }
  .client { font-size: 5.5pt; display: block; color: #374151; }
  .tag-out { font-size: 5pt; background: #e9d5ff; color: #6b21a8; padding: 0 1pt; border-radius: 1pt; }
  .footer { margin-top: 3mm; font-size: 6pt; color: #888; text-align: right; }
</style>
</head>
<body>
<h1>Van Schedule — ${monthName} ${viewYear}</h1>
<table>
  <thead>
    <tr>
      <th style="width:18mm">Van / Driver</th>
      ${dayHeaders}
    </tr>
  </thead>
  <tbody>
    ${cellsHtml}
  </tbody>
</table>
<div class="footer">Printed ${new Date().toLocaleString()}</div>
</body>
</html>`;

    const win = window.open("", "_blank");
    if (!win) return;
    win.document.write(html);
    win.document.close();
    win.focus();
    win.print();
  }

  function exportJson() {
    const payload = {
      month: MONTH_NAMES[viewMonth],
      year: viewYear,
      vans,
      bookings,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `van-schedule-${viewYear}-${String(viewMonth + 1).padStart(2, "0")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function openEdit(booking: BookingRow, vanLabel: string) {
    setEditPanel({ booking, vanLabel });
    setEditForm({
      invoiceNo: booking.invoiceNo ?? "",
      travelDate: booking.travelDate ?? "",
      fromLocation: booking.fromLocation ?? "",
      toLocation: booking.toLocation ?? "",
      tripType: booking.tripType ?? "trip",
      details: booking.details ?? "",
      clientDetails: booking.clientDetails ?? "",
      passengerCount: String(booking.passengerCount ?? ""),
      amount: String(booking.amount ?? ""),
      myrPerVehicle: String(booking.myrPerVehicle ?? ""),
      paidStatus: booking.paidStatus ?? "U",
      vanId: booking.vanId != null ? String(booking.vanId) : "",
      vehiclePlate: booking.vehiclePlate ?? "",
      driverName: booking.driverName ?? "",
      driverContact: booking.driverContact ?? "",
      manualChange: (booking.manualChange ?? 0) === 1,
      inHouseOrOutsourced: booking.inHouseOrOutsourced ?? "I",
      outsourcedCompany: booking.outsourcedCompany ?? "",
      outsourceReason: booking.outsourceReason ?? "",
      overtime: booking.overtime ?? "",
      introducer: booking.introducer ?? "",
      tourGuide: booking.tourGuide ?? "",
    });
  }

  async function handleEditSave() {
    if (!editPanel || !editForm) return;
    setEditSaving(true);
    try {
      const res = await fetch(`/api/bookings/${editPanel.booking.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          invoiceNo: editForm.invoiceNo,
          travelDate: editForm.travelDate,
          fromLocation: editForm.fromLocation,
          toLocation: editForm.toLocation,
          tripType: editForm.tripType,
          details: editForm.details,
          clientDetails: editForm.clientDetails,
          passengerCount: editForm.passengerCount !== "" ? parseInt(editForm.passengerCount) : null,
          amount: editForm.amount,
          myrPerVehicle: editForm.myrPerVehicle,
          paidStatus: editForm.paidStatus,
          vanId: editForm.vanId !== "" ? parseInt(editForm.vanId) : null,
          vehiclePlate: editForm.vehiclePlate,
          driverName: editForm.driverName,
          driverContact: editForm.driverContact,
          manualChange: editForm.manualChange ? 1 : 0,
          inHouseOrOutsourced: editForm.inHouseOrOutsourced,
          outsourcedCompany: editForm.outsourcedCompany,
          outsourceReason: editForm.outsourceReason,
          overtime: editForm.overtime,
          introducer: editForm.introducer,
          tourGuide: editForm.tourGuide,
        }),
      });
      if (res.ok) {
        setEditPanel(null);
        setEditForm(null);
        await fetchData();
      } else {
        const data = await res.json().catch(() => ({}));
        alert(data.error ?? "Save failed");
      }
    } finally {
      setEditSaving(false);
    }
  }

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

  // bookingMap: plate → dayNum → BookingRow[]
  // Outsourced bookings with a company name get their own row keyed by company name.
  // Everything else with vanId=null goes to "" (UNASSIGNED).
  const bookingMap = useMemo(() => {
    const map = new Map<string, Map<number, BookingRow[]>>();
    for (const b of bookings) {
      let plate: string;
      if (isOutsourced(b) && b.outsourcedCompany?.trim()) {
        plate = b.outsourcedCompany.trim();
      } else {
        plate = b.vanId == null ? "" : (b.vehiclePlate?.trim() ?? "");
      }
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

  const knownPlates = useMemo(() => new Set(vans.map((v) => v.vanNumber)), [vans]);

  // Outsource company names derived from bookings
  const outsourcedCompanyNames = useMemo(() => {
    const names = new Set<string>();
    for (const b of bookings) {
      if (isOutsourced(b) && b.outsourcedCompany?.trim()) {
        names.add(b.outsourcedCompany.trim());
      }
    }
    return names;
  }, [bookings]);

  // Extra plates = plates in bookingMap that are neither registered vans nor outsource companies
  const extraPlates = useMemo(
    () => [...bookingMap.keys()].filter(
      (p) => p && !knownPlates.has(p) && !outsourcedCompanyNames.has(p)
    ).sort(),
    [bookingMap, knownPlates, outsourcedCompanyNames]
  );

  // Van rows: registered vans, then extra unrecognised plates, then outsource companies
  const vanRows = useMemo(() => [
    ...vans.map((v) => ({
      plate: v.vanNumber,
      label: v.driverName ?? "",
      isOutsourced: false,
      sgEnabled: v.singaporeEnabled === 1,
      thEnabled: v.thailandEnabled === 1,
      isAlphard: (v.vehicleType ?? "").toLowerCase() === "toyota alphard",
    })),
    ...extraPlates.map((p) => ({ plate: p, label: "", isOutsourced: false, sgEnabled: false, thEnabled: false, isAlphard: false })),
    ...[...outsourcedCompanyNames].sort().map((name) => ({ plate: name, label: "Outsourced", isOutsourced: true, sgEnabled: false, thEnabled: false, isAlphard: false })),
  ], [vans, extraPlates, outsourcedCompanyNames]);

  // Multi-day invoice color stripes — assign a distinct color to each invoice
  // that appears on 2+ different travel dates so they stand out in the calendar.
  const INVOICE_STRIPE_COLORS = [
    "#f59e0b", "#10b981", "#6366f1", "#f43f5e", "#0ea5e9",
    "#8b5cf6", "#d97706", "#14b8a6", "#ec4899", "#06b6d4",
    "#84cc16", "#ef4444", "#a855f7", "#3b82f6", "#f97316",
  ];

  const invoiceColorMap = useMemo(() => {
    const dateSets = new Map<string, Set<string>>();
    for (const b of bookings) {
      if (!b.invoiceNo?.trim()) continue;
      if (!dateSets.has(b.invoiceNo)) dateSets.set(b.invoiceNo, new Set());
      dateSets.get(b.invoiceNo)!.add(b.travelDate);
    }
    const map = new Map<string, string>();
    let idx = 0;
    [...dateSets.entries()]
      .filter(([, s]) => s.size > 1)
      .map(([inv]) => inv)
      .sort()
      .forEach((inv) => {
        map.set(inv, INVOICE_STRIPE_COLORS[idx % INVOICE_STRIPE_COLORS.length]);
        idx++;
      });
    return map;
  }, [bookings]); // eslint-disable-line react-hooks/exhaustive-deps

  // Detect conflicts and warnings — skip outsource company rows and past dates
  const { conflicts, warnings } = useMemo(() => {
    const conflicts: ConflictItem[] = [];
    const warnings: ConflictItem[] = [];
    const todayDay = isCurrentMonth ? today.getDate() : 0;

    for (const [plate, dayMap] of bookingMap) {
      if (!plate) continue;
      if (outsourcedCompanyNames.has(plate)) continue; // outsource rows never conflict

      for (const [dayNum, bks] of dayMap) {
        if (dayNum < todayDay) continue; // skip past dates in current month
        if (bks.length > 1 && !bks.every((b) => b.manualChange === 1)) {
          conflicts.push({
            type: "double-booked",
            label: `${MONTH_SHORT[viewMonth]} ${dayNum} — ${plate} has ${bks.length} bookings`,
            bookings: bks,
            dayNum,
            plate,
          });
        }
        for (const b of bks) {
          if (!b.driverName?.trim()) {
            warnings.push({
              type: "no-driver",
              label: `${MONTH_SHORT[viewMonth]} ${dayNum} — ${plate} has no driver assigned`,
              bookings: [b],
              dayNum,
              plate,
            });
          }
        }
      }
    }

    // No-van: skip only confirmed-outsourced bookings (they have their own company row)
    // Unconfirmed outsourced ("OUTSOURCE COMPANY NEEDED") still need action → show as conflict
    for (const [dayNum, bks] of noVanMap) {
      if (dayNum < todayDay) continue; // skip past dates in current month
      for (const b of bks) {
        if (isConfirmedOutsourced(b)) continue;
        conflicts.push({
          type: "no-van",
          label: `${MONTH_SHORT[viewMonth]} ${dayNum} — Booking has no van`,
          bookings: [b],
          dayNum,
          plate: "",
        });
      }
    }

    return { conflicts, warnings };
  }, [bookingMap, noVanMap, outsourcedCompanyNames, viewMonth, isCurrentMonth]);

  const totalIssues = conflicts.length + warnings.length;

  function freeVansOnDay(dayNum: number): Van[] {
    return vans.filter((v) => {
      const dayMap = bookingMap.get(v.vanNumber);
      return !dayMap || !dayMap.has(dayNum);
    });
  }

  async function handleAllowDoubleBook(conflictBookings: BookingRow[]) {
    const ids = conflictBookings.map((b) => b.id);
    ids.forEach((id) => setActionLoading((prev) => ({ ...prev, [id]: true })));
    try {
      await Promise.all(
        ids.map((id) =>
          fetch(`/api/bookings/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ manualChange: 1 }),
          })
        )
      );
      ids.forEach((id) => setActionDone((prev) => ({ ...prev, [id]: true })));
      await fetchData();
    } finally {
      ids.forEach((id) => setActionLoading((prev) => ({ ...prev, [id]: false })));
    }
  }

  async function handleAssignVan(bookingId: number) {
    const vanIdStr = selectedVan[bookingId];
    if (!vanIdStr) return;
    const vanId = parseInt(vanIdStr, 10);
    const van = vans.find((v) => v.id === vanId);
    if (!van) return;

    setActionLoading((prev) => ({ ...prev, [bookingId]: true }));
    try {
      const res = await fetch(`/api/bookings/${bookingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vanId,
          vehiclePlate: van.vanNumber,
          driverName: van.driverName,
          driverContact: van.driverContact,
          manualChange: 1,
        }),
      });
      if (res.ok) {
        setActionDone((prev) => ({ ...prev, [bookingId]: true }));
        await fetchData();
      }
    } finally {
      setActionLoading((prev) => ({ ...prev, [bookingId]: false }));
    }
  }

  async function handleOutsource(bookingId: number) {
    const companyName = outsourcingInput[bookingId]?.trim();
    if (!companyName) return;

    setActionLoading((prev) => ({ ...prev, [bookingId]: true }));
    try {
      const res = await fetch(`/api/bookings/${bookingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inHouseOrOutsourced: "O",
          outsourcedCompany: companyName,
        }),
      });
      if (res.ok) {
        setActionDone((prev) => ({ ...prev, [bookingId]: true }));
        await fetchData();
      }
    } finally {
      setActionLoading((prev) => ({ ...prev, [bookingId]: false }));
    }
  }

  // ── Drag-and-drop handler ─────────────────────────────────────────────────
  async function handleDrop(targetPlate: string, targetDay: number) {
    if (!dragBookingId || !targetPlate) return; // reject drop on UNASSIGNED row
    const booking = bookings.find((b) => b.id === dragBookingId);
    if (!booking) return;

    const isSameVan = dragSourcePlate === targetPlate;
    const isSameDay = dragSourceDay === targetDay;
    if (isSameVan || !isSameDay) return; // only allow van changes on the same day

    const targetVan = vans.find((v) => v.vanNumber === targetPlate);
    if (!targetVan) return;

    const updates: Record<string, unknown> = {
      manualChange: 1,
      vanId: targetVan.id,
      vehiclePlate: targetVan.vanNumber,
      driverName: targetVan.driverName,
      driverContact: targetVan.driverContact,
      inHouseOrOutsourced: "I",
    };

    // Any booking already on this van+day must also be marked manualChange=1
    // so the pair doesn't trigger a double-booked conflict.
    const existingOnCell = bookingMap.get(targetPlate)?.get(targetDay) ?? [];
    const cohabitants = existingOnCell.filter((b) => b.id !== booking.id && b.manualChange !== 1);

    // Clear drag state before the request so UI snaps back immediately
    setDragBookingId(null);
    setDragSourcePlate(null);
    setDragSourceDay(null);
    setDragOverCell(null);

    await Promise.all([
      fetch(`/api/bookings/${booking.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      }),
      ...cohabitants.map((b) =>
        fetch(`/api/bookings/${b.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ manualChange: 1 }),
        })
      ),
    ]).then((results) => {
      const failed = results.find((r) => !r.ok);
      if (failed) alert("Move failed");
    });
    await fetchData();
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-base)" }}>
      {/* Bottom Edit Panel */}
      {editPanel && editForm && (
        <div
          style={{ position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 50, background: "var(--bg-elevated)", borderTop: "2px solid var(--amber-border)", boxShadow: "0 -8px 40px rgba(0,0,0,0.5)", display: "flex", flexDirection: "column", maxHeight: "56vh" }}
        >
          {/* Panel header */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 20px", borderBottom: "1px solid var(--border)", background: "var(--bg-surface)", flexShrink: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ width: 3, height: 32, borderRadius: 2, background: "var(--amber)", flexShrink: 0 }} />
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", display: "flex", alignItems: "center", gap: 8 }}>
                  {editForm.invoiceNo
                    ? <span style={{ fontFamily: "var(--font-mono)", color: "var(--amber)" }}>{editForm.invoiceNo}</span>
                    : <span style={{ color: "var(--text-muted)" }}>No invoice</span>}
                  <span style={{ color: "var(--border)" }}>·</span>
                  <span>{editPanel.vanLabel}</span>
                  <span style={{ color: "var(--border)" }}>·</span>
                  <span style={{ color: "var(--text-secondary)", fontFamily: "var(--font-mono)", fontSize: 12 }}>{MONTH_SHORT[viewMonth]} {editPanel.booking.day}</span>
                </div>
                <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2, fontFamily: "var(--font-mono)" }}>Click any field to edit · press Save when done</div>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              <button
                onClick={() => { setEditPanel(null); setEditForm(null); }}
                className="btn btn-secondary"
                style={{ fontSize: 12 }}
              >
                Cancel
              </button>
              <button
                onClick={handleEditSave}
                disabled={editSaving}
                className="px-4 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {editSaving ? "Saving…" : "💾 Save Changes"}
              </button>
            </div>
          </div>

          {/* Panel body */}
          <div className="overflow-y-auto flex-1 px-5 py-4">
            <div className="grid grid-cols-4 gap-x-5 gap-y-3 text-xs">

              {/* ── Trip Details ── */}
              <div className="col-span-4 flex items-center gap-2 mt-0.5">
                <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest">Trip Details</span>
                <div className="flex-1 h-px bg-zinc-100" />
              </div>

              <div className="space-y-1">
                <label className="block text-zinc-500 font-medium">Invoice No.</label>
                <input
                  className="w-full border border-zinc-300 rounded-md px-2 py-1.5 text-zinc-800 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-blue-400 text-xs"
                  value={editForm.invoiceNo}
                  onChange={(e) => setEditForm((f) => f && { ...f, invoiceNo: e.target.value })}
                />
              </div>

              <div className="space-y-1">
                <label className="block text-zinc-500 font-medium">Travel Date</label>
                <input
                  type="date"
                  className="w-full border border-zinc-300 rounded-md px-2 py-1.5 text-zinc-800 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-blue-400 text-xs"
                  value={editForm.travelDate}
                  onChange={(e) => setEditForm((f) => f && { ...f, travelDate: e.target.value })}
                />
              </div>

              <div className="space-y-1">
                <label className="block text-zinc-500 font-medium">From Location</label>
                <input
                  className="w-full border border-zinc-300 rounded-md px-2 py-1.5 text-zinc-800 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-blue-400 text-xs"
                  value={editForm.fromLocation}
                  onChange={(e) => setEditForm((f) => f && { ...f, fromLocation: e.target.value })}
                />
              </div>

              <div className="space-y-1">
                <label className="block text-zinc-500 font-medium">To Location</label>
                <input
                  className="w-full border border-zinc-300 rounded-md px-2 py-1.5 text-zinc-800 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-blue-400 text-xs"
                  value={editForm.toLocation}
                  onChange={(e) => setEditForm((f) => f && { ...f, toLocation: e.target.value })}
                />
              </div>

              <div className="space-y-1">
                <label className="block text-zinc-500 font-medium">Trip Type</label>
                <select
                  className="w-full border border-zinc-300 rounded-md px-2 py-1.5 text-zinc-800 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-blue-400 text-xs bg-white"
                  value={editForm.tripType}
                  onChange={(e) => setEditForm((f) => f && { ...f, tripType: e.target.value })}
                >
                  <option value="trip">🟠 Trip</option>
                  <option value="one_way_ride">🔵 One Way</option>
                  <option value="round_trip">🟢 Round Trip</option>
                  <option value="day_trip">🟡 Day Trip</option>
                </select>
              </div>

              <div className="space-y-1 col-span-3">
                <label className="block text-zinc-500 font-medium">Details / Notes</label>
                <input
                  className="w-full border border-zinc-300 rounded-md px-2 py-1.5 text-zinc-800 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-blue-400 text-xs"
                  placeholder="Additional trip notes…"
                  value={editForm.details}
                  onChange={(e) => setEditForm((f) => f && { ...f, details: e.target.value })}
                />
              </div>

              <div className="space-y-1 col-span-2">
                <label className="block text-zinc-500 font-medium">Client Details</label>
                <textarea
                  rows={2}
                  className="w-full border border-zinc-300 rounded-md px-2 py-1.5 text-zinc-800 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-blue-400 text-xs resize-none"
                  placeholder="Client name, phone, notes…"
                  value={editForm.clientDetails}
                  onChange={(e) => setEditForm((f) => f && { ...f, clientDetails: e.target.value })}
                />
              </div>

              {/* ── Financials & Status ── */}
              <div className="col-span-4 flex items-center gap-2 mt-1">
                <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest">Financials & Status</span>
                <div className="flex-1 h-px bg-zinc-100" />
              </div>

              <div className="space-y-1">
                <label className="block text-zinc-500 font-medium">Amount (MYR)</label>
                <input
                  type="number" step="0.01" min="0"
                  className="w-full border border-zinc-300 rounded-md px-2 py-1.5 text-zinc-800 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-blue-400 text-xs"
                  value={editForm.amount}
                  onChange={(e) => setEditForm((f) => f && { ...f, amount: e.target.value })}
                />
              </div>

              <div className="space-y-1">
                <label className="block text-zinc-500 font-medium">Per Vehicle (MYR)</label>
                <input
                  type="number" step="0.01" min="0"
                  className="w-full border border-zinc-300 rounded-md px-2 py-1.5 text-zinc-800 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-blue-400 text-xs"
                  value={editForm.myrPerVehicle}
                  onChange={(e) => setEditForm((f) => f && { ...f, myrPerVehicle: e.target.value })}
                />
              </div>

              <div className="space-y-1">
                <label className="block text-zinc-500 font-medium">Passengers</label>
                <input
                  type="number" min="0"
                  className="w-full border border-zinc-300 rounded-md px-2 py-1.5 text-zinc-800 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-blue-400 text-xs"
                  value={editForm.passengerCount}
                  onChange={(e) => setEditForm((f) => f && { ...f, passengerCount: e.target.value })}
                />
              </div>

              <div className="space-y-1">
                <label className="block text-zinc-500 font-medium">Payment Status</label>
                <select
                  className="w-full border border-zinc-300 rounded-md px-2 py-1.5 text-zinc-800 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-blue-400 text-xs bg-white"
                  value={editForm.paidStatus}
                  onChange={(e) => setEditForm((f) => f && { ...f, paidStatus: e.target.value })}
                >
                  <option value="U">❌ Unpaid</option>
                  <option value="P">✅ Paid</option>
                </select>
              </div>

              {/* ── Vehicle & Driver ── */}
              <div className="col-span-4 flex items-center gap-2 mt-1">
                <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest">Vehicle & Driver</span>
                <div className="flex-1 h-px bg-zinc-100" />
              </div>

              <div className="space-y-1">
                <label className="block text-zinc-500 font-medium">Assign Van</label>
                <select
                  className="w-full border border-zinc-300 rounded-md px-2 py-1.5 text-zinc-800 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-blue-400 text-xs bg-white"
                  value={editForm.vanId}
                  onChange={(e) => {
                    const vanId = e.target.value;
                    const van = vans.find((v) => String(v.id) === vanId);
                    setEditForm((f) => f && {
                      ...f,
                      vanId,
                      vehiclePlate: van?.vanNumber ?? f.vehiclePlate,
                      driverName: van?.driverName ?? f.driverName,
                      driverContact: van?.driverContact ?? f.driverContact,
                      manualChange: Boolean(vanId),
                    });
                  }}
                >
                  <option value="">— Unassigned —</option>
                  {vans.map((v) => (
                    <option key={v.id} value={String(v.id)}>
                      {v.vanNumber}{v.driverName ? ` — ${v.driverName}` : ""}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label className="block text-zinc-500 font-medium">Vehicle Plate</label>
                <input
                  className="w-full border border-zinc-300 rounded-md px-2 py-1.5 text-zinc-800 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-blue-400 text-xs font-mono"
                  placeholder="e.g. WXX 1234"
                  value={editForm.vehiclePlate}
                  onChange={(e) => setEditForm((f) => f && { ...f, vehiclePlate: e.target.value })}
                />
              </div>

              <div className="space-y-1">
                <label className="block text-zinc-500 font-medium">Driver Name</label>
                <input
                  className="w-full border border-zinc-300 rounded-md px-2 py-1.5 text-zinc-800 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-blue-400 text-xs"
                  placeholder="Driver full name…"
                  value={editForm.driverName}
                  onChange={(e) => setEditForm((f) => f && { ...f, driverName: e.target.value })}
                />
              </div>

              <div className="space-y-1">
                <label className="block text-zinc-500 font-medium">Driver Contact</label>
                <input
                  className="w-full border border-zinc-300 rounded-md px-2 py-1.5 text-zinc-800 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-blue-400 text-xs"
                  placeholder="+60 …"
                  value={editForm.driverContact}
                  onChange={(e) => setEditForm((f) => f && { ...f, driverContact: e.target.value })}
                />
              </div>

              {/* ── Operations ── */}
              <div className="col-span-4 flex items-center gap-2 mt-1">
                <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest">Operations</span>
                <div className="flex-1 h-px bg-zinc-100" />
              </div>

              <div className="space-y-1">
                <label className="block text-zinc-500 font-medium">In-house / Outsourced</label>
                <select
                  className="w-full border border-zinc-300 rounded-md px-2 py-1.5 text-zinc-800 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-blue-400 text-xs bg-white"
                  value={editForm.inHouseOrOutsourced}
                  onChange={(e) => setEditForm((f) => f && { ...f, inHouseOrOutsourced: e.target.value })}
                >
                  <option value="I">🏠 In-house</option>
                  <option value="O">🔄 Outsourced</option>
                </select>
              </div>

              <div className="space-y-1">
                <label className="block text-zinc-500 font-medium">
                  Outsourced Company
                  {editForm.inHouseOrOutsourced !== "O" && (
                    <span className="ml-1 text-zinc-300">(inactive)</span>
                  )}
                </label>
                <input
                  className={`w-full border rounded-md px-2 py-1.5 text-zinc-800 focus:outline-none focus:ring-2 focus:ring-purple-400 focus:border-purple-400 text-xs ${editForm.inHouseOrOutsourced === "O" ? "border-zinc-300" : "border-zinc-200 bg-zinc-50 text-zinc-400"}`}
                  placeholder="Company name…"
                  disabled={editForm.inHouseOrOutsourced !== "O"}
                  value={editForm.outsourcedCompany}
                  onChange={(e) => setEditForm((f) => f && { ...f, outsourcedCompany: e.target.value })}
                />
              </div>

              {editForm.inHouseOrOutsourced === "O" && (
                <div className="space-y-1">
                  <label className="block text-zinc-500 font-medium">Outsource Reason</label>
                  <input
                    className="w-full border border-zinc-300 rounded-md px-2 py-1.5 text-zinc-800 focus:outline-none focus:ring-2 focus:ring-orange-400 focus:border-orange-400 text-xs"
                    placeholder="e.g. No van available, Bumped by priority trip…"
                    value={editForm.outsourceReason}
                    onChange={(e) => setEditForm((f) => f && { ...f, outsourceReason: e.target.value })}
                  />
                </div>
              )}

              <div className="space-y-1">
                <label className="block text-zinc-500 font-medium">Overtime</label>
                <input
                  className="w-full border border-zinc-300 rounded-md px-2 py-1.5 text-zinc-800 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-blue-400 text-xs"
                  placeholder="e.g. 2h"
                  value={editForm.overtime}
                  onChange={(e) => setEditForm((f) => f && { ...f, overtime: e.target.value })}
                />
              </div>

              <div className="space-y-1">
                <label className="block text-zinc-500 font-medium">Introducer</label>
                <input
                  className="w-full border border-zinc-300 rounded-md px-2 py-1.5 text-zinc-800 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-blue-400 text-xs"
                  placeholder="Referral / introducer name…"
                  value={editForm.introducer}
                  onChange={(e) => setEditForm((f) => f && { ...f, introducer: e.target.value })}
                />
              </div>

              <div className="space-y-1">
                <label className="block text-zinc-500 font-medium">Tour Guide</label>
                <input
                  className="w-full border border-zinc-300 rounded-md px-2 py-1.5 text-zinc-800 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-blue-400 text-xs"
                  placeholder="Guide name…"
                  value={editForm.tourGuide}
                  onChange={(e) => setEditForm((f) => f && { ...f, tourGuide: e.target.value })}
                />
              </div>

              <div className="col-span-3 flex items-center gap-2 mt-1">
                <input
                  type="checkbox"
                  id="edit-manual-change"
                  checked={editForm.manualChange}
                  onChange={(e) => setEditForm((f) => f && { ...f, manualChange: e.target.checked })}
                  className="rounded border-zinc-300 text-blue-600"
                />
                <label htmlFor="edit-manual-change" className="text-zinc-500 cursor-pointer select-none">
                  <span className="font-medium text-zinc-700">Lock van assignment</span>
                  <span className="text-zinc-400 ml-1">— prevents auto-reassignment when re-uploading PDFs</span>
                </label>
              </div>

              {/* Bottom padding */}
              <div className="col-span-4 h-2" />
            </div>
          </div>
        </div>
      )}

      {/* no local header — AppNav handles it */}

      <main className={`px-4 py-6 space-y-4 transition-all ${editPanel ? "pb-[58vh]" : ""}`}>
        {/* Month nav + issue badge */}
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <button
              onClick={prevMonth}
              className="btn btn-secondary"
              style={{ width: 32, height: 32, padding: 0, fontFamily: "var(--font-mono)" }}
            >
              ←
            </button>
            <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 16, color: "var(--text-primary)", width: 144, textAlign: "center", display: "inline-block" }}>
              {MONTH_NAMES[viewMonth]} {viewYear}
            </span>
            <button
              onClick={nextMonth}
              className="btn btn-secondary"
              style={{ width: 32, height: 32, padding: 0, fontFamily: "var(--font-mono)" }}
            >
              →
            </button>
          </div>
          {!loading && (
            totalIssues > 0 ? (
              <span style={{ padding: "3px 12px", borderRadius: 999, fontSize: 11, fontWeight: 700, fontFamily: "var(--font-mono)", background: "var(--red-dim)", border: "1px solid rgba(248,81,73,0.3)", color: "var(--red)" }}>
                ⚠ {totalIssues} conflict{totalIssues !== 1 ? "s" : ""}
              </span>
            ) : (
              <span style={{ padding: "3px 12px", borderRadius: 999, fontSize: 11, fontWeight: 700, fontFamily: "var(--font-mono)", background: "var(--green-dim)", border: "1px solid rgba(63,185,80,0.3)", color: "var(--green)" }}>
                ✓ All clear
              </span>
            )
          )}
          {!loading && (
            <button
              onClick={printSchedule}
              className="flex items-center gap-1.5 px-3 py-1 rounded-lg border border-zinc-300 bg-white hover:bg-zinc-50 text-zinc-700 text-xs font-medium transition-colors"
              title="Print A4 timetable"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 9V2h12v7M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2M6 14h12v8H6v-8z" />
              </svg>
              Print
            </button>
          )}
          {!loading && (
            <button
              onClick={exportJson}
              className="flex items-center gap-1.5 px-3 py-1 rounded-lg border border-zinc-300 bg-white hover:bg-zinc-50 text-zinc-700 text-xs font-medium transition-colors"
              title="Export this month's schedule as JSON for debugging"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Export JSON
            </button>
          )}
          {!loading && (
            <div className="flex items-center gap-3 ml-auto text-xs text-zinc-500">
              <span className="flex items-center gap-1">
                <span className="w-3 h-3 rounded-sm bg-blue-200 border border-blue-300 inline-block" />
                Normal
              </span>
              <span className="flex items-center gap-1">
                <span className="w-3 h-3 rounded-sm bg-purple-200 border border-purple-300 inline-block" />
                Outsourced
              </span>
              <span className="flex items-center gap-1">
                <span className="w-3 h-3 rounded-sm bg-amber-200 border border-amber-300 inline-block" />
                No driver
              </span>
              <span className="flex items-center gap-1">
                <span className="w-3 h-3 rounded-sm bg-red-200 border border-red-300 inline-block" />
                Conflict / No van
              </span>
              <span className="flex items-center gap-1">
                <span className="w-3 h-3 rounded-sm bg-blue-200 border border-blue-300 inline-block" style={{ borderLeft: "3px solid #f59e0b" }} />
                Multi-day trip (stripe = same invoice)
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
                  {vanRows.map(({ plate, label, isOutsourced, sgEnabled, thEnabled, isAlphard }) => {
                    const dayMap = bookingMap.get(plate) ?? new Map<number, BookingRow[]>();
                    return (
                      <tr
                        key={plate}
                        className={`border-b border-zinc-100 ${isOutsourced ? "bg-purple-50/30" : ""}`}
                      >
                        <td className={`sticky left-0 z-10 border-r border-zinc-200 px-3 py-2 min-w-[160px] ${isOutsourced ? "bg-purple-50" : "bg-white"}`}>
                          {isOutsourced ? (
                            <>
                              <div className="font-semibold text-purple-800 text-xs">{plate}</div>
                              <div className="text-purple-400 text-[10px]">Outsourced company</div>
                            </>
                          ) : (
                            <>
                              <div className="font-semibold text-zinc-900 text-xs flex items-center gap-1">
                                {plate}
                                {isAlphard && <span title="Toyota Alphard" className="text-[11px]">🚐</span>}
                              </div>
                              {label && (
                                <div className="text-zinc-400 text-[10px] truncate max-w-[140px]">{label}</div>
                              )}
                              {(sgEnabled || thEnabled) && (
                                <div className="flex items-center gap-0.5 mt-0.5">
                                  {sgEnabled && <span title="Singapore capable" className="text-[11px]">🇸🇬</span>}
                                  {thEnabled && <span title="Thailand capable" className="text-[11px]">🇹🇭</span>}
                                </div>
                              )}
                            </>
                          )}
                        </td>
                        {days.map((d) => {
                          const isToday = isCurrentMonth && d === today.getDate();
                          const bks = dayMap.get(d);
                          if (!bks || bks.length === 0) {
                            const isDropTarget = !isOutsourced && dragOverCell?.plate === plate && dragOverCell?.day === d;
                            return (
                              <td
                                key={d}
                                onDragOver={(e) => { if (!dragBookingId || isOutsourced || dragSourceDay !== d) return; e.preventDefault(); setDragOverCell({ plate, day: d }); }}
                                onDragLeave={(e) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDragOverCell(null); }}
                                onDrop={(e) => { e.preventDefault(); handleDrop(plate, d); setDragOverCell(null); }}
                                className={`border-r border-zinc-100 w-24 px-0.5 py-0.5 align-top transition-colors ${isToday ? "bg-blue-50/20" : ""} ${isOutsourced ? "bg-purple-50/20" : ""} ${isDropTarget ? "ring-2 ring-inset ring-blue-400 bg-blue-100/60" : ""}`}
                              />
                            );
                          }
                          const color = cellBg(bks, false);
                          const isDropTarget = !isOutsourced && dragOverCell?.plate === plate && dragOverCell?.day === d;
                          return (
                            <td
                              key={d}
                              onDragOver={(e) => { if (!dragBookingId || isOutsourced || dragSourceDay !== d) return; e.preventDefault(); setDragOverCell({ plate, day: d }); }}
                              onDragLeave={(e) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDragOverCell(null); }}
                              onDrop={(e) => { e.preventDefault(); handleDrop(plate, d); setDragOverCell(null); }}
                              className={`border-r border-zinc-100 w-24 px-0.5 py-0.5 align-top transition-colors ${isToday ? "bg-blue-50/20" : ""} ${isDropTarget ? "ring-2 ring-inset ring-blue-400 bg-blue-100/40" : ""}`}
                            >
                              {bks.map((b, bi) => (
                                <div
                                  key={b.id}
                                  draggable={!isOutsourced}
                                  onDragStart={(e) => {
                                    if (isOutsourced) return;
                                    setDragBookingId(b.id);
                                    setDragSourcePlate(plate);
                                    setDragSourceDay(d);
                                    e.dataTransfer.effectAllowed = "move";
                                    e.stopPropagation();
                                  }}
                                  onDragEnd={() => {
                                    setDragBookingId(null);
                                    setDragSourcePlate(null);
                                    setDragSourceDay(null);
                                    setDragOverCell(null);
                                  }}
                                  className={`rounded border px-1.5 py-1 transition-opacity ${isOutsourced ? "cursor-pointer" : "cursor-grab active:cursor-grabbing"} hover:opacity-80 ${bi > 0 ? "mt-0.5" : ""} ${color} ${dragBookingId === b.id ? "opacity-40 scale-95" : ""}`}
                                  style={b.invoiceNo && invoiceColorMap.has(b.invoiceNo) ? { borderLeft: `3px solid ${invoiceColorMap.get(b.invoiceNo)}` } : undefined}
                                  onClick={() => { if (!dragBookingId) openEdit(b, plate); }}
                                >
                                  <div className="font-semibold truncate max-w-[84px] leading-tight">
                                    {clientFirstLine(b) || "—"}
                                  </div>
                                  <div className="truncate max-w-[84px] opacity-75 leading-tight mt-0.5">
                                    {b.fromLocation && b.toLocation
                                      ? `${b.fromLocation}→${b.toLocation}`
                                      : b.details || "—"}
                                  </div>
                                  {b.invoiceNo && (
                                    <div className="font-mono text-[9px] leading-tight mt-0.5 opacity-70 whitespace-nowrap overflow-hidden" title={b.invoiceNo}>
                                      {b.invoiceNo}
                                    </div>
                                  )}
                                  {isOutsourced && (
                                    <div className="text-[9px] leading-tight mt-0.5 text-purple-600 font-semibold">
                                      🟣 Outsourced
                                    </div>
                                  )}
                                  {!isOutsourced && b.tripType && (
                                    <div className="text-[9px] leading-tight mt-0.5 opacity-80">
                                      {b.tripType === "one_way_ride" ? "🔵 One Way" :
                                       b.tripType === "round_trip"   ? "🟢 Round Trip" :
                                       b.tripType === "day_trip"     ? "🟡 Day Trip" : "🟠 Trip"}
                                    </div>
                                  )}
                                  {(() => {
                                    const { sg, th } = tripDestinationFlags(b);
                                    if (!sg && !th) return null;
                                    return (
                                      <div className="text-[10px] leading-tight mt-0.5 font-semibold">
                                        {sg && <span title="Singapore trip">🇸🇬</span>}
                                        {th && <span title="Thailand trip">🇹🇭</span>}
                                      </div>
                                    );
                                  })()}
                                  {!isOutsourced && bks.length > 1 && bi === 0 && !bks.every((b) => b.manualChange === 1) && (
                                    <div className="text-[10px] font-bold mt-0.5">⚠️ CONFLICT +{bks.length - 1}</div>
                                  )}
                                </div>
                              ))}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}

                  {/* UNASSIGNED row — unassigned + unconfirmed outsourced ("OUTSOURCE COMPANY NEEDED") */}
                  {noVanMap.size > 0 && [...noVanMap.values()].some(
                    (bks) => bks.some((b) => !isConfirmedOutsourced(b))
                  ) && (
                    <tr className="border-b border-zinc-100">
                      <td className="sticky left-0 z-10 bg-red-50 border-r border-zinc-200 px-3 py-2 min-w-[160px]">
                        <div className="font-semibold text-red-700 text-xs">⚠️ UNASSIGNED</div>
                        <div className="text-red-400 text-[10px]">Conflict / No van</div>
                      </td>
                      {days.map((d) => {
                        const isToday = isCurrentMonth && d === today.getDate();
                        const bks = (noVanMap.get(d) ?? []).filter(
                          (b) => !isConfirmedOutsourced(b)
                        );
                        if (bks.length === 0) {
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
                                draggable
                                onDragStart={(e) => {
                                  setDragBookingId(b.id);
                                  setDragSourcePlate("");
                                  setDragSourceDay(d);
                                  e.dataTransfer.effectAllowed = "move";
                                  e.stopPropagation();
                                }}
                                onDragEnd={() => {
                                  setDragBookingId(null);
                                  setDragSourcePlate(null);
                                  setDragSourceDay(null);
                                  setDragOverCell(null);
                                }}
                                className={`rounded border px-1.5 py-1 mb-0.5 cursor-grab active:cursor-grabbing hover:opacity-80 transition-opacity bg-red-100 border-red-300 text-red-900 ${dragBookingId === b.id ? "opacity-40" : ""}`}
                                style={b.invoiceNo && invoiceColorMap.has(b.invoiceNo) ? { borderLeft: `3px solid ${invoiceColorMap.get(b.invoiceNo)}` } : undefined}
                                onClick={() => { if (!dragBookingId) openEdit(b, "No Van"); }}
                              >
                                <div className="font-semibold truncate max-w-[84px] leading-tight">
                                  {clientFirstLine(b) || "—"}
                                </div>
                                <div className="truncate max-w-[84px] opacity-75 leading-tight mt-0.5">
                                  {b.details || `${b.fromLocation}→${b.toLocation}`}
                                </div>
                                <div className="font-mono opacity-60 text-[9px] leading-tight mt-0.5 whitespace-nowrap overflow-hidden" title={b.invoiceNo ?? ""}>
                                  {b.invoiceNo}
                                </div>
                              </div>
                            ))}
                          </td>
                        );
                      })}
                    </tr>
                  )}

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

            {/* ── Action Table ── */}
            <div className={`rounded-xl border shadow-sm bg-white overflow-hidden ${totalIssues > 0 ? "border-red-200" : "border-green-200"}`}>
              <div className={`px-4 py-3 border-b flex items-center justify-between ${totalIssues > 0 ? "bg-red-50 border-red-200" : "bg-green-50 border-green-200"}`}>
                <h2 className={`text-sm font-semibold ${totalIssues > 0 ? "text-red-800" : "text-green-700"}`}>
                  {totalIssues > 0
                    ? `⚠ ${totalIssues} Conflict${totalIssues !== 1 ? "s" : ""} — Action Required`
                    : "✓ All clear — no conflicts this month"}
                </h2>
                {totalIssues > 0 && (
                  <span className="text-xs text-zinc-400">
                    Assign a free van, or outsource to a company (creates a temporary row)
                  </span>
                )}
              </div>

              {totalIssues > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs border-collapse">
                    <thead>
                      <tr className="bg-zinc-50 border-b border-zinc-200 text-zinc-500 uppercase tracking-wide text-[10px]">
                        <th className="px-4 py-2.5 text-left font-semibold w-28">Type</th>
                        <th className="px-4 py-2.5 text-left font-semibold w-20">Date</th>
                        <th className="px-4 py-2.5 text-left font-semibold w-28">Current Van</th>
                        <th className="px-4 py-2.5 text-left font-semibold w-28">Invoice</th>
                        <th className="px-4 py-2.5 text-left font-semibold">Client / Route</th>
                        <th className="px-4 py-2.5 text-left font-semibold min-w-[340px]">Suggested Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-100">

                      {/* Double-booked */}
                      {conflicts
                        .filter((c) => c.type === "double-booked")
                        .flatMap((c) =>
                          c.bookings.map((b, idx) => {
                            const free = freeVansOnDay(c.dayNum);
                            const isLoading = actionLoading[b.id];
                            const isDone = actionDone[b.id];
                            return (
                              <tr key={`db-${b.id}`} className="hover:bg-red-50/40 transition-colors">
                                <td className="px-4 py-3">
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-semibold text-[10px] border border-red-200">
                                    🔴 Double-booked
                                  </span>
                                  <div className={`text-[9px] mt-0.5 ${idx > 0 ? "text-red-400 font-medium" : "text-zinc-400"}`}>
                                    {idx > 0 ? "← reassign this" : `booking #${idx + 1} of ${c.bookings.length}`}
                                  </div>
                                </td>
                                <td className="px-4 py-3 font-medium text-zinc-700">
                                  {MONTH_SHORT[viewMonth]} {c.dayNum}
                                </td>
                                <td className="px-4 py-3 text-zinc-600 font-mono text-[11px]">
                                  {c.plate || <span className="text-zinc-400 font-sans italic">None</span>}
                                </td>
                                <td className="px-4 py-3 text-zinc-600">
                                  {b.invoiceNo || <span className="text-zinc-400 italic">—</span>}
                                </td>
                                <td className="px-4 py-3">
                                  <div className="text-zinc-800 font-medium truncate max-w-[180px]">{clientFirstLine(b) || "—"}</div>
                                  <div className="text-zinc-400 truncate max-w-[180px] mt-0.5">
                                    {b.fromLocation && b.toLocation ? `${b.fromLocation} → ${b.toLocation}` : b.details || "—"}
                                  </div>
                                </td>
                                <td className="px-4 py-3">
                                  {isDone ? (
                                    <span className="text-green-600 font-medium text-[11px]">✓ Resolved</span>
                                  ) : (
                                    <div className="space-y-2">
                                      {/* Assign to van */}
                                      <div className="flex items-center gap-2">
                                        <select
                                          value={selectedVan[b.id] ?? ""}
                                          onChange={(e) => setSelectedVan((prev) => ({ ...prev, [b.id]: e.target.value }))}
                                          className="text-xs border border-zinc-300 rounded-md px-2 py-1.5 bg-white text-zinc-700 focus:outline-none focus:ring-1 focus:ring-blue-400 min-w-[140px]"
                                          disabled={isLoading}
                                        >
                                          <option value="">
                                            {free.length === 0 ? "No free vans" : "Pick a free van…"}
                                          </option>
                                          {free.map((v) => (
                                            <option key={v.id} value={v.id}>
                                              {v.vanNumber}{v.driverName ? ` — ${v.driverName}` : ""}
                                            </option>
                                          ))}
                                        </select>
                                        <button
                                          onClick={() => handleAssignVan(b.id)}
                                          disabled={!selectedVan[b.id] || isLoading}
                                          className="px-3 py-1.5 rounded-md bg-blue-600 text-white text-[11px] font-semibold hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                        >
                                          {isLoading ? "Saving…" : "Reassign"}
                                        </button>
                                      </div>
                                      {/* Or outsource */}
                                      <div className="flex items-center gap-2">
                                        <span className="text-[10px] text-zinc-400 w-6 text-center">or</span>
                                        <input
                                          type="text"
                                          placeholder="Outsource company name…"
                                          value={outsourcingInput[b.id] ?? ""}
                                          onChange={(e) => setOutsourcingInput((prev) => ({ ...prev, [b.id]: e.target.value }))}
                                          className="text-xs border border-zinc-300 rounded-md px-2 py-1.5 bg-white text-zinc-700 focus:outline-none focus:ring-1 focus:ring-purple-400 focus:border-purple-400 min-w-[160px]"
                                          disabled={isLoading}
                                        />
                                        <button
                                          onClick={() => handleOutsource(b.id)}
                                          disabled={!outsourcingInput[b.id]?.trim() || isLoading}
                                          className="px-3 py-1.5 rounded-md bg-purple-600 text-white text-[11px] font-semibold hover:bg-purple-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
                                        >
                                          {isLoading ? "Saving…" : "Outsource →"}
                                        </button>
                                      </div>
                                      {/* Allow all on this van+day as intentional */}
                                      {idx === 0 && (
                                        <div className="flex items-center gap-2">
                                          <span className="text-[10px] text-zinc-400 w-6 text-center">or</span>
                                          <button
                                            onClick={() => handleAllowDoubleBook(c.bookings)}
                                            disabled={isLoading}
                                            className="px-3 py-1.5 rounded-md bg-zinc-600 text-white text-[11px] font-semibold hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
                                          >
                                            {isLoading ? "Saving…" : "✓ Allow (keep both)"}
                                          </button>
                                          <span className="text-[10px] text-zinc-400">mark all as manual</span>
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </td>
                              </tr>
                            );
                          })
                        )}

                      {/* No-van */}
                      {conflicts
                        .filter((c) => c.type === "no-van")
                        .map((c) => {
                          const b = c.bookings[0];
                          const free = freeVansOnDay(c.dayNum);
                          const isLoading = actionLoading[b.id];
                          const isDone = actionDone[b.id];
                          return (
                            <tr key={`nv-${b.id}`} className="hover:bg-red-50/40 transition-colors">
                              <td className="px-4 py-3">
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-orange-100 text-orange-700 font-semibold text-[10px] border border-orange-200">
                                  🟠 No Van
                                </span>
                              </td>
                              <td className="px-4 py-3 font-medium text-zinc-700">
                                {MONTH_SHORT[viewMonth]} {c.dayNum}
                              </td>
                              <td className="px-4 py-3">
                                <span className="text-zinc-400 italic">Unassigned</span>
                              </td>
                              <td className="px-4 py-3 text-zinc-600">
                                {b.invoiceNo || <span className="text-zinc-400 italic">—</span>}
                              </td>
                              <td className="px-4 py-3">
                                <div className="text-zinc-800 font-medium truncate max-w-[180px]">{clientFirstLine(b) || "—"}</div>
                                <div className="text-zinc-400 truncate max-w-[180px] mt-0.5">
                                  {b.fromLocation && b.toLocation ? `${b.fromLocation} → ${b.toLocation}` : b.details || "—"}
                                </div>
                                {b.vehicleCategory && (
                                  <span className={`inline-block mt-1 px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                                    b.vehicleCategory === "Alphard" ? "bg-purple-100 text-purple-700" :
                                    b.vehicleCategory === "Car" ? "bg-blue-100 text-blue-700" :
                                    "bg-zinc-100 text-zinc-600"
                                  }`}>
                                    {b.vehicleCategory === "Alphard" ? "🚐 Alphard required" :
                                     b.vehicleCategory === "Car" ? "🚗 Car required" :
                                     "🚐 Van required"}
                                  </span>
                                )}
                              </td>
                              <td className="px-4 py-3">
                                {isDone ? (
                                  <span className="text-green-600 font-medium text-[11px]">✓ Resolved</span>
                                ) : (
                                  <div className="space-y-2">
                                    {/* Assign to van */}
                                    <div className="flex items-center gap-2">
                                      <select
                                        value={selectedVan[b.id] ?? ""}
                                        onChange={(e) => setSelectedVan((prev) => ({ ...prev, [b.id]: e.target.value }))}
                                        className="text-xs border border-zinc-300 rounded-md px-2 py-1.5 bg-white text-zinc-700 focus:outline-none focus:ring-1 focus:ring-blue-400 min-w-[140px]"
                                        disabled={isLoading}
                                      >
                                        <option value="">
                                          {free.length === 0 ? "No free vans" : "Pick a free van…"}
                                        </option>
                                        {free.map((v) => (
                                          <option key={v.id} value={v.id}>
                                            {v.vanNumber}{v.driverName ? ` — ${v.driverName}` : ""}
                                          </option>
                                        ))}
                                      </select>
                                      <button
                                        onClick={() => handleAssignVan(b.id)}
                                        disabled={!selectedVan[b.id] || isLoading}
                                        className="px-3 py-1.5 rounded-md bg-blue-600 text-white text-[11px] font-semibold hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                      >
                                        {isLoading ? "Saving…" : "Assign Van"}
                                      </button>
                                    </div>
                                    {/* Or outsource with company name */}
                                    <div className="flex items-center gap-2">
                                      <span className="text-[10px] text-zinc-400 w-6 text-center">or</span>
                                      <input
                                        type="text"
                                        placeholder="Outsource company name…"
                                        value={outsourcingInput[b.id] ?? ""}
                                        onChange={(e) => setOutsourcingInput((prev) => ({ ...prev, [b.id]: e.target.value }))}
                                        onKeyDown={(e) => e.key === "Enter" && handleOutsource(b.id)}
                                        className="text-xs border border-zinc-300 rounded-md px-2 py-1.5 bg-white text-zinc-700 focus:outline-none focus:ring-1 focus:ring-purple-400 focus:border-purple-400 min-w-[160px]"
                                        disabled={isLoading}
                                      />
                                      <button
                                        onClick={() => handleOutsource(b.id)}
                                        disabled={!outsourcingInput[b.id]?.trim() || isLoading}
                                        className="px-3 py-1.5 rounded-md bg-purple-600 text-white text-[11px] font-semibold hover:bg-purple-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
                                      >
                                        {isLoading ? "Saving…" : "Outsource →"}
                                      </button>
                                    </div>
                                    {outsourcingInput[b.id]?.trim() && (
                                      <p className="text-[10px] text-purple-600 pl-8">
                                        A row for &quot;{outsourcingInput[b.id].trim()}&quot; will appear in the calendar.
                                      </p>
                                    )}
                                  </div>
                                )}
                              </td>
                            </tr>
                          );
                        })}

                      {/* No-driver warnings */}
                      {warnings
                        .filter((w) => w.type === "no-driver")
                        .map((w) => {
                          const b = w.bookings[0];
                          return (
                            <tr key={`nd-${b.id}`} className="hover:bg-amber-50/40 transition-colors">
                              <td className="px-4 py-3">
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-semibold text-[10px] border border-amber-200">
                                  🟡 No Driver
                                </span>
                              </td>
                              <td className="px-4 py-3 font-medium text-zinc-700">
                                {MONTH_SHORT[viewMonth]} {w.dayNum}
                              </td>
                              <td className="px-4 py-3 text-zinc-600 font-mono text-[11px]">
                                {w.plate}
                              </td>
                              <td className="px-4 py-3 text-zinc-600">
                                {b.invoiceNo || <span className="text-zinc-400 italic">—</span>}
                              </td>
                              <td className="px-4 py-3">
                                <div className="text-zinc-800 font-medium truncate max-w-[180px]">{clientFirstLine(b) || "—"}</div>
                                <div className="text-zinc-400 truncate max-w-[180px] mt-0.5">
                                  {b.fromLocation && b.toLocation ? `${b.fromLocation} → ${b.toLocation}` : b.details || "—"}
                                </div>
                              </td>
                              <td className="px-4 py-3">
                                <div className="flex items-center gap-2">
                                  <span className="text-zinc-500 text-[11px]">
                                    Van <span className="font-mono font-semibold text-zinc-700">{w.plate}</span> has no driver record.
                                  </span>
                                  <Link
                                    href="/"
                                    className="px-3 py-1.5 rounded-md bg-amber-500 text-white text-[11px] font-semibold hover:bg-amber-600 transition-colors whitespace-nowrap"
                                  >
                                    Edit Van →
                                  </Link>
                                </div>
                              </td>
                            </tr>
                          );
                        })}

                    </tbody>
                  </table>
                </div>
              )}

              {totalIssues === 0 && (
                <div className="px-4 py-4">
                  <p className="text-sm text-green-700 font-medium">✓ All clear — no conflicts this month</p>
                </div>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
