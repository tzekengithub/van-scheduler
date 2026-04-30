"use client";

import { useState, useRef, useEffect, useCallback } from "react";

interface Message {
  role: "user" | "assistant";
  content: string;
  actions?: Array<{ tool: string; args: Record<string, unknown>; result: string }>;
}

const QUICK_PROMPTS = [
  "What's happening today?",
  "Any conflicts I need to fix?",
  "Which bookings are unassigned?",
  "Show me all unpaid bookings",
  "List all vans and drivers",
  "What scheduling rules do we have?",
];

const TOOL_LABELS: Record<string, { icon: string; label: string }> = {
  assign_van:              { icon: "🚐", label: "Assigned van" },
  set_outsource:           { icon: "🔄", label: "Outsourced" },
  set_inhouse:             { icon: "🏠", label: "Set in-house" },
  edit_booking:            { icon: "✏️", label: "Updated booking" },
  delete_booking:          { icon: "🗑️", label: "Deleted booking" },
  mark_paid:               { icon: "💰", label: "Updated payment" },
  allow_double_book:       { icon: "✅", label: "Allowed double-booking" },
  edit_van:                { icon: "🔧", label: "Updated van" },
  save_scheduling_rule:    { icon: "📌", label: "Saved rule" },
  delete_scheduling_rule:  { icon: "🗑️", label: "Deleted rule" },
  trigger_recheck:         { icon: "🤖", label: "AI recheck" },
  trigger_rules_recheck:   { icon: "⚙️", label: "Rules recheck" },
  list_scheduling_rules:   { icon: "📋", label: "Listed rules" },
  get_booking:             { icon: "🔍", label: "Fetched booking" },
  list_vans:               { icon: "📋", label: "Listed vans" },
};

function ActionChip({ tool, result }: { tool: string; result: string }) {
  const [expanded, setExpanded] = useState(false);
  const meta = TOOL_LABELS[tool] ?? { icon: "⚡", label: tool };
  const isError = result.startsWith("Error");
  return (
    <div
      style={{
        marginTop: 4,
        borderRadius: 6,
        border: `1px solid ${isError ? "rgba(248,81,73,0.3)" : "rgba(63,185,80,0.25)"}`,
        background: isError ? "rgba(248,81,73,0.08)" : "rgba(63,185,80,0.06)",
        overflow: "hidden",
      }}
    >
      <button
        onClick={() => setExpanded(e => !e)}
        style={{
          width: "100%", display: "flex", alignItems: "center", gap: 6,
          padding: "4px 8px", background: "none", border: "none", cursor: "pointer",
          color: isError ? "var(--red)" : "var(--green)",
          fontSize: 11, fontWeight: 600, textAlign: "left",
        }}
      >
        <span>{meta.icon}</span>
        <span style={{ flex: 1 }}>{meta.label}</span>
        <span style={{ fontSize: 9, opacity: 0.6 }}>{expanded ? "▲" : "▼"}</span>
      </button>
      {expanded && (
        <div style={{
          padding: "4px 8px 6px",
          fontSize: 10, color: "var(--text-muted)",
          fontFamily: "var(--font-mono)",
          borderTop: "1px solid rgba(255,255,255,0.06)",
          whiteSpace: "pre-wrap", wordBreak: "break-word",
        }}>
          {result}
        </div>
      )}
    </div>
  );
}

function MessageContent({ content }: { content: string }) {
  // Bold **text**, inline code `text`, and line breaks
  const lines = content.split("\n");
  return (
    <>
      {lines.map((line, li) => {
        const parts = line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
        return (
          <span key={li}>
            {parts.map((part, pi) => {
              if (part.startsWith("**") && part.endsWith("**")) {
                return <strong key={pi}>{part.slice(2, -2)}</strong>;
              }
              if (part.startsWith("`") && part.endsWith("`")) {
                return (
                  <code key={pi} style={{
                    fontFamily: "var(--font-mono)", fontSize: "0.9em",
                    background: "rgba(255,255,255,0.08)", padding: "1px 4px", borderRadius: 3,
                  }}>{part.slice(1, -1)}</code>
                );
              }
              return <span key={pi}>{part}</span>;
            })}
            {li < lines.length - 1 && <br />}
          </span>
        );
      })}
    </>
  );
}

