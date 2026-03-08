/**
 * Worker entrypoint — Hono app composing Honi agent with custom routes.
 *
 * This is the main entry point for the Cloudflare Worker. It uses Hono
 * for HTTP routing and composes the honidev-powered ChatAgent with
 * additional custom routes for voice, images, config, auth, and threads.
 *
 * Route map:
 *   POST   /auth             → Verify password, set auth cookie
 *   GET    /auth/check       → Check if user is authenticated
 *   GET    /models           → List available models grouped by provider
 *   POST   /voice/stt        → Speech-to-text (Whisper)
 *   POST   /voice/tts        → Text-to-speech (MeloTTS)
 *   POST   /generate-image   → Generate background image → Cloudflare Images
 *   GET    /image/:key       → Redirect to Cloudflare Images delivery URL
 *   POST   /chat             → Honi ChatAgent (streaming AI response)
 *                              Generates UUID for new threads, persists
 *                              messages to D1, triggers AI title generation.
 *   GET    /history          → Honi ChatAgent (conversation history)
 *   DELETE /history          → Honi ChatAgent (clear memory)
 *   POST   /reset            → Alias for DELETE /history
 *   POST   /mcp              → Honi ChatAgent MCP server
 *   GET    /mcp/tools        → Honi ChatAgent MCP tool listing
 *   GET    /threads          → List all threads from D1
 *   GET    /threads/:id      → Get thread with messages from D1
 *   DELETE /threads/:id      → Delete thread from D1
 *   GET    /config           → Get all config settings
 *   GET    /config/:key      → Get a single config value
 *   PUT    /config/:key      → Set a single config value
 *   DELETE /config/:key      → Delete a single config value
 *   PUT    /config           → Replace all config settings (bulk)
 *   *                        → Static Astro assets (ASSETS binding)
 *
 * Cron (daily at midnight UTC):
 *   scheduled              → Delete expired images from Cloudflare Images
 *
 * @module entry
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { eq } from "drizzle-orm";

/* ── Honi agent ── */
import { chatAgent, ChatAgentDO } from "./src/agents/chat-agent.js";

/**
 * Export the ChatAgent Durable Object class.
 */
export const ChatAgent = ChatAgentDO;

/* ── Module imports ── */
import { isAuthenticated, isAuthRequired, handleAuth } from "./src/lib/auth.js";
import { listModels } from "./src/lib/models.js";
import { handleSTT, handleTTS } from "./src/lib/voice.js";
import { generateBackgroundImage, cleanupExpiredImages } from "./src/lib/images.js";
import {
  handleGetAllConfig,
  handleGetConfig,
  handleSetConfig,
  handleDeleteConfig,
  handleSetAllConfig,
} from "./src/lib/config.js";
import { generateThreadTitle } from "./src/lib/title.js";
import { threadsRouter } from "./src/routes/threads.js";
import { getDb, threads, messages } from "./src/backend/db/index.js";

/* ── Hono app with Env bindings ── */

type HonoEnv = { Bindings: Env };

const app = new Hono<HonoEnv>();

/* ── CORS middleware ── */

app.use("*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Accept", "x-thread-id"],
  exposeHeaders: ["x-thread-id"],
}));

/* ── Auth routes (unprotected) ── */

app.post("/auth", async (c) => handleAuth(c.req.raw, c.env));
app.get("/auth/check", async (c) => {
  const required = await isAuthRequired(c.env);
  if (!required) return c.json({ authenticated: true, required: false });
  const authed = await isAuthenticated(c.req.raw, c.env);
  return c.json({ authenticated: authed, required: true });
});

/* ── Auth middleware ── */

const protectedPaths = [
  "/models",
  "/voice/*",
  "/generate-image",
  "/chat",
  "/history",
  "/reset",
  "/mcp",
  "/mcp/*",
  "/config",
  "/config/*",
  "/threads",
  "/threads/*",
];

for (const path of protectedPaths) {
  app.use(path, authGuard);
}

