import { useState, useRef, useEffect, useCallback } from "react";

interface Message {
  role: "user" | "assistant";
  content: string;
}

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || isStreaming) return;

    const userMsg: Message = { role: "user", content: text };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsStreaming(true);

    const assistantMsg: Message = { role: "assistant", content: "" };
    setMessages((prev) => [...prev, assistantMsg]);

    try {
      const res = await fetch("/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({ message: text }),
      });

      if (!res.ok) {
        const errText = await res.text();
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            role: "assistant",
            content: `Error: ${res.status} — ${errText}`,
          };
          return updated;
        });
        setIsStreaming(false);
        return;
      }

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            role: "assistant",
            content: "No response stream available.",
          };
          return updated;
        });
        setIsStreaming(false);
        return;
      }

      let accumulated = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") continue;

          try {
            const parsed = JSON.parse(data);
            if (parsed.type === "text" && parsed.text) {
              accumulated += parsed.text;
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = {
                  role: "assistant",
                  content: accumulated,
                };
                return updated;
              });
            }
          } catch {
            /* skip malformed SSE chunks */
          }
        }
      }

      if (!accumulated) {
        /* Fallback: treat the entire response body as plain text */
        const text = await res.clone().text();
        if (text) {
          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = {
              role: "assistant",
              content: text,
            };
            return updated;
          });
        }
      }
    } catch (err) {
      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          role: "assistant",
          content: `Connection error: ${err instanceof Error ? err.message : String(err)}`,
        };
        return updated;
      });
    } finally {
      setIsStreaming(false);
    }
  }, [input, isStreaming]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div style={styles.container}>
      {/* Header */}
      <header style={styles.header}>
        <div style={styles.headerInner}>
          <div style={styles.logoRow}>
            <CloudflareLogo />
            <div>
              <h1 style={styles.title}>Better Chatbot</h1>
              <p style={styles.subtitle}>
                Powered by Honi Agent &middot; Workers AI &middot; Cloudflare
                Edge
              </p>
            </div>
          </div>
          <span style={styles.badge}>⚡ Workers</span>
        </div>
      </header>

      {/* Messages */}
      <div ref={scrollRef} style={styles.messages}>
        {messages.length === 0 && (
          <EmptyState
            onSuggest={(text) => {
              setInput(text);
              setTimeout(() => inputRef.current?.focus(), 0);
            }}
          />
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            style={{
              ...styles.messageRow,
              justifyContent:
                msg.role === "user" ? "flex-end" : "flex-start",
            }}
          >
            <div
              style={{
                ...styles.bubble,
                ...(msg.role === "user"
                  ? styles.userBubble
                  : styles.agentBubble),
              }}
            >
              {msg.role === "assistant" && (
                <span style={styles.roleLabel}>AI</span>
              )}
              <span style={styles.messageText}>
                {msg.content || (isStreaming && i === messages.length - 1 ? "…" : "")}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Input */}
      <div style={styles.inputArea}>
        <div style={styles.inputContainer}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Send a message…"
            rows={1}
            style={styles.textarea}
            disabled={isStreaming}
          />
          <button
            onClick={sendMessage}
            disabled={!input.trim() || isStreaming}
            style={{
              ...styles.sendBtn,
              opacity: !input.trim() || isStreaming ? 0.4 : 1,
            }}
            aria-label="Send message"
          >
            {isStreaming ? <Spinner /> : <SendIcon />}
          </button>
        </div>
        <p style={styles.footer}>
          Running on Cloudflare Workers with zero cold starts
        </p>
      </div>
    </div>
  );
}

/* ── Sub-components ── */

