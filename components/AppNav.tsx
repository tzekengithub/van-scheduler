"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_LINKS = [
  { href: "/",             label: "Fleet",    icon: "◈" },
  { href: "/daily-jobs",   label: "Daily",    icon: "◷" },
  { href: "/all-jobs",     label: "All Jobs", icon: "≡" },
  { href: "/van-schedule", label: "Schedule", icon: "⊞" },
];

export default function AppNav() {
  const pathname = usePathname();

  return (
    <header
      style={{
        background: "var(--bg-surface)",
        borderBottom: "1px solid var(--border)",
        position: "sticky",
        top: 0,
        zIndex: 30,
      }}
    >
      <div
        style={{
          maxWidth: 1200,
          margin: "0 auto",
          padding: "0 24px",
          height: 52,
          display: "flex",
          alignItems: "center",
          gap: 32,
        }}
      >
        {/* Wordmark */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          <div
            style={{
              width: 28,
              height: 28,
              background: "var(--amber)",
              borderRadius: 6,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 14,
              color: "var(--text-inverse)",
              fontWeight: 800,
              fontFamily: "var(--font-display)",
              letterSpacing: "-0.02em",
            }}
          >
            VS
          </div>
          <span
            style={{
              fontFamily: "var(--font-display)",
              fontWeight: 700,
              fontSize: 15,
              color: "var(--text-primary)",
              letterSpacing: "-0.01em",
            }}
          >
            VanScheduler
          </span>
        </div>

        {/* Nav links */}
        <nav style={{ display: "flex", gap: 2, flex: 1 }}>
          {NAV_LINKS.map(({ href, label, icon }) => {
            const active = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "6px 12px",
                  borderRadius: 6,
                  fontSize: 13,
                  fontWeight: active ? 600 : 400,
                  color: active ? "var(--amber)" : "var(--text-secondary)",
                  background: active ? "var(--amber-glow)" : "transparent",
                  border: active ? "1px solid var(--amber-border)" : "1px solid transparent",
                  textDecoration: "none",
                  transition: "all 0.15s",
                }}
                onMouseEnter={(e) => {
                  if (!active) {
                    (e.currentTarget as HTMLElement).style.color = "var(--text-primary)";
                    (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)";
                  }
                }}
                onMouseLeave={(e) => {
                  if (!active) {
                    (e.currentTarget as HTMLElement).style.color = "var(--text-secondary)";
                    (e.currentTarget as HTMLElement).style.background = "transparent";
                  }
                }}
              >
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, opacity: 0.7 }}>{icon}</span>
                {label}
              </Link>
            );
          })}
        </nav>

        {/* Right: status indicator */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            color: "var(--text-muted)",
          }}
        >
          <span className="dot dot-green pulse-dot" />
          <span>live</span>
        </div>
      </div>
    </header>
  );
}
