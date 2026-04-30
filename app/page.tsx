"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { locationConfig } from "@/lib/config";

interface Van {
  id: number;
  vanNumber: string;
  driverName: string | null;
  driverContact: string | null;
  singaporeEnabled: number;
  thailandEnabled: number;
  maxPaxCapacity: number | null;
  location: string | null;
  vehicleType: string | null;
}

const VAN_COLORS = [
  { bg: "rgba(88,166,255,0.08)",  border: "rgba(88,166,255,0.25)",  text: "#58a6ff" },
  { bg: "rgba(63,185,80,0.08)",   border: "rgba(63,185,80,0.25)",   text: "#3fb950" },
  { bg: "rgba(245,158,11,0.08)",  border: "rgba(245,158,11,0.25)",  text: "#f59e0b" },
  { bg: "rgba(248,81,73,0.08)",   border: "rgba(248,81,73,0.25)",   text: "#f85149" },
  { bg: "rgba(167,139,250,0.08)", border: "rgba(167,139,250,0.25)", text: "#a78bfa" },
  { bg: "rgba(34,211,238,0.08)",  border: "rgba(34,211,238,0.25)",  text: "#22d3ee" },
  { bg: "rgba(251,146,60,0.08)",  border: "rgba(251,146,60,0.25)",  text: "#fb923c" },
  { bg: "rgba(244,114,182,0.08)", border: "rgba(244,114,182,0.25)", text: "#f472b6" },
];

function Modal({
  title, body, confirm, confirmLabel, onClose, danger
}: {
  title: string; body: string; confirm: () => void; confirmLabel: string; onClose: () => void; danger?: boolean;
}) {
  return (
    <div
      style={{
        position: "fixed", inset: 0,
        background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 50,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "var(--bg-elevated)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          padding: 24,
          maxWidth: 420,
          width: "calc(100% - 32px)",
          boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
        }}
        onClick={e => e.stopPropagation()}
        className="fade-up"
      >
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: 18, fontWeight: 700, color: "var(--text-primary)", marginBottom: 8 }}>
          {title}
        </h2>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 20, lineHeight: 1.6 }}>{body}</p>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button
            className={`btn ${danger ? "btn-danger" : "btn-primary"}`}
            onClick={confirm}
            style={danger ? { background: "var(--red)", color: "#fff", borderColor: "var(--red)" } : {}}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

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
  const [newVehicleType, setNewVehicleType] = useState("van");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [showClearAllModal, setShowClearAllModal] = useState(false);
const [actionMessage, setActionMessage] = useState("");
  const [rechecking, setRechecking] = useState(false);
  const [recheckLogs, setRecheckLogs] = useState<string[]>([]);
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [aiReasoning, setAiReasoning] = useState<Array<{ bookingId: number; van: string | null; action: string; reasoning: string }>>([]);
  const [showReasoning, setShowReasoning] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => { logEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [recheckLogs]);

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
          vehicleType: newVehicleType,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to add van");
      setSuccess(`Van ${data.vanNumber} added`);
      setNewPlate(""); setNewDriverName(""); setNewDriverContact("");
      setNewSingapore(false); setNewThailand(false);
      setNewMaxPax(4); setNewLocation(""); setNewVehicleType("van");
      await fetchVans();
    } catch (e) { setError(String(e)); }
    finally { setVanLoading(false); }
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
    } catch (e) { setError(String(e)); }
  }

  async function handleDeleteVan(id: number, plate: string) {
    if (!confirm(`Remove van ${plate}?`)) return;
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
    } catch (e) { setError(String(e)); }
  }

  const handleClearAll = async () => {
    setShowClearAllModal(false);
    const res = await fetch("/api/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "CLEAR BOOKINGS" }),
    });
    setActionMessage(res.ok ? "All bookings deleted" : "Failed to delete bookings");
  };