function EmptyState({ onSuggest }: { onSuggest: (text: string) => void }) {
  return (
    <div style={styles.empty}>
      <CloudflareLogo size={48} />
      <h2 style={styles.emptyTitle}>Welcome to Better Chatbot</h2>
      <p style={styles.emptyDesc}>
        This chat is powered by a{" "}
        <strong style={{ color: "#f6821f" }}>Honi agent</strong> running on
        Cloudflare Workers with Workers AI. Try asking anything!
      </p>
      <div style={styles.suggestions}>
        {[
          "What can you do?",
          "What time is it?",
          "Calculate 42 * 17",
        ].map((s) => (
          <button key={s} style={styles.suggestion} onClick={() => onSuggest(s)}>
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function CloudflareLogo({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="32" cy="32" r="30" fill="#f6821f" />
      <text
        x="32"
        y="42"
        textAnchor="middle"
        fill="white"
        fontSize="28"
        fontWeight="bold"
        fontFamily="sans-serif"
      >
        ⚡
      </text>
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" opacity="0.25" />
      <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round">
        <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.8s" repeatCount="indefinite" />
      </path>
    </svg>
  );
}

/* ── Inline styles ── */

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    maxHeight: "100dvh",
    background: "#0a0a0f",
  },

  /* Header */
  header: {
    borderBottom: "1px solid #2a2a45",
    background: "rgba(10,10,15,0.85)",
    backdropFilter: "blur(12px)",
    padding: "12px 20px",
    flexShrink: 0,
  },
  headerInner: {
    maxWidth: 800,
    margin: "0 auto",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  logoRow: { display: "flex", alignItems: "center", gap: 12 },
  title: { fontSize: 18, fontWeight: 700, color: "#e4e4f0" },
  subtitle: { fontSize: 12, color: "#8888a8", marginTop: 2 },
  badge: {
    fontSize: 11,
    fontWeight: 600,
    color: "#f6821f",
    background: "rgba(246,130,31,0.12)",
    padding: "4px 10px",
    borderRadius: 20,
    border: "1px solid rgba(246,130,31,0.25)",
  },

  /* Messages */
  messages: {
    flex: 1,
    overflowY: "auto",
    padding: "24px 20px",
    maxWidth: 800,
    margin: "0 auto",
    width: "100%",
  },
  messageRow: { display: "flex", marginBottom: 12 },
  bubble: {
    maxWidth: "80%",
    padding: "10px 16px",
    borderRadius: 12,
    lineHeight: 1.55,
    fontSize: 14,
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-word" as const,
  },
  userBubble: {
    background: "#2d2d50",
    color: "#e4e4f0",
    borderBottomRightRadius: 4,
  },
  agentBubble: {
    background: "#1a1a30",
    color: "#e4e4f0",
    border: "1px solid #2a2a45",
    borderBottomLeftRadius: 4,
  },
  roleLabel: {
    display: "inline-block",
    fontSize: 10,
    fontWeight: 700,
    color: "#f6821f",
    textTransform: "uppercase" as const,
    marginBottom: 4,
    letterSpacing: 0.5,
  },
  messageText: { display: "block" },

  /* Empty */
  empty: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    gap: 16,
    textAlign: "center" as const,
    padding: 24,
  },
  emptyTitle: { fontSize: 22, fontWeight: 700 },
  emptyDesc: { fontSize: 14, color: "#8888a8", maxWidth: 420 },
  suggestions: {
    display: "flex",
    flexWrap: "wrap" as const,
    gap: 8,
    marginTop: 8,
    justifyContent: "center",
  },
  suggestion: {
    background: "#22223a",
    color: "#e4e4f0",
    border: "1px solid #2a2a45",
    borderRadius: 20,
    padding: "8px 16px",
    fontSize: 13,
    cursor: "pointer",
  },

  /* Input */
  inputArea: {
    borderTop: "1px solid #2a2a45",
    background: "rgba(10,10,15,0.9)",
    backdropFilter: "blur(12px)",
    padding: "12px 20px",
    flexShrink: 0,
  },
  inputContainer: {
    maxWidth: 800,
    margin: "0 auto",
    display: "flex",
    alignItems: "flex-end",
    gap: 8,
    background: "#12121a",
    border: "1px solid #2a2a45",
    borderRadius: 12,
    padding: "8px 12px",
  },
  textarea: {
    flex: 1,
    background: "transparent",
    border: "none",
    outline: "none",
    color: "#e4e4f0",
    fontSize: 14,
    fontFamily: "inherit",
    resize: "none" as const,
    lineHeight: 1.5,
    maxHeight: 120,
  },
  sendBtn: {
    background: "#f6821f",
    color: "white",
    border: "none",
    borderRadius: 8,
    width: 36,
    height: 36,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    flexShrink: 0,
    transition: "opacity 0.15s",
  },
  footer: {
    textAlign: "center" as const,
    fontSize: 11,
    color: "#555570",
    marginTop: 8,
  },
};
