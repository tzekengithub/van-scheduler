"use client";

import { useState, useRef, useEffect, useCallback } from "react";

interface Message {
  role: "user" | "assistant";
  content: string;
}

const QUICK_PROMPTS = [
  "What's happening today?",
  "Any conflicts I need to fix?",
  "Which bookings are unassigned?",
  "What do I need to do manually?",
];

function ActionNeededLine({ text }: { text: string }) {
  return (
    <span style={{
      display: "inline-block", margin: "2px 0",
      padding: "3px 8px", borderRadius: 4,
      background: "var(--amber-glow)", border: "1px solid var(--amber-border)",
      color: "var(--amber)", fontWeight: 700, fontSize: 11,
      fontFamily: "var(--font-mono)",
    }}>
      {text}
    </span>
  );
}

function MessageContent({ content }: { content: string }) {
  const parts = content.split(/(ACTION NEEDED:[^\n]+)/g);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith("ACTION NEEDED:") ? (
          <ActionNeededLine key={i} text={part} />
        ) : (
          <span key={i} style={{ whiteSpace: "pre-wrap" }}>{part}</span>
        ),
      )}
    </>
  );
}

export default function ChatPanel() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [greeted, setGreeted] = useState(false);
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
      const nextMessages = isGreeting ? [] : [...messages, userMessage];
      if (!isGreeting) setMessages(prev => [...prev, userMessage]);
      setStreaming(true);
      setMessages(prev => [...prev, { role: "assistant", content: "" }]);
      abortRef.current = new AbortController();
      try {
        const payload = isGreeting
          ? [{ role: "user", content: "Greet the user briefly and give them a one-line summary of today's schedule status." }]
          : nextMessages.map(m => ({ role: m.role, content: m.content }));
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: payload }),
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
        let buf = "", assistantContent = "";
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
              const delta = chunk.choices?.[0]?.delta?.content ?? "";
              if (delta) {
                assistantContent += delta;
                setMessages(prev => [...prev.slice(0, -1), { role: "assistant", content: assistantContent }]);
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
        abortRef.current = null;
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

  const showQuickPrompts = messages.length === 0 || (messages.length === 1 && messages[0].role === "assistant");

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
            width: 360, maxWidth: "calc(100vw - 32px)",
            height: 500, maxHeight: "calc(100vh - 40px)",
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
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>Schedule Assistant</span>
              <span style={{
                fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 3,
                background: "var(--amber-glow)", border: "1px solid var(--amber-border)",
                color: "var(--amber)", fontFamily: "var(--font-mono)", letterSpacing: "0.08em",
              }}>AI</span>
            </div>
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

          {/* Messages */}
          <div style={{ flex: 1, overflowY: "auto", padding: "14px 14px 6px", display: "flex", flexDirection: "column", gap: 10 }}>
            {messages.length === 0 && !streaming && (
              <p style={{ fontSize: 12, color: "var(--text-muted)", textAlign: "center", padding: "20px 0", fontFamily: "var(--font-mono)" }}>
                Ask anything about the schedule…
              </p>
            )}
            {messages.map((msg, i) => (
              <div key={i} style={{ display: "flex", justifyContent: msg.role === "user" ? "flex-end" : "flex-start" }}>
                <div style={{
                  maxWidth: "88%", borderRadius: 10, padding: "8px 12px",
                  fontSize: 13, lineHeight: 1.55,
                  background: msg.role === "user" ? "var(--amber)" : "var(--bg-elevated)",
                  color: msg.role === "user" ? "var(--text-inverse)" : "var(--text-primary)",
                  border: msg.role === "user" ? "none" : "1px solid var(--border)",
                }}>
                  {msg.role === "assistant" && msg.content === "" && streaming ? (
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
                    <MessageContent content={msg.content} />
                  )}
                </div>
              </div>
            ))}
            {showQuickPrompts && !streaming && (
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
            <form onSubmit={handleSubmit} style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask about the schedule…"
                rows={1}
                disabled={streaming}
                className="input-base"
                style={{
                  flex: 1, resize: "none", padding: "8px 10px",
                  fontSize: 13, lineHeight: 1.4, maxHeight: 80, overflowY: "auto",
                  opacity: streaming ? 0.5 : 1,
                }}
              />
              <button
                type="submit"
                disabled={!input.trim() || streaming}
                style={{
                  width: 34, height: 34, borderRadius: 8, flexShrink: 0,
                  background: input.trim() && !streaming ? "var(--amber)" : "var(--bg-muted)",
                  border: "none", cursor: input.trim() && !streaming ? "pointer" : "not-allowed",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  color: input.trim() && !streaming ? "var(--text-inverse)" : "var(--text-muted)",
                  transition: "all 0.15s",
                }}
              >
                <svg style={{ width: 14, height: 14 }} viewBox="0 0 20 20" fill="currentColor">
                  <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
                </svg>
              </button>
            </form>
            <p style={{ fontSize: 10, color: "var(--text-muted)", textAlign: "center", marginTop: 6, fontFamily: "var(--font-mono)" }}>
              read-only · cannot modify bookings
            </p>
          </div>
        </div>
      )}
    </>
  );
}
