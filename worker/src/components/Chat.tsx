/**
 * Chat UI — React island component for the Astro frontend.
 *
 * Layout: sidebar (thread list) + main chat area.
 *
 * Thread flow:
 * - On mount: fetch GET /threads to populate the sidebar.
 * - "New chat": clears messages and currentThreadId. Next send creates a
 *   fresh thread on the backend (no x-thread-id header sent).
 * - After the first message of a new thread: the backend returns the new
 *   UUID in the `x-thread-id` response header. The frontend stores this
 *   and uses it for subsequent messages in the same session.
 * - Clicking a thread in the sidebar: loads messages from GET /threads/:id.
 *
 * @module Chat
 */

import { useState, useRef, useEffect, useCallback } from "react";

/* ── Types ── */

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface Thread {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  category: string;
  supportsStreaming: boolean;
}

interface ProviderGroup {
  provider: string;
  slug: string;
  models: ModelInfo[];
}

/* ── Constants ── */

const DEFAULT_MODEL = "@cf/meta/llama-3.1-8b-instruct";

/* ── Main component ── */

export default function Chat() {
  /* ── Auth state ── */
  const [authChecking, setAuthChecking] = useState(true);
  const [authRequired, setAuthRequired] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [authError, setAuthError] = useState("");
  const [password, setPassword] = useState("");

  /* ── Thread state ── */
  const [threads, setThreads] = useState<Thread[]>([]);
  const [currentThreadId, setCurrentThreadId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  /* ── Chat state ── */
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL);
  const [providers, setProviders] = useState<ProviderGroup[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [backgroundImage, setBackgroundImage] = useState<string | null>(null);
  const [bgLoading, setBgLoading] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [voiceProcessing, setVoiceProcessing] = useState(false);
  const [loadingThread, setLoadingThread] = useState(false);

  /* ── Refs ── */
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const currentThreadIdRef = useRef<string | null>(null);

  // Keep ref in sync with state (for use inside async callbacks)
  useEffect(() => { currentThreadIdRef.current = currentThreadId; }, [currentThreadId]);

  /* ── Auth check on mount ── */
  useEffect(() => {
    fetch("/auth/check")
      .then((res) => res.json())
      .then((data) => {
        const d = data as { authenticated: boolean; required: boolean };
        setAuthRequired(d.required);
        setAuthenticated(d.authenticated);
      })
      .catch(() => setAuthenticated(true))
      .finally(() => setAuthChecking(false));
  }, []);

  /* ── Load models + threads after auth ── */
  useEffect(() => {
    if (!authenticated) return;

    fetch("/models")
      .then((res) => res.json())
      .then((data) => setProviders((data as { providers: ProviderGroup[] }).providers))
      .catch(() => setProviders([{
        provider: "Workers AI / Meta",
        slug: "workers-ai",
        models: [{ id: DEFAULT_MODEL, name: "Llama 3.1 8B", provider: "Meta", category: "chat", supportsStreaming: true }],
      }]))
      .finally(() => setModelsLoading(false));

    loadThreadList();
  }, [authenticated]);

  /* ── Load thread list ── */
  const loadThreadList = useCallback(async () => {
    try {
      const res = await fetch("/threads");
      if (!res.ok) return;
      const data = (await res.json()) as { threads: Thread[] };
      setThreads(data.threads);
    } catch { /* non-critical */ }
  }, []);

  /* ── Switch to an existing thread ── */
  const switchThread = useCallback(async (thread: Thread) => {
    if (loadingThread) return;
    setLoadingThread(true);
    try {
      const res = await fetch(`/threads/${thread.id}`);
      if (!res.ok) return;
      const data = (await res.json()) as { messages: Message[] };
      setMessages(data.messages ?? []);
      setCurrentThreadId(thread.id);
      setBackgroundImage(null);
      setTimeout(() => inputRef.current?.focus(), 0);
    } catch { /* non-critical */ }
    finally { setLoadingThread(false); }
  }, [loadingThread]);

  /* ── Start a new chat ── */
  const startNewChat = useCallback(() => {
    setMessages([]);
    setCurrentThreadId(null);
    setBackgroundImage(null);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  /* ── Delete a thread ── */
  const deleteThread = useCallback(async (e: React.MouseEvent, threadId: string) => {
    e.stopPropagation();
    try {
      await fetch(`/threads/${threadId}`, { method: "DELETE" });
      setThreads((prev) => prev.filter((t) => t.id !== threadId));
      if (currentThreadIdRef.current === threadId) {
        setMessages([]);
        setCurrentThreadId(null);
      }
    } catch { /* non-critical */ }
  }, []);

  /* ── Auto-scroll on new messages ── */
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  /* ── Focus input on mount ── */
  useEffect(() => {
    if (authenticated) inputRef.current?.focus();
  }, [authenticated]);

  /* ── Close model picker on click outside ── */
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (modelPickerRef.current && !modelPickerRef.current.contains(e.target as Node)) {
        setShowModelPicker(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const selectedModelName = (() => {
    for (const group of providers) {
      const model = group.models.find((m) => m.id === selectedModel);
      if (model) return model.name;
    }
    return selectedModel.split("/").pop() ?? selectedModel;
  })();

  /* ── Auth submission ── */
  const submitAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError("");
    try {
      const res = await fetch("/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        setAuthenticated(true);
        setPassword("");
      } else {
        const data = (await res.json()) as { error?: string };
        setAuthError(data.error || "Invalid password");
      }
    } catch {
      setAuthError("Connection error");
    }
  };

  /* ── Background image generation ── */
  const triggerBackgroundImage = useCallback(async (prompt: string, threadId: string) => {
    setBgLoading(true);
    try {
      const res = await fetch("/generate-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, threadId }),
      });
      const data = (await res.json()) as { imageUrl?: string | null };
      if (data.imageUrl) setBackgroundImage(data.imageUrl);
    } catch { /* non-critical */ }
    finally { setBgLoading(false); }
  }, []);

  /* ── Send message ── */
  const sendMessage = useCallback(async (overrideText?: string) => {
    const text = (overrideText ?? input).trim();
    if (!text || isStreaming) return;

    const userMsg: Message = { role: "user", content: text };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsStreaming(true);

    const isFirstMessage = messages.filter((m) => m.role === "assistant").length === 0;
    const assistantMsg: Message = { role: "assistant", content: "" };
    setMessages((prev) => [...prev, assistantMsg]);

    const headers: HeadersInit = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...(currentThreadIdRef.current && { "x-thread-id": currentThreadIdRef.current }),
    };

    try {
      const res = await fetch("/chat", {
        method: "POST",
        headers,
        body: JSON.stringify({ message: text, model: selectedModel }),
      });

      // Capture the new thread ID from the response header
      const returnedThreadId = res.headers.get("x-thread-id");
      if (returnedThreadId && returnedThreadId !== currentThreadIdRef.current) {
        setCurrentThreadId(returnedThreadId);
        // Add to thread list immediately with placeholder title
        setThreads((prev) => [
          { id: returnedThreadId, title: "New Chat", createdAt: Date.now(), updatedAt: Date.now() },
          ...prev.filter((t) => t.id !== returnedThreadId),
        ]);
      }

      if (!res.ok) {
        const errText = await res.text();
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: "assistant", content: `Error: ${res.status} — ${errText}` };
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
          updated[updated.length - 1] = { role: "assistant", content: "No response stream available." };
          return updated;
        });
        setIsStreaming(false);
        return;
      }

      let accumulated = "";
      let shouldGenImage = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data);
            if (parsed.type === "text" && parsed.text) {
              accumulated += parsed.text;
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = { role: "assistant", content: accumulated };
                return updated;
              });
            }
            if (parsed.type === "generateImage") shouldGenImage = true;
          } catch { /* skip malformed */ }
        }
      }

      if ((shouldGenImage || isFirstMessage) && accumulated.length > 0) {
        triggerBackgroundImage(accumulated.slice(0, 200), currentThreadIdRef.current ?? "default");
      }

      // Refresh thread list after response to pick up AI-generated title
      if (returnedThreadId || currentThreadIdRef.current) {
        setTimeout(() => {
          loadThreadList();
        }, 2000); // give the title generation a moment
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
  }, [input, isStreaming, selectedModel, messages, triggerBackgroundImage, loadThreadList]);

  /* ── Keyboard handler ── */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  /* ── Voice recording ── */
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        await processVoice(new Blob(audioChunksRef.current, { type: "audio/webm" }));
      };

      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start();
      setIsRecording(true);
    } catch { /* mic access denied */ }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  const processVoice = async (audioBlob: Blob) => {
    setVoiceProcessing(true);
    try {
      const sttRes = await fetch("/voice/stt", {
        method: "POST",
        body: await audioBlob.arrayBuffer(),
        headers: { "Content-Type": "audio/webm" },
      });
      const sttData = (await sttRes.json()) as { text?: string };
      const transcribedText = sttData.text?.trim();
      if (!transcribedText) { setVoiceProcessing(false); return; }

      await sendMessage(transcribedText);

      setTimeout(async () => {
        try {
          const tid = currentThreadIdRef.current ?? "default";
          const historyRes = await fetch(`/history?threadId=${tid}`);
          const historyData = (await historyRes.json()) as { messages?: { role: string; content: string }[] };
          const latestAssistant = historyData.messages?.filter((m) => m.role === "assistant").pop();

          if (latestAssistant?.content) {
            const ttsRes = await fetch("/voice/tts", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ text: latestAssistant.content.slice(0, 500) }),
            });
            if (ttsRes.ok) {
              const audioData = await ttsRes.arrayBuffer();
              const audio = new Audio();
              audio.src = URL.createObjectURL(new Blob([audioData], { type: "audio/wav" }));
              audio.play().catch(() => {});
            }
          }
        } catch { /* TTS non-critical */ }
      }, 500);
    } catch { /* voice processing failed */ }
    finally { setVoiceProcessing(false); }
  };

  const chatModels = providers.map((g) => ({ ...g, models: g.models.filter((m) => m.category === "chat" || m.category === "code") })).filter((g) => g.models.length > 0);
  const imageModels = providers.map((g) => ({ ...g, models: g.models.filter((m) => m.category === "image" || m.category === "vision") })).filter((g) => g.models.length > 0);

  /* ── Loading screen ── */
  if (authChecking) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", color: "var(--muted-foreground)" }}>
        <Spinner />
      </div>
    );
  }

  /* ── Auth gate ── */
  if (authRequired && !authenticated) {
    return (
      <>
        <style>{authStyles}</style>
        <div className="auth-root">
          <form className="auth-card" onSubmit={submitAuth}>
            <h1 className="auth-title">Authentication</h1>
            <p className="auth-subtitle">Enter the access password to continue</p>
            {authError && <p className="auth-error">{authError}</p>}
            <input
              type="password"
              className="auth-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              data-form-type="other"
              data-lpignore="true"
              data-1p-ignore="true"
              name="access-key-field"
              id="access-key-field"
              autoFocus
            />
            <button type="submit" className="auth-submit" disabled={!password.trim()}>
              Continue
            </button>
          </form>
        </div>
      </>
    );
  }

  /* ── Main UI ── */
  return (
    <>
      <style>{chatStyles}</style>

      <div className="app-root">
        {/* ── Sidebar ── */}
        <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : "sidebar-closed"}`}>
          <div className="sidebar-header">
            <button className="new-chat-btn" onClick={startNewChat}>
              <PlusIcon /> New chat
            </button>
            <button
              className="icon-btn sidebar-toggle-btn"
              onClick={() => setSidebarOpen(false)}
              title="Close sidebar"
            >
              <SidebarCloseIcon />
            </button>
          </div>

          <div className="thread-list">
            {threads.length === 0 ? (
              <p className="thread-list-empty">No conversations yet</p>
            ) : (
              threads.map((thread) => (
                <div
                  key={thread.id}
                  className={`thread-item ${thread.id === currentThreadId ? "thread-item-active" : ""}`}
                  onClick={() => switchThread(thread)}
                >
                  <span className="thread-title">{thread.title || "New Chat"}</span>
                  <span className="thread-time">{relativeTime(thread.updatedAt)}</span>
                  <button
                    className="thread-delete-btn"
                    onClick={(e) => deleteThread(e, thread.id)}
                    title="Delete conversation"
                    aria-label="Delete"
                  >
                    <TrashIcon />
                  </button>
                </div>
              ))
            )}
          </div>
        </aside>

        {/* ── Main chat area ── */}
        <div className="chat-root">
          {backgroundImage && (
            <div className="chat-bg loaded" style={{ backgroundImage: `url(${backgroundImage})` }} />
          )}

          {/* Top bar */}
          <div className="top-bar">
            {!sidebarOpen && (
              <button
                className="icon-btn"
                onClick={() => setSidebarOpen(true)}
                title="Open sidebar"
                style={{ marginRight: "0.25rem" }}
              >
                <SidebarOpenIcon />
              </button>
            )}

            <div className="model-selector" ref={modelPickerRef}>
              <button
                className="model-btn"
                onClick={() => setShowModelPicker(!showModelPicker)}
                disabled={modelsLoading}
              >
                {modelsLoading ? "Loading…" : selectedModelName}
                <ChevronDownIcon />
              </button>

              {showModelPicker && (
                <div className="model-dropdown">
                  {chatModels.length > 0 && (
                    <>
                      <div className="model-group-label">Chat Models</div>
                      {chatModels.map((group) => (
                        <div key={group.provider}>
                          <div className="model-group-label">{group.provider}</div>
                          {group.models.map((m) => (
                            <button
                              key={m.id}
                              className={`model-option ${m.id === selectedModel ? "active" : ""}`}
                              onClick={() => { setSelectedModel(m.id); setShowModelPicker(false); }}
                            >
                              {m.name}
                              {m.category !== "chat" && <span className="cat-badge">{m.category}</span>}
                            </button>
                          ))}
                        </div>
                      ))}
                    </>
                  )}
                  {imageModels.length > 0 && (
                    <>
                      <div className="model-group-label" style={{ marginTop: "0.5rem", borderTop: "1px solid var(--border)", paddingTop: "0.5rem" }}>
                        Image / Vision Models
                      </div>
                      {imageModels.map((group) => (
                        <div key={group.provider}>
                          <div className="model-group-label">{group.provider}</div>
                          {group.models.map((m) => (
                            <button
                              key={m.id}
                              className={`model-option ${m.id === selectedModel ? "active" : ""}`}
                              onClick={() => { setSelectedModel(m.id); setShowModelPicker(false); }}
                            >
                              {m.name}
                              <span className="cat-badge">{m.category}</span>
                            </button>
                          ))}
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>

            <div className="top-actions">
              <button
                className={`icon-btn ${isRecording ? "recording" : ""} ${voiceProcessing ? "processing" : ""}`}
                onClick={isRecording ? stopRecording : startRecording}
                disabled={voiceProcessing || isStreaming}
                title={isRecording ? "Stop recording" : "Voice input"}
              >
                {voiceProcessing ? <Spinner /> : <MicIcon />}
              </button>
            </div>
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="chat-messages">
            {loadingThread ? (
              <div style={{ display: "flex", justifyContent: "center", paddingTop: "4rem" }}>
                <Spinner />
              </div>
            ) : messages.length === 0 ? (
              <Greeting onSuggest={(text) => { setInput(text); setTimeout(() => inputRef.current?.focus(), 0); }} />
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
                        {msg.content || (isStreaming && i === messages.length - 1 ? (
                          <span className="typing-dots"><span /><span /><span /></span>
                        ) : "")}
                      </div>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>

          {/* Input */}
          <div className="input-area">
            <div className="input-box" onClick={() => inputRef.current?.focus()}>
              <div className="input-editor">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask anything…"
                  rows={1}
                  className="input-textarea"
                  disabled={isStreaming || loadingThread}
                />
              </div>
              <div className="input-actions">
                <div className="input-left-actions">
                  <button
                    className="icon-btn"
                    style={{ width: "1.5rem", height: "1.5rem", border: "none" }}
                    onClick={isRecording ? stopRecording : startRecording}
                    disabled={voiceProcessing || isStreaming}
                    title="Voice input"
                  >
                    <MicIcon />
                  </button>
                </div>
                <button
                  onClick={() => sendMessage()}
                  disabled={!input.trim() || isStreaming || loadingThread}
                  className="send-btn"
                  aria-label="Send message"
                >
                  {isStreaming ? <Spinner /> : <ArrowUpIcon />}
                </button>
              </div>
            </div>
            <p className="input-footer">Powered by Honi Agent · Workers AI · Cloudflare Edge</p>
          </div>

          {bgLoading && (
            <div className="bg-indicator">
              <Spinner /> Generating background…
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/* ── Helpers ── */

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const m = Math.floor(diff / 60000);
  const h = Math.floor(diff / 3600000);
  const d = Math.floor(diff / 86400000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  return `${d}d ago`;
}

/* ── Sub-components ── */

function Greeting({ onSuggest }: { onSuggest: (text: string) => void }) {
  const greetings = ["What can I help with?", "Good to see you again.", "What are you working on today?"];
  const greeting = greetings[Math.floor(Math.random() * greetings.length)];
  return (
    <div className="greeting-wrap">
      <div className="greeting-inner">
        <h1 className="greeting-title">{greeting}</h1>
        <p className="greeting-subtitle">Chat with AI — powered by Cloudflare Workers, AI Gateway, and multi-provider models</p>
        <div className="greeting-suggestions">
          {["What can you do?", "What time is it?", "Calculate 42 * 17"].map((s) => (
            <button key={s} className="greeting-chip" onClick={() => onSuggest(s)}>{s}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── Icons ── */

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14H6L5 6" />
      <path d="M10 11v6" /><path d="M14 11v6" />
      <path d="M9 6V4h6v2" />
    </svg>
  );
}

function SidebarOpenIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
      <path d="M13 9l3 3-3 3" />
    </svg>
  );
}

function SidebarCloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
      <path d="M15 9l-3 3 3 3" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  );
}

function ArrowUpIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" opacity="0.2" />
      <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round">
        <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.75s" repeatCount="indefinite" />
      </path>
    </svg>
  );
}

/* ── Styles ── */

const authStyles = `
  .auth-root { display:flex; align-items:center; justify-content:center; height:100vh; padding:1rem; }
  .auth-card { width:100%; max-width:360px; background:var(--background); border:1px solid var(--border); border-radius:1rem; padding:2rem; box-shadow:0 4px 20px rgba(0,0,0,0.2); }
  .auth-title { font-size:1.25rem; font-weight:500; color:var(--foreground); margin-bottom:0.5rem; text-align:center; }
  .auth-subtitle { font-size:0.8125rem; color:var(--muted-foreground); margin-bottom:1.5rem; text-align:center; }
  .auth-input { width:100%; padding:0.75rem 1rem; border:1px solid var(--border); border-radius:0.75rem; background:var(--secondary); color:var(--foreground); font-size:0.875rem; font-family:inherit; outline:none; transition:border-color 0.15s; margin-bottom:1rem; box-sizing:border-box; }
  .auth-input:focus { border-color:var(--primary); }
  .auth-submit { width:100%; padding:0.75rem 1rem; border:none; border-radius:0.75rem; background:var(--primary); color:var(--primary-foreground); font-size:0.875rem; font-family:inherit; cursor:pointer; transition:opacity 0.15s; }
  .auth-submit:hover { opacity:0.9; }
  .auth-submit:disabled { opacity:0.5; cursor:default; }
  .auth-error { color:#ef4444; font-size:0.8125rem; text-align:center; margin-bottom:1rem; }
`;

const chatStyles = `
  /* ── Root layout ── */
  .app-root {
    display: flex;
    height: 100vh;
    max-height: 100dvh;
    overflow: hidden;
    background: var(--background);
  }

  /* ── Sidebar ── */
  .sidebar {
    display: flex;
    flex-direction: column;
    width: 260px;
    flex-shrink: 0;
    border-right: 1px solid var(--border);
    background: color-mix(in oklch, var(--background) 95%, transparent);
    overflow: hidden;
    transition: width 0.2s ease, opacity 0.2s ease;
  }
  .sidebar-open { width: 260px; opacity: 1; }
  .sidebar-closed { width: 0; opacity: 0; pointer-events: none; }

  .sidebar-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .new-chat-btn {
    flex: 1;
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: 0.75rem;
    background: transparent;
    color: var(--foreground);
    font-size: 0.8125rem;
    font-family: inherit;
    cursor: pointer;
    transition: background 0.15s;
    white-space: nowrap;
  }
  .new-chat-btn:hover { background: var(--muted); }
  .sidebar-toggle-btn { flex-shrink: 0; }

  .thread-list {
    flex: 1;
    overflow-y: auto;
    padding: 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }
  .thread-list-empty {
    font-size: 0.8125rem;
    color: var(--muted-foreground);
    text-align: center;
    padding: 1.5rem 1rem;
  }
  .thread-item {
    position: relative;
    display: flex;
    flex-direction: column;
    padding: 0.5rem 0.75rem;
    border-radius: 0.625rem;
    cursor: pointer;
    transition: background 0.1s;
    min-width: 0;
  }
  .thread-item:hover { background: var(--muted); }
  .thread-item-active { background: var(--accent); }
  .thread-item:hover .thread-delete-btn,
  .thread-item-active .thread-delete-btn { opacity: 1; }
  .thread-title {
    font-size: 0.8125rem;
    color: var(--foreground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    padding-right: 1.25rem;
  }
  .thread-time {
    font-size: 0.6875rem;
    color: var(--muted-foreground);
    margin-top: 0.125rem;
  }
  .thread-delete-btn {
    position: absolute;
    top: 50%;
    right: 0.5rem;
    transform: translateY(-50%);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    height: 1.25rem;
    border: none;
    background: transparent;
    color: var(--muted-foreground);
    cursor: pointer;
    border-radius: 0.25rem;
    opacity: 0;
    transition: opacity 0.15s, background 0.1s, color 0.1s;
  }
  .thread-delete-btn:hover { background: var(--destructive); color: white; }

  /* ── Main chat ── */
  .chat-root {
    flex: 1;
    display: flex;
    flex-direction: column;
    position: relative;
    overflow: hidden;
    min-width: 0;
  }
  .chat-bg {
    position: absolute; inset: 0; z-index: 0;
    background-size: cover; background-position: center;
    opacity: 0.12; transition: opacity 0.8s ease, background-image 0.8s ease;
    pointer-events: none;
  }
  .chat-bg.loaded { opacity: 0.15; }

  /* ── Top bar ── */
  .top-bar {
    position: relative; z-index: 10;
    display: flex; align-items: center; justify-content: space-between;
    padding: 0.5rem 1rem;
    border-bottom: 1px solid var(--border);
    background: color-mix(in oklch, var(--background) 85%, transparent);
    backdrop-filter: blur(8px);
  }
  .model-selector { position: relative; }
  .model-btn {
    display: inline-flex; align-items: center; gap: 0.375rem;
    padding: 0.375rem 0.75rem;
    border-radius: 9999px; border: 1px solid var(--border);
    background: var(--secondary); color: var(--secondary-foreground);
    font-size: 0.75rem; font-family: inherit; cursor: pointer;
    transition: background 0.15s, border-color 0.15s; white-space: nowrap;
  }
  .model-btn:hover { background: var(--muted); border-color: var(--input); }
  .model-btn svg { width: 12px; height: 12px; flex-shrink: 0; }
  .model-dropdown {
    position: absolute; top: calc(100% + 4px); left: 0;
    min-width: 280px; max-height: 400px; overflow-y: auto;
    background: var(--background); border: 1px solid var(--border);
    border-radius: 0.75rem; box-shadow: 0 8px 30px rgba(0,0,0,0.3);
    z-index: 100; padding: 0.25rem;
  }
  .model-group-label {
    padding: 0.5rem 0.75rem 0.25rem; font-size: 0.6875rem; font-weight: 600;
    color: var(--muted-foreground); text-transform: uppercase; letter-spacing: 0.05em;
  }
  .model-option {
    display: flex; align-items: center; gap: 0.5rem; width: 100%;
    padding: 0.5rem 0.75rem; border: none; border-radius: 0.5rem;
    background: transparent; color: var(--foreground); font-size: 0.8125rem;
    font-family: inherit; cursor: pointer; text-align: left; transition: background 0.1s;
  }
  .model-option:hover { background: var(--muted); }
  .model-option.active { background: var(--accent); }
  .model-option .cat-badge {
    font-size: 0.625rem; padding: 0.125rem 0.375rem; border-radius: 9999px;
    background: var(--muted); color: var(--muted-foreground); margin-left: auto; flex-shrink: 0;
  }
  .top-actions { display: flex; align-items: center; gap: 0.5rem; }
  .icon-btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 2rem; height: 2rem; border-radius: 9999px;
    border: 1px solid var(--border); background: transparent; color: var(--foreground);
    cursor: pointer; transition: background 0.15s, color 0.15s; flex-shrink: 0;
  }
  .icon-btn:hover { background: var(--muted); }
  .icon-btn.recording { background: #ef4444; color: white; border-color: #ef4444; animation: pulse 1.5s infinite; }
  .icon-btn.processing { opacity: 0.5; pointer-events: none; }
  @keyframes pulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(239,68,68,0.4); }
    50% { box-shadow: 0 0 0 6px rgba(239,68,68,0); }
  }

  /* ── Messages ── */
  .chat-messages {
    flex: 1; overflow-y: auto; padding: 1.5rem 0;
    scrollbar-gutter: stable both-edges; position: relative; z-index: 1;
  }
  .msg-row { width: 100%; max-width: 48rem; margin: 0 auto; padding: 0 1.5rem; animation: fadeIn 0.3s ease; }
  .msg-user-wrap { display: flex; flex-direction: column; align-items: flex-end; margin: 0.5rem 0; gap: 0.5rem; }
  .msg-user-bubble {
    max-width: 80%; background: var(--accent); color: var(--accent-foreground);
    padding: 0.75rem 1rem; border-radius: 1rem; box-shadow: inset 0 0 0 1px var(--input);
    font-size: 0.875rem; line-height: 1.5; white-space: pre-wrap; word-break: break-word;
  }
  .msg-assistant-wrap { display: flex; flex-direction: column; gap: 1rem; padding: 0.5rem; margin: 0.25rem 0; }
  .msg-assistant-text { font-size: 0.875rem; line-height: 1.625; white-space: pre-wrap; word-break: break-word; color: var(--foreground); }

  /* ── Greeting ── */
  .greeting-wrap { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; animation: fadeIn 0.6s ease; }
  .greeting-inner { max-width: 48rem; margin: 0 auto; padding: 1.5rem; text-align: center; }
  .greeting-title { font-size: 1.5rem; font-weight: 400; color: var(--foreground); margin-bottom: 0.75rem; line-height: 1.3; }
  @media (min-width: 768px) { .greeting-title { font-size: 1.875rem; } }
  .greeting-subtitle { font-size: 0.875rem; color: var(--muted-foreground); margin-bottom: 1.5rem; }
  .greeting-suggestions { display: flex; flex-wrap: wrap; gap: 0.5rem; justify-content: center; }
  .greeting-chip {
    background: var(--secondary); color: var(--secondary-foreground);
    border: 1px solid var(--border); border-radius: 9999px;
    padding: 0.5rem 1rem; font-size: 0.8125rem; cursor: pointer;
    transition: background 0.15s, border-color 0.15s; font-family: inherit;
  }
  .greeting-chip:hover { background: var(--muted); border-color: var(--input); }

  /* ── Input ── */
  .input-area {
    width: 100%; max-width: 48rem; margin: 0 auto; padding: 0 1rem 1rem;
    animation: fadeIn 0.5s ease; position: relative; z-index: 10;
  }
  .input-box {
    position: relative; display: flex; flex-direction: column; width: 100%;
    background: color-mix(in oklch, var(--muted) 60%, transparent);
    border-radius: 2rem; box-shadow: 0 4px 20px rgba(0,0,0,0.2), 0 1px 4px rgba(0,0,0,0.15);
    backdrop-filter: blur(4px); transition: background 0.2s, box-shadow 0.2s;
    overflow: hidden; cursor: text;
  }
  .input-box:hover, .input-box:focus-within { background: var(--muted); }
  .input-editor { display: flex; flex-direction: column; gap: 0.875rem; padding: 0.5rem 1.25rem 0.5rem; }
  .input-textarea {
    flex: 1; background: transparent; border: none; outline: none;
    color: var(--foreground); font-size: 0.875rem; font-family: inherit;
    resize: none; line-height: 1.5; min-height: 2rem; max-height: 10rem;
  }
  .input-textarea::placeholder { color: var(--muted-foreground); }
  .input-actions {
    display: flex; align-items: center; justify-content: space-between;
    padding: 0 0.75rem 0.5rem;
  }
  .input-left-actions { display: flex; align-items: center; gap: 0.25rem; }
  .send-btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 2rem; height: 2rem; border-radius: 9999px; border: none;
    background: var(--secondary); color: var(--secondary-foreground);
    cursor: pointer; transition: background 0.2s, opacity 0.15s; flex-shrink: 0;
  }
  .send-btn:hover:not(:disabled) { background: var(--accent-foreground); color: var(--accent); }
  .send-btn:disabled { opacity: 0.35; cursor: default; }
  .input-footer { text-align: center; font-size: 0.6875rem; color: var(--muted-foreground); padding: 0.5rem 0 0; opacity: 0.6; }

  /* ── Typing indicator ── */
  .typing-dots { display: inline-flex; gap: 4px; align-items: center; padding: 4px 0; }
  .typing-dots span { width: 6px; height: 6px; border-radius: 50%; background: var(--muted-foreground); animation: typingBounce 1.2s infinite; }
  .typing-dots span:nth-child(2) { animation-delay: 0.15s; }
  .typing-dots span:nth-child(3) { animation-delay: 0.3s; }
  @keyframes typingBounce {
    0%, 60%, 100% { opacity: 0.3; transform: translateY(0); }
    30% { opacity: 1; transform: translateY(-3px); }
  }

  /* ── BG loading ── */
  .bg-indicator {
    position: fixed; bottom: 5rem; right: 1rem; font-size: 0.6875rem;
    color: var(--muted-foreground); background: var(--background); border: 1px solid var(--border);
    padding: 0.25rem 0.5rem; border-radius: 0.5rem; z-index: 20;
    display: flex; align-items: center; gap: 0.25rem; animation: fadeIn 0.3s ease;
  }

  /* ── Animations ── */
  @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }

  /* ── Mobile ── */
  @media (max-width: 640px) {
    .sidebar { position: absolute; z-index: 50; height: 100%; box-shadow: 4px 0 20px rgba(0,0,0,0.2); }
    .sidebar-closed { width: 0; }
  }
`;
