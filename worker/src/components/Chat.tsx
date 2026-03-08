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
    <>
      <style>{`
        .chat-root {
          display: flex;
          flex-direction: column;
          height: 100vh;
          max-height: 100dvh;
          position: relative;
        }

        /* ── Messages scroll area ── */
        .chat-messages {
          flex: 1;
          overflow-y: auto;
          padding: 1.5rem 0;
          scrollbar-gutter: stable both-edges;
        }

        /* ── Message row ── */
        .msg-row {
          width: 100%;
          max-width: 48rem;
          margin: 0 auto;
          padding: 0 1.5rem;
          animation: fadeIn 0.3s ease;
        }

        /* ── User message ── */
        .msg-user-wrap {
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          margin: 0.5rem 0;
          gap: 0.5rem;
        }
        .msg-user-bubble {
          max-width: 80%;
          background: var(--accent);
          color: var(--accent-foreground);
          padding: 0.75rem 1rem;
          border-radius: 1rem;
          box-shadow: inset 0 0 0 1px var(--input);
          font-size: 0.875rem;
          line-height: 1.5;
          white-space: pre-wrap;
          word-break: break-word;
        }

        /* ── Assistant message ── */
        .msg-assistant-wrap {
          display: flex;
          flex-direction: column;
          gap: 1rem;
          padding: 0.5rem;
          margin: 0.25rem 0;
        }
        .msg-assistant-text {
          font-size: 0.875rem;
          line-height: 1.625;
          white-space: pre-wrap;
          word-break: break-word;
          color: var(--foreground);
        }

        /* ── Greeting / empty state ── */
        .greeting-wrap {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          height: 100%;
          animation: fadeIn 0.6s ease;
        }
        .greeting-inner {
          max-width: 48rem;
          margin: 0 auto;
          padding: 1.5rem;
          text-align: center;
        }
        .greeting-title {
          font-size: 1.5rem;
          font-weight: 400;
          color: var(--foreground);
          margin-bottom: 0.75rem;
          line-height: 1.3;
        }
        @media (min-width: 768px) {
          .greeting-title { font-size: 1.875rem; }
        }
        .greeting-subtitle {
          font-size: 0.875rem;
          color: var(--muted-foreground);
          margin-bottom: 1.5rem;
        }
        .greeting-suggestions {
          display: flex;
          flex-wrap: wrap;
          gap: 0.5rem;
          justify-content: center;
        }
        .greeting-chip {
          background: var(--secondary);
          color: var(--secondary-foreground);
          border: 1px solid var(--border);
          border-radius: 9999px;
          padding: 0.5rem 1rem;
          font-size: 0.8125rem;
          cursor: pointer;
          transition: background 0.15s, border-color 0.15s;
          font-family: inherit;
        }
        .greeting-chip:hover {
          background: var(--muted);
          border-color: var(--input);
        }

        /* ── Input area ── */
        .input-area {
          width: 100%;
          max-width: 48rem;
          margin: 0 auto;
          padding: 0 1rem 1rem;
          animation: fadeIn 0.5s ease;
        }
        .input-box {
          position: relative;
          display: flex;
          flex-direction: column;
          width: 100%;
          background: color-mix(in oklch, var(--muted) 60%, transparent);
          border-radius: 2rem;
          box-shadow: 0 4px 20px rgba(0,0,0,0.2), 0 1px 4px rgba(0,0,0,0.15);
          backdrop-filter: blur(4px);
          transition: background 0.2s, box-shadow 0.2s;
          overflow: hidden;
          cursor: text;
        }
        .input-box:hover,
        .input-box:focus-within {
          background: var(--muted);
        }
        .input-editor {
          display: flex;
          flex-direction: column;
          gap: 0.875rem;
          padding: 0.5rem 1.25rem 1rem;
        }
        .input-textarea {
          flex: 1;
          background: transparent;
          border: none;
          outline: none;
          color: var(--foreground);
          font-size: 0.875rem;
          font-family: inherit;
          resize: none;
          line-height: 1.5;
          min-height: 2rem;
          max-height: 10rem;
        }
        .input-textarea::placeholder {
          color: var(--muted-foreground);
        }
        .input-actions {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          padding: 0 0.75rem 0.5rem;
        }
        .send-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 2rem;
          height: 2rem;
          border-radius: 9999px;
          border: none;
          background: var(--secondary);
          color: var(--secondary-foreground);
          cursor: pointer;
          transition: background 0.2s, opacity 0.15s;
          flex-shrink: 0;
        }
        .send-btn:hover:not(:disabled) {
          background: var(--accent-foreground);
          color: var(--accent);
        }
        .send-btn:disabled {
          opacity: 0.35;
          cursor: default;
        }
        .input-footer {
          text-align: center;
          font-size: 0.6875rem;
          color: var(--muted-foreground);
          padding: 0.5rem 0 0;
          opacity: 0.6;
        }

        /* ── Typing indicator ── */
        .typing-dots { display: inline-flex; gap: 4px; align-items: center; padding: 4px 0; }
        .typing-dots span {
          width: 6px; height: 6px; border-radius: 50%;
          background: var(--muted-foreground);
          animation: typingBounce 1.2s infinite;
        }
        .typing-dots span:nth-child(2) { animation-delay: 0.15s; }
        .typing-dots span:nth-child(3) { animation-delay: 0.3s; }
        @keyframes typingBounce {
          0%, 60%, 100% { opacity: 0.3; transform: translateY(0); }
          30% { opacity: 1; transform: translateY(-3px); }
        }
      `}</style>

      <div className="chat-root">
        {/* Messages */}
        <div ref={scrollRef} className="chat-messages">
          {messages.length === 0 ? (
            <Greeting
              onSuggest={(text) => {
                setInput(text);
                setTimeout(() => inputRef.current?.focus(), 0);
              }}
            />
          ) : (
            messages.map((msg, i) => (
              <div key={i} className="msg-row">
                {msg.role === "user" ? (
                  <div className="msg-user-wrap">
                    <div className="msg-user-bubble">{msg.content}</div>
                  </div>
                ) : (
                  <div className="msg-assistant-wrap">
                    <div className="msg-assistant-text">
                      {msg.content ||
                        (isStreaming && i === messages.length - 1 ? (
                          <span className="typing-dots">
                            <span />
                            <span />
                            <span />
                          </span>
                        ) : (
                          ""
                        ))}
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* Input */}
        <div className="input-area">
          <div
            className="input-box"
            onClick={() => inputRef.current?.focus()}
          >
            <div className="input-editor">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask anything…"
                rows={1}
                className="input-textarea"
                disabled={isStreaming}
              />
            </div>
            <div className="input-actions">
              <button
                onClick={sendMessage}
                disabled={!input.trim() || isStreaming}
                className="send-btn"
                aria-label="Send message"
              >
                {isStreaming ? <Spinner /> : <ArrowUpIcon />}
              </button>
            </div>
          </div>
          <p className="input-footer">
            Powered by Honi Agent · Workers AI · Cloudflare Edge
          </p>
        </div>
      </div>
    </>
  );
}

/* ── Sub-components ── */

function Greeting({ onSuggest }: { onSuggest: (text: string) => void }) {
  const greetings = [
    "What can I help with?",
    "Good to see you again.",
    "What are you working on today?",
  ];
  const greeting = greetings[Math.floor(Math.random() * greetings.length)];

  return (
    <div className="greeting-wrap">
      <div className="greeting-inner">
        <h1 className="greeting-title">{greeting}</h1>
        <p className="greeting-subtitle">
          Chat with a Honi agent running on Cloudflare Workers AI
        </p>
        <div className="greeting-suggestions">
          {[
            "What can you do?",
            "What time is it?",
            "Calculate 42 * 17",
          ].map((s) => (
            <button
              key={s}
              className="greeting-chip"
              onClick={() => onSuggest(s)}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ArrowUpIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <circle cx="12" cy="12" r="10" opacity="0.2" />
      <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round">
        <animateTransform
          attributeName="transform"
          type="rotate"
          from="0 12 12"
          to="360 12 12"
          dur="0.75s"
          repeatCount="indefinite"
        />
      </path>
    </svg>
  );
}