const handleRecheck = async () => {
    setRechecking(true);
    setActionMessage("");
    setRecheckLogs([]);
    setAiSummary(null);
    setAiReasoning([]);
    setShowReasoning(false);
    try {
      const res = await fetch("/api/reassign", { method: "POST" });
      if (!res.ok || !res.body) { setActionMessage("error:Recheck failed: network error"); return; }
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
          if (payload === "[DONE]") {
            setActionMessage("done:Van assignments rechecked — same invoice = same van enforced, no double-bookings.");
          } else if (payload.startsWith("[ERROR]")) {
            setActionMessage(`error:${payload.slice(7).trim()}`);
          } else if (payload.startsWith("[AI_SUMMARY]")) {
            try {
              const aiData = JSON.parse(payload.slice("[AI_SUMMARY]".length));
              setAiSummary(aiData.summary ?? "");
              setAiReasoning(aiData.reasoning ?? []);
            } catch {}
          } else {
            setRecheckLogs(prev => [...prev, payload]);
          }
        }
      }
    } catch { setActionMessage("error:Recheck failed: network error"); }
    finally { setRechecking(false); }
  };

  const S: Record<string, React.CSSProperties> = {
    page: { maxWidth: 960, margin: "0 auto", padding: "32px 24px", display: "flex", flexDirection: "column", gap: 20 },
    sectionHeader: {
      fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 600,
      letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-muted)",
      marginBottom: 14,
    },
    card: {
      background: "var(--bg-surface)", border: "1px solid var(--border)",
      borderRadius: 12, padding: 20,
    },
    label: { fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text-muted)", marginBottom: 4, display: "block", letterSpacing: "0.04em" },
  };

  return (
    <div style={S.page} className="fade-up">

      {/* Alerts */}
      {error   && <div className="alert alert-error fade-up">{error}</div>}
      {success && <div className="alert alert-success fade-up">{success}</div>}

      {/* ── Fleet Management ─────────────────────────────────── */}
      <section style={S.card}>
        <p style={S.sectionHeader}>Fleet Management</p>

        <form onSubmit={handleAddVan} style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 20, alignItems: "flex-end" }}>
          {/* Plate */}
          <div>
            <label style={S.label}>Plate</label>
            <input
              className="input-base"
              style={{ height: 34, width: 120, padding: "0 10px", textTransform: "uppercase", fontFamily: "var(--font-mono)", letterSpacing: "0.05em" }}
              placeholder="VAN-001"
              value={newPlate}
              onChange={e => setNewPlate(e.target.value)}
              required
            />
          </div>
          {/* Driver */}
          <div style={{ flex: 1, minWidth: 160 }}>
            <label style={S.label}>Driver</label>
            <input
              className="input-base"
              style={{ height: 34, width: "100%", padding: "0 10px" }}
              placeholder="Driver name"
              value={newDriverName}
              onChange={e => setNewDriverName(e.target.value)}
              required
            />
          </div>
          {/* Contact */}
          <div>
            <label style={S.label}>Contact</label>
            <input
              className="input-base"
              style={{ height: 34, width: 148, padding: "0 10px" }}
              placeholder="+60 12-xxx xxxx"
              value={newDriverContact}
              onChange={e => setNewDriverContact(e.target.value)}
            />
          </div>
          {/* Vehicle type */}
          <div>
            <label style={S.label}>Type</label>
            <input
              className="input-base"
              style={{ height: 34, width: 140, padding: "0 10px" }}
              placeholder="van / Alphard"
              value={newVehicleType}
              onChange={e => setNewVehicleType(e.target.value)}
            />
          </div>
          {/* Base */}
          <div>
            <label style={S.label}>Base</label>
            <select
              className="input-base"
              style={{ height: 34, padding: "0 10px" }}
              value={newLocation}
              onChange={e => setNewLocation(e.target.value)}
            >
              <option value="">Any</option>
              {locationConfig.map(l => <option key={l} value={l}>{l}</option>)}
            </select>
          </div>
          {/* Pax */}
          <div>
            <label style={S.label}>Seats</label>
            <input
              className="input-base"
              type="number" min={1} max={50}
              style={{ height: 34, width: 64, padding: "0 10px", textAlign: "center" }}
              value={newMaxPax}
              onChange={e => setNewMaxPax(Number(e.target.value))}
            />
          </div>
          {/* SG / TH toggles */}
          <div>
            <label style={S.label}>Routes</label>
            <div style={{ display: "flex", gap: 6, height: 34, alignItems: "center" }}>
              <label style={{
                display: "flex", alignItems: "center", gap: 5, cursor: "pointer",
                padding: "0 10px", height: 34, borderRadius: 6,
                background: newSingapore ? "rgba(248,81,73,0.12)" : "var(--bg-muted)",
                border: `1px solid ${newSingapore ? "rgba(248,81,73,0.4)" : "var(--border)"}`,
                fontSize: 12, color: newSingapore ? "var(--red)" : "var(--text-muted)",
                transition: "all 0.15s",
              }}>
                <input type="checkbox" checked={newSingapore} onChange={e => setNewSingapore(e.target.checked)} style={{ display: "none" }} />
                🇸🇬 SG
              </label>
              <label style={{
                display: "flex", alignItems: "center", gap: 5, cursor: "pointer",
                padding: "0 10px", height: 34, borderRadius: 6,
                background: newThailand ? "rgba(88,166,255,0.12)" : "var(--bg-muted)",
                border: `1px solid ${newThailand ? "rgba(88,166,255,0.4)" : "var(--border)"}`,
                fontSize: 12, color: newThailand ? "var(--blue)" : "var(--text-muted)",
                transition: "all 0.15s",
              }}>
                <input type="checkbox" checked={newThailand} onChange={e => setNewThailand(e.target.checked)} style={{ display: "none" }} />
                🇹🇭 TH
              </label>
            </div>
          </div>
          <button
            type="submit"
            disabled={vanLoading || !newPlate.trim() || !newDriverName.trim()}
            className="btn btn-primary"
            style={{ alignSelf: "flex-end", fontWeight: 600 }}
          >
            {vanLoading ? "Adding…" : "+ Add Van"}
          </button>
        </form>

        {/* Fleet list */}
        {vans.length === 0 ? (
          <p style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>No vans. Add one above.</p>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            {vans.map((van, i) => {
              const c = VAN_COLORS[i % VAN_COLORS.length];
              return (
                <div
                  key={van.id}
                  style={{
                    background: c.bg, border: `1px solid ${c.border}`,
                    borderRadius: 10, padding: "10px 12px",
                    minWidth: 148, position: "relative",
                  }}
                >
                  {/* Delete */}
                  <button
                    onClick={() => handleDeleteVan(van.id, van.vanNumber)}
                    style={{
                      position: "absolute", top: 6, right: 8,
                      background: "none", border: "none", cursor: "pointer",
                      color: "var(--text-muted)", fontSize: 14, lineHeight: 1,
                      padding: 2, borderRadius: 4,
                    }}
                    title="Remove van"
                    onMouseEnter={e => (e.currentTarget.style.color = "var(--red)")}
                    onMouseLeave={e => (e.currentTarget.style.color = "var(--text-muted)")}
                  >
                    ×
                  </button>
                  {/* Plate */}
                  <div style={{ fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: 13, color: c.text, marginBottom: 4, paddingRight: 16 }}>
                    {van.vanNumber}
                  </div>
                  {van.vehicleType && (
                    <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 2 }}>🚐 {van.vehicleType}</div>
                  )}
                  {van.driverName && (
                    <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 1 }}>{van.driverName}</div>
                  )}
                  {van.driverContact && (
                    <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{van.driverContact}</div>
                  )}
                  {van.maxPaxCapacity != null && (
                    <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 3 }}>👥 {van.maxPaxCapacity - 1}+1 pax</div>
                  )}
                  {van.location && (
                    <div style={{ fontSize: 10, color: "var(--text-muted)" }}>📍 {van.location}</div>
                  )}
                  {/* Route toggles */}
                  <div style={{ display: "flex", gap: 4, marginTop: 8 }}>
                    <button
                      onClick={() => handleToggleCapability(van.id, "singaporeEnabled", van.singaporeEnabled)}
                      style={{
                        padding: "2px 7px", borderRadius: 4, fontSize: 10, fontWeight: 600,
                        fontFamily: "var(--font-mono)", cursor: "pointer", border: "1px solid",
                        background: van.singaporeEnabled ? "rgba(248,81,73,0.15)" : "transparent",
                        color: van.singaporeEnabled ? "var(--red)" : "var(--text-muted)",
                        borderColor: van.singaporeEnabled ? "rgba(248,81,73,0.4)" : "var(--border-muted)",
                        textDecoration: van.singaporeEnabled ? "none" : "line-through",
                        transition: "all 0.15s",
                      }}
                    >SG</button>
                    <button
                      onClick={() => handleToggleCapability(van.id, "thailandEnabled", van.thailandEnabled)}
                      style={{
                        padding: "2px 7px", borderRadius: 4, fontSize: 10, fontWeight: 600,
                        fontFamily: "var(--font-mono)", cursor: "pointer", border: "1px solid",
                        background: van.thailandEnabled ? "rgba(88,166,255,0.15)" : "transparent",
                        color: van.thailandEnabled ? "var(--blue)" : "var(--text-muted)",
                        borderColor: van.thailandEnabled ? "rgba(88,166,255,0.4)" : "var(--border-muted)",
                        textDecoration: van.thailandEnabled ? "none" : "line-through",
                        transition: "all 0.15s",
                      }}
                    >TH</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Scheduler Recheck ─────────────────────────────────── */}
      <section style={{ ...S.card, borderColor: "var(--amber-border)", boxShadow: "0 0 0 1px var(--amber-border), 0 4px 24px var(--amber-glow)" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, marginBottom: 16 }}>
          <div>
            <p style={S.sectionHeader}>Van Assignment Recheck</p>
            <p style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.6, maxWidth: 480 }}>
              Re-runs the full scheduler: enforces same-invoice van consistency, eliminates double-bookings, outsources trips that cannot fit.
            </p>
          </div>
          <span style={{
            display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 8px",
            borderRadius: 4, fontSize: 10, fontWeight: 700, letterSpacing: "0.06em",
            fontFamily: "var(--font-mono)", textTransform: "uppercase",
            background: "rgba(245,158,11,0.2)", border: "1px solid rgba(245,158,11,0.4)", color: "var(--amber)",
          }}>
            ✦ AI
          </span>
        </div>

        {actionMessage && (
          <div className={`alert fade-up ${actionMessage.startsWith("done") ? "alert-success" : "alert-error"}`} style={{ marginBottom: 14 }}>
            {actionMessage.startsWith("done:") ? actionMessage.slice(5) : actionMessage.startsWith("error:") ? actionMessage.slice(6) : actionMessage}
          </div>
        )}

        <button
          onClick={handleRecheck}
          disabled={rechecking}
          className="btn btn-primary"
          style={{ fontWeight: 600 }}
        >
          {rechecking ? (
            <>
              <svg className="spin" style={{ width: 14, height: 14 }} viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" opacity="0.25"/>
                <path fill="currentColor" opacity="0.75" d="M4 12a8 8 0 018-8v8z"/>
              </svg>
              Rechecking…
            </>
          ) : (
            <>
              <svg style={{ width: 14, height: 14 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Recheck Assignments
            </>
          )}
        </button>

        {/* AI Summary */}
        {aiSummary && !rechecking && (
          <div className="fade-up" style={{
            marginTop: 16, padding: "14px 16px",
            background: "var(--amber-glow)", border: "1px solid var(--amber-border)",
            borderRadius: 8,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", fontWeight: 700, color: "var(--amber)", letterSpacing: "0.08em", textTransform: "uppercase" }}>
                AI Scheduler Summary
              </span>
            </div>
            <p style={{ fontSize: 13, color: "#fbbf24", lineHeight: 1.6 }}>{aiSummary}</p>
            {aiReasoning.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <button
                  onClick={() => setShowReasoning(v => !v)}
                  style={{ fontSize: 11, color: "var(--amber)", background: "none", border: "none", cursor: "pointer", fontFamily: "var(--font-mono)", textDecoration: "underline" }}
                >
                  {showReasoning ? "▲ Hide" : "▼ View"} reasoning ({aiReasoning.length})
                </button>
                {showReasoning && (
                  <div style={{ marginTop: 8, maxHeight: 200, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
                    {aiReasoning.map((r, i) => (
                      <div key={i} style={{ display: "flex", gap: 8, fontSize: 11, fontFamily: "var(--font-mono)" }}>
                        <span style={{ color: r.action === "outsourced" ? "var(--orange)" : "var(--green)", fontWeight: 600, flexShrink: 0 }}>
                          {r.action === "outsourced" ? "⚠" : "✓"}
                        </span>
                        <span style={{ color: "#fbbf24" }}>
                          <span style={{ fontWeight: 600 }}>#{r.bookingId}</span>
                          {r.van && <span style={{ color: "var(--amber)" }}> → {r.van}</span>}
                          {": "}{r.reasoning}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Terminal log */}
        {recheckLogs.length > 0 && (
          <div style={{ marginTop: 16 }} className="fade-up">
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
              <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-muted)", letterSpacing: "0.06em" }}>RECHECK LOG</span>
              <button onClick={() => setRecheckLogs([])} style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }}>clear</button>
            </div>
            <div className="terminal" style={{ height: 224 }}>
              {recheckLogs.map((line, i) => {
                const isStep     = line.startsWith("Step ") || line.startsWith("━━━");
                const isOk       = line.includes("OK ") || line.includes("✓") || line.includes("done") || line.includes("COMPLETE");
                const isConflict = line.includes("CONFLICT") || line.includes("outsourced") || line.includes("❌");
                const isBump     = line.includes("BUMP") || line.includes("displaced") || line.includes("swapped");
                const isEnforce  = line.includes("[enforceInvoice]") || line.includes("[eliminateDoubleBookings]");
                let color = "var(--text-muted)";
                if (isStep)     color = "var(--cyan)";
                else if (isOk)  color = "var(--green)";
                else if (isConflict) color = "var(--red)";
                else if (isBump) color = "var(--amber)";
                else if (isEnforce) color = "var(--purple)";
                return (
                  <div key={i} style={{ color, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{line}</div>
                );
              })}
              {rechecking && <div style={{ color: "var(--text-muted)" }} className="pulse-dot">▋</div>}
              <div ref={logEndRef} />
            </div>
          </div>
        )}
      </section>

      {/* ── Danger Zone ──────────────────────────────────────── */}
      <section style={{ ...S.card, borderColor: "rgba(248,81,73,0.25)" }}>
        <p style={S.sectionHeader}>Danger Zone</p>
        <p style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 14 }}>Irreversible actions. Use with caution.</p>
        {actionMessage && actionMessage !== "" && !rechecking && (
          <div className="alert alert-warn fade-up" style={{ marginBottom: 14 }}>{actionMessage.replace(/^(done:|error:)/, "")}</div>
        )}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          <button
            className="btn btn-danger"
            onClick={() => setShowClearAllModal(true)}
          >
            🗑 Clear All Bookings
          </button>
        </div>
      </section>

      {/* Modals */}
      {showClearAllModal && (
        <Modal
          title="Clear all bookings?"
          body="This will permanently delete ALL booking rows from the database. This cannot be undone."
          confirmLabel="Delete everything"
          confirm={handleClearAll}
          onClose={() => setShowClearAllModal(false)}
          danger
        />
      )}
    </div>
  );
}