export default function ChatPanel() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [greeted, setGreeted] = useState(false);
  const [activeToolName, setActiveToolName] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => { scrollToBottom(); }, [messages, scrollToBottom]);

  const sendMessage = useCallback(
    async (userContent: string, isGreeting = false) => {
      if (streaming) return;

      const userMessage: Message = { role: "user", content: userContent };
      const nextMessages: Message[] = isGreeting ? [] : [...messages, userMessage];
      if (!isGreeting) setMessages(prev => [...prev, userMessage]);
      setStreaming(true);
      setActiveToolName(null);
      setMessages(prev => [...prev, { role: "assistant", content: "" }]);
      abortRef.current = new AbortController();

      try {
        const isFirst = messages.length === 0 || isGreeting;
        const payload = isGreeting
          ? [{ role: "user", content: "Greet the user briefly and give them a one-line summary of today's schedule status. Mention you can make changes for them." }]
          : nextMessages.map(m => ({ role: m.role, content: m.content }));

        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: payload, includeContext: isFirst }),
          signal: abortRef.current.signal,
        });

        if (!res.ok || !res.body) {
          let errMsg = "Sorry, couldn't reach the AI service.";
          try { const d = await res.json(); if (d?.error) errMsg = `AI error: ${d.error}`; } catch {}
          setMessages(prev => [...prev.slice(0, -1), { role: "assistant", content: errMsg }]);
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let assistantContent = "";
        let pendingActions: Array<{ tool: string; args: Record<string, unknown>; result: string }> = [];

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";

          for (const part of parts) {
            if (!part.startsWith("data: ")) continue;
            const raw = part.slice(6).trim();
            if (raw === "[DONE]") break;
            try {
              const chunk = JSON.parse(raw);

              if (chunk.type === "tool_start") {
                setActiveToolName(chunk.tool as string);
              }

              if (chunk.type === "tool_done") {
                setActiveToolName(null);
                pendingActions.push({
                  tool: chunk.tool as string,
                  args: (chunk.args ?? {}) as Record<string, unknown>,
                  result: chunk.result as string,
                });
                // Update the last assistant message with latest actions
                setMessages(prev => {
                  const updated = [...prev];
                  const last = updated[updated.length - 1];
                  if (last?.role === "assistant") {
                    updated[updated.length - 1] = { ...last, actions: [...pendingActions] };
                  }
                  return updated;
                });
              }

              if (chunk.type === "actions") {
                pendingActions = (chunk.actions as typeof pendingActions) ?? pendingActions;
              }

              const delta = chunk.choices?.[0]?.delta?.content ?? "";
              if (delta) {
                assistantContent += delta;
                setMessages(prev => {
                  const updated = [...prev];
                  const last = updated[updated.length - 1];
                  if (last?.role === "assistant") {
                    updated[updated.length - 1] = { ...last, content: assistantContent, actions: pendingActions.length ? pendingActions : last.actions };
                  }
                  return updated;
                });
              }
            } catch {}
          }
        }
      } catch (err: unknown) {
        if (!(err instanceof Error) || err.name !== "AbortError") {
          setMessages(prev => [...prev.slice(0, -1), { role: "assistant", content: "Connection interrupted." }]);
        }
      } finally {
        setStreaming(false);
        setActiveToolName(null);
        abortRef.current = null;
        setTimeout(() => inputRef.current?.focus(), 50);
      }
    },
    [messages, streaming],
  );

  useEffect(() => {
    if (open && !greeted && !streaming) { setGreeted(true); sendMessage("", true); }
  }, [open, greeted, streaming, sendMessage]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    sendMessage(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(e as unknown as React.FormEvent); }
  };

  const showQuickPrompts = messages.length <= 1 && !streaming;

  return (
    <>
      {/* Trigger button */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          style={{
            position: "fixed", bottom: 20, left: 20, zIndex: 40,
            display: "flex", alignItems: "center", gap: 8,
            padding: "9px 16px",
            background: "var(--bg-elevated)",
            border: "1px solid var(--border)",
            borderRadius: 999,
            color: "var(--text-primary)",
            fontSize: 13, fontWeight: 500,
            cursor: "pointer",
            boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
            transition: "all 0.2s",
          }}
          onMouseEnter={e => {
            (e.currentTarget as HTMLElement).style.borderColor = "var(--amber-border)";
            (e.currentTarget as HTMLElement).style.boxShadow = "0 8px 32px rgba(0,0,0,0.4), 0 0 0 1px var(--amber-border)";
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLElement).style.borderColor = "var(--border)";
            (e.currentTarget as HTMLElement).style.boxShadow = "0 8px 32px rgba(0,0,0,0.4)";
          }}
        >
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--amber)", boxShadow: "0 0 6px var(--amber)", flexShrink: 0 }} className="pulse-dot" />
          <span>Schedule AI</span>
        </button>
      )}

      {/* Panel */}
      {open && (
        <div
          className="fade-up"
          style={{
            position: "fixed", bottom: 20, left: 20, zIndex: 40,
            display: "flex", flexDirection: "column",
            width: 420, maxWidth: "calc(100vw - 32px)",
            height: 620, maxHeight: "calc(100vh - 40px)",
            background: "var(--bg-surface)",
            border: "1px solid var(--border)",
            borderRadius: 14,
            boxShadow: "0 24px 64px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04)",
            overflow: "hidden",
          }}
        >
          {/* Header */}
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "12px 16px",
            background: "var(--bg-elevated)",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--green)", boxShadow: "0 0 6px var(--green)", display: "inline-block" }} className="pulse-dot" />
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>Operations Assistant</span>
              <span style={{
                fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 3,
                background: "var(--amber-glow)", border: "1px solid var(--amber-border)",
                color: "var(--amber)", fontFamily: "var(--font-mono)", letterSpacing: "0.08em",
              }}>AI</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {messages.length > 0 && (
                <button
                  onClick={() => { setMessages([]); setGreeted(false); }}
                  style={{
                    background: "none", border: "none", cursor: "pointer",
                    color: "var(--text-muted)", fontSize: 11, padding: "2px 6px", borderRadius: 4,
                  }}
                  title="Clear chat"
                  onMouseEnter={e => (e.currentTarget.style.color = "var(--text-primary)")}
                  onMouseLeave={e => (e.currentTarget.style.color = "var(--text-muted)")}
                >
                  Clear
                </button>
              )}
              <button
                onClick={() => { abortRef.current?.abort(); setOpen(false); }}
                style={{
                  background: "none", border: "none", cursor: "pointer",
                  color: "var(--text-muted)", fontSize: 18, lineHeight: 1,
                  padding: "2px 6px", borderRadius: 4,
                }}
                onMouseEnter={e => (e.currentTarget.style.color = "var(--text-primary)")}
                onMouseLeave={e => (e.currentTarget.style.color = "var(--text-muted)")}
              >×</button>
            </div>
          </div>

          {/* Messages */}
          <div style={{ flex: 1, overflowY: "auto", padding: "14px 14px 6px", display: "flex", flexDirection: "column", gap: 10 }}>
            {messages.length === 0 && !streaming && (
              <p style={{ fontSize: 12, color: "var(--text-muted)", textAlign: "center", padding: "20px 0", fontFamily: "var(--font-mono)" }}>
                Ask anything — I can read and make changes for you.
              </p>
            )}

            {messages.map((msg, i) => (
              <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: msg.role === "user" ? "flex-end" : "flex-start" }}>
                <div style={{
                  maxWidth: "92%", borderRadius: 10, padding: "8px 12px",
                  fontSize: 13, lineHeight: 1.55,
                  background: msg.role === "user" ? "var(--amber)" : "var(--bg-elevated)",
                  color: msg.role === "user" ? "var(--text-inverse)" : "var(--text-primary)",
                  border: msg.role === "user" ? "none" : "1px solid var(--border)",
                }}>
                  {msg.role === "assistant" && msg.content === "" && streaming && !activeToolName ? (
                    <span style={{ display: "flex", gap: 4, alignItems: "center", padding: "2px 0" }}>
                      {[0, 150, 300].map(d => (
                        <span key={d} style={{
                          width: 5, height: 5, borderRadius: "50%", background: "var(--text-muted)",
                          display: "inline-block",
                          animation: `pulse-dot 1s ease-in-out ${d}ms infinite`,
                        }} />
                      ))}
                    </span>
                  ) : (
                    <>
                      {/* Tool action chips */}
                      {msg.actions && msg.actions.length > 0 && (
                        <div style={{ marginBottom: msg.content ? 8 : 0, display: "flex", flexDirection: "column", gap: 3 }}>
                          {msg.actions.map((a, ai) => (
                            <ActionChip key={ai} tool={a.tool} result={a.result} />
                          ))}
                        </div>
                      )}
                      {/* Streaming tool indicator */}
                      {msg.content === "" && streaming && activeToolName && (
                        <div style={{
                          display: "flex", alignItems: "center", gap: 6,
                          fontSize: 11, color: "var(--amber)",
                          fontFamily: "var(--font-mono)",
                        }}>
                          <span style={{
                            width: 5, height: 5, borderRadius: "50%", background: "var(--amber)",
                            display: "inline-block",
                            animation: "pulse-dot 1s ease-in-out infinite",
                          }} />
                          {TOOL_LABELS[activeToolName]?.icon ?? "⚡"} {TOOL_LABELS[activeToolName]?.label ?? activeToolName}…
                        </div>
                      )}
                      {msg.content && <MessageContent content={msg.content} />}
                    </>
                  )}
                </div>
              </div>
            ))}

            {/* Quick prompts */}
            {showQuickPrompts && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, paddingTop: 4 }}>
                {QUICK_PROMPTS.map(prompt => (
                  <button
                    key={prompt}
                    onClick={() => sendMessage(prompt)}
                    style={{
                      fontSize: 11, padding: "5px 10px", borderRadius: 6,
                      background: "var(--bg-muted)", border: "1px solid var(--border)",
                      color: "var(--text-secondary)", cursor: "pointer",
                      transition: "all 0.15s",
                    }}
                    onMouseEnter={e => {
                      (e.currentTarget as HTMLElement).style.borderColor = "var(--amber-border)";
                      (e.currentTarget as HTMLElement).style.color = "var(--text-primary)";
                    }}
                    onMouseLeave={e => {
                      (e.currentTarget as HTMLElement).style.borderColor = "var(--border)";
                      (e.currentTarget as HTMLElement).style.color = "var(--text-secondary)";
                    }}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div style={{ flexShrink: 0, padding: 12, borderTop: "1px solid var(--border)", background: "var(--bg-elevated)" }}>
            {streaming && activeToolName && (
              <div style={{
                marginBottom: 8, fontSize: 11, color: "var(--amber)",
                fontFamily: "var(--font-mono)", display: "flex", alignItems: "center", gap: 5,
              }}>
                <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--amber)", display: "inline-block", animation: "pulse-dot 1s ease-in-out infinite" }} />
                {TOOL_LABELS[activeToolName]?.icon} {TOOL_LABELS[activeToolName]?.label ?? activeToolName}…
              </div>
            )}
            <form onSubmit={handleSubmit} style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={streaming ? "Working…" : "Ask or give instructions…"}
                rows={1}
                disabled={streaming}
                className="input-base"
                style={{
                  flex: 1, resize: "none", padding: "8px 10px",
                  fontSize: 13, lineHeight: 1.4, maxHeight: 80, overflowY: "auto",
                  opacity: streaming ? 0.5 : 1,
                }}
              />
              {streaming ? (
                <button
                  type="button"
                  onClick={() => abortRef.current?.abort()}
                  style={{
                    width: 34, height: 34, borderRadius: 8, flexShrink: 0,
                    background: "rgba(248,81,73,0.15)", border: "1px solid rgba(248,81,73,0.3)",
                    cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                    color: "var(--red)", fontSize: 14,
                  }}
                  title="Stop"
                >■</button>
              ) : (
                <button
                  type="submit"
                  disabled={!input.trim()}
                  style={{
                    width: 34, height: 34, borderRadius: 8, flexShrink: 0,
                    background: input.trim() ? "var(--amber)" : "var(--bg-muted)",
                    border: "none", cursor: input.trim() ? "pointer" : "not-allowed",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    color: input.trim() ? "var(--text-inverse)" : "var(--text-muted)",
                    transition: "all 0.15s",
                  }}
                >
                  <svg style={{ width: 14, height: 14 }} viewBox="0 0 20 20" fill="currentColor">
                    <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
                  </svg>
                </button>
              )}
            </form>
          </div>
        </div>
      )}
    </>
  );
}
