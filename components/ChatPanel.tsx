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
    <span className="inline-block my-0.5 px-2 py-1 rounded bg-amber-100 border border-amber-300 text-amber-900 font-semibold text-xs">
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
          <span key={i} className="whitespace-pre-wrap">
            {part}
          </span>
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

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const sendMessage = useCallback(
    async (userContent: string, isGreeting = false) => {
      if (streaming) return;

      const userMessage: Message = { role: "user", content: userContent };
      const nextMessages = isGreeting ? [] : [...messages, userMessage];
      if (!isGreeting) {
        setMessages((prev) => [...prev, userMessage]);
      }

      setStreaming(true);
      setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

      abortRef.current = new AbortController();

      try {
        const payload = isGreeting
          ? [{ role: "user", content: "Greet the user briefly and give them a one-line summary of today's schedule status." }]
          : nextMessages.map((m) => ({ role: m.role, content: m.content }));

        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: payload }),
          signal: abortRef.current.signal,
        });

        if (!res.ok || !res.body) {
          setMessages((prev) => [
            ...prev.slice(0, -1),
            { role: "assistant", content: "Sorry, I couldn't reach the AI service. Please try again." },
          ]);
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let assistantContent = "";

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
                setMessages((prev) => [
                  ...prev.slice(0, -1),
                  { role: "assistant", content: assistantContent },
                ]);
              }
            } catch {}
          }
        }
      } catch (err: any) {
        if (err?.name !== "AbortError") {
          setMessages((prev) => [
            ...prev.slice(0, -1),
            { role: "assistant", content: "Connection interrupted. Please try again." },
          ]);
        }
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [messages, streaming],
  );

  // Auto-greet on first open
  useEffect(() => {
    if (open && !greeted && !streaming) {
      setGreeted(true);
      sendMessage("", true);
    }
  }, [open, greeted, streaming, sendMessage]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    sendMessage(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e as any);
    }
  };

  const showQuickPrompts = messages.length === 0 || (messages.length === 1 && messages[0].role === "assistant");

  return (
    <>
      {/* Collapsed button */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed bottom-4 left-4 z-40 flex items-center gap-2 px-4 py-2.5 bg-zinc-900 text-white rounded-full shadow-lg hover:bg-zinc-700 transition-colors text-sm font-medium"
          aria-label="Open schedule assistant"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
          </svg>
          Schedule AI
        </button>
      )}

      {/* Expanded panel */}
      {open && (
        <div className="fixed bottom-4 left-4 z-40 flex flex-col bg-white rounded-xl shadow-2xl border border-zinc-200 w-[380px] max-w-[calc(100vw-2rem)] h-[520px] max-h-[calc(100vh-2rem)]">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 bg-zinc-50 border-b border-zinc-200 rounded-t-xl shrink-0">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-green-500" />
              <span className="text-sm font-semibold text-zinc-900">Schedule Assistant</span>
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-200 uppercase tracking-wide">AI</span>
            </div>
            <button
              onClick={() => {
                abortRef.current?.abort();
                setOpen(false);
              }}
              className="text-zinc-400 hover:text-zinc-700 text-xl font-bold leading-none px-1.5 py-0.5 rounded hover:bg-zinc-200 transition-colors"
              aria-label="Close"
            >
              ×
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {messages.length === 0 && !streaming && (
              <p className="text-xs text-zinc-400 text-center py-4">
                Ask anything about the schedule…
              </p>
            )}

            {messages.map((msg, i) => (
              <div
                key={i}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[85%] rounded-xl px-3 py-2 text-sm leading-relaxed ${
                    msg.role === "user"
                      ? "bg-zinc-900 text-white"
                      : "bg-zinc-100 text-zinc-900"
                  }`}
                >
                  {msg.role === "assistant" && msg.content === "" && streaming ? (
                    <span className="flex gap-1 items-center py-0.5">
                      <span className="w-1.5 h-1.5 bg-zinc-400 rounded-full animate-bounce [animation-delay:0ms]" />
                      <span className="w-1.5 h-1.5 bg-zinc-400 rounded-full animate-bounce [animation-delay:150ms]" />
                      <span className="w-1.5 h-1.5 bg-zinc-400 rounded-full animate-bounce [animation-delay:300ms]" />
                    </span>
                  ) : (
                    <MessageContent content={msg.content} />
                  )}
                </div>
              </div>
            ))}

            {/* Quick prompts — shown when chat is empty or only has the greeting */}
            {showQuickPrompts && !streaming && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {QUICK_PROMPTS.map((prompt) => (
                  <button
                    key={prompt}
                    onClick={() => sendMessage(prompt)}
                    className="text-xs px-2.5 py-1.5 rounded-full border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50 hover:border-zinc-400 transition-colors"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="shrink-0 p-3 border-t border-zinc-200">
            <form onSubmit={handleSubmit} className="flex gap-2 items-end">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask about the schedule…"
                rows={1}
                disabled={streaming}
                className="flex-1 resize-none rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-400 disabled:opacity-50 max-h-24 overflow-y-auto"
                style={{ lineHeight: "1.4" }}
              />
              <button
                type="submit"
                disabled={!input.trim() || streaming}
                className="h-9 w-9 rounded-lg bg-zinc-900 text-white flex items-center justify-center hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
                aria-label="Send"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
                </svg>
              </button>
            </form>
            <p className="text-[10px] text-zinc-400 mt-1 text-center">
              Read-only — cannot modify bookings directly
            </p>
          </div>
        </div>
      )}
    </>
  );
}