async function authGuard(
  c: { env: Env; req: { raw: Request }; json: (data: unknown, status?: number) => Response },
  next: () => Promise<void>,
): Promise<Response | void> {
  const required = await isAuthRequired(c.env);
  if (required) {
    const authed = await isAuthenticated(c.req.raw, c.env);
    if (!authed) return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
}

/* ── Model listing ── */

app.get("/models", async (c) => {
  const models = await listModels(c.env);
  return c.json({ providers: models });
});

/* ── Voice endpoints ── */

app.post("/voice/stt", async (c) => handleSTT(c.req.raw, c.env));
app.post("/voice/tts", async (c) => handleTTS(c.req.raw, c.env));

/* ── Image generation ── */

app.post("/generate-image", async (c) => {
  const body = await c.req.json<{ prompt?: string; threadId?: string }>();
  const prompt = body.prompt ?? "abstract background";
  const threadId = body.threadId ?? "default";
  const imageUrl = await generateBackgroundImage(c.env, threadId, prompt);
  return c.json({ imageUrl });
});

app.get("/image/:key", async (c) => {
  const key = c.req.param("key");

  const jsonData = await c.env.KV.get(`image:${key}`, "text");
  if (jsonData) {
    try {
      const record = JSON.parse(jsonData) as { url?: string };
      if (record.url) return c.redirect(record.url, 302);
    } catch { /* fall through */ }
  }

  const imageData = await c.env.KV.get(`image:${key}`, "arrayBuffer");
  if (!imageData) return c.text("Not found", 404);
  return new Response(imageData, {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" },
  });
});

/* ── Chat — thread-aware wrapper around Honi agent ── */

/**
 * POST /chat — streaming AI response with D1-backed thread persistence.
 *
 * Flow:
 * 1. Read `x-thread-id` header. If absent (or "default"), generate a new UUID
 *    and create a thread row in D1.
 * 2. Save the user message to D1.
 * 3. Forward the request to the Honi ChatAgent with the resolved thread ID.
 * 4. Pipe the SSE stream back to the client while capturing the full assistant
 *    text in a background task.
 * 5. After the stream ends, save the assistant message to D1.
 * 6. If this is a new thread, asynchronously generate a title via Workers AI
 *    and update the thread row.
 *
 * The resolved `x-thread-id` is always set in the response headers so the
 * frontend can discover the UUID for a newly created thread.
 */
app.post("/chat", async (c) => {
  const incomingThreadId = c.req.header("x-thread-id");
  const isNewThread = !incomingThreadId || incomingThreadId === "default";
  const threadId = isNewThread ? crypto.randomUUID() : incomingThreadId;

  const body = await c.req.json<{ message?: string; model?: string }>();
  const userMessage = body.message ?? "";
  const now = Date.now();

  const db = getDb(c.env);

  if (isNewThread) {
    // Create the thread row immediately so messages can reference it
    await db.insert(threads).values({
      id: threadId,
      title: "New Chat",
      createdAt: now,
      updatedAt: now,
    });
  } else {
    // Bump updatedAt on existing thread
    await db
      .update(threads)
      .set({ updatedAt: now })
      .where(eq(threads.id, threadId));
  }

  // Persist user message
  if (userMessage) {
    await db.insert(messages).values({
      id: crypto.randomUUID(),
      threadId,
      role: "user",
      content: userMessage,
      createdAt: now,
    });
  }

  // Build a modified request with the resolved thread ID for the agent
  const modifiedReq = new Request(c.req.raw.url, {
    method: "POST",
    headers: (() => {
      const h = new Headers(c.req.raw.headers);
      h.set("x-thread-id", threadId);
      return h;
    })(),
    body: JSON.stringify(body),
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const agentResponse = await chatAgent.fetch(modifiedReq as any, c.env, c.executionCtx as any);

  // Pipe agent stream to client while buffering the assistant text
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  const pipePromise = (async () => {
    const reader = agentResponse.body?.getReader();
    if (!reader) {
      await writer.close();
      return;
    }

    const decoder = new TextDecoder();
    let assistantContent = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Extract text from SSE events: `data: {"type":"text","text":"..."}`
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          try {
            const parsed = JSON.parse(line.slice(6));
            if (parsed.type === "text" && typeof parsed.text === "string") {
              assistantContent += parsed.text;
            }
          } catch { /* skip malformed chunks */ }
        }

        await writer.write(value);
      }
    } finally {
      writer.close().catch(() => {});
    }

    // Persist assistant message
    if (assistantContent) {
      await db.insert(messages).values({
        id: crypto.randomUUID(),
        threadId,
        role: "assistant",
        content: assistantContent,
        createdAt: Date.now(),
      });

      // Update thread timestamp again after assistant reply
      await db
        .update(threads)
        .set({ updatedAt: Date.now() })
        .where(eq(threads.id, threadId));
    }

    // Generate title for new threads asynchronously
    if (isNewThread && userMessage) {
      const title = await generateThreadTitle(c.env, userMessage);
      await db
        .update(threads)
        .set({ title })
        .where(eq(threads.id, threadId));
    }
  })();

  c.executionCtx.waitUntil(pipePromise);

  const responseHeaders = new Headers(agentResponse.headers);
  responseHeaders.set("x-thread-id", threadId);

  return new Response(readable, {
    status: agentResponse.status,
    headers: responseHeaders,
  });
});

/* ── Honi agent history / reset / mcp ── */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function delegateToAgent(c: any): Promise<Response> {
  return chatAgent.fetch(c.req.raw, c.env, c.executionCtx);
}

app.get("/history", async (c) => delegateToAgent(c));
app.delete("/history", async (c) => delegateToAgent(c));

app.post("/reset", async (c) => {
  const deleteReq = new Request(new URL("/history", c.req.raw.url).href, {
    method: "DELETE",
    headers: c.req.raw.headers,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return chatAgent.fetch(deleteReq as any, c.env, c.executionCtx as any);
});

app.post("/mcp", async (c) => delegateToAgent(c));
app.get("/mcp/tools", async (c) => delegateToAgent(c));

/* ── Thread management API ── */

app.route("/threads", threadsRouter);

/* ── Config endpoints ── */

app.get("/config", async (c) => handleGetAllConfig(c.env));
app.put("/config", async (c) => handleSetAllConfig(c.req.raw, c.env));
app.get("/config/:key", async (c) => handleGetConfig(c.env, c.req.param("key")));
app.put("/config/:key", async (c) => handleSetConfig(c.req.raw, c.env, c.req.param("key")));
app.delete("/config/:key", async (c) => handleDeleteConfig(c.env, c.req.param("key")));

/* ── Static assets catch-all ── */

app.all("*", async (c) => c.env.ASSETS.fetch(c.req.raw));

/* ── Worker export ── */

export default {
  fetch: app.fetch,

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(cleanupExpiredImages(env));
  },
};
