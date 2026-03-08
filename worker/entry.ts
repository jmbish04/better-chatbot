/**
 * Worker entrypoint — Hono app composing Honi agent with custom routes.
 *
 * This is the main entry point for the Cloudflare Worker. It uses Hono
 * for HTTP routing and composes the honidev-powered ChatAgent with
 * additional custom routes for voice, images, config, and auth.
 *
 * The ChatAgent is created via honidev's `createAgent()` which provides:
 * - Persistent Durable Object memory per thread
 * - Streaming AI responses via the Vercel AI SDK
 * - Multi-provider model resolution (@cf/*, claude-*, gpt-*, gemini-*)
 * - MCP server endpoint for tool exposure
 *
 * Route map:
 *   POST /auth             → Verify password, set auth cookie
 *   GET  /auth/check       → Check if user is authenticated
 *   GET  /models           → List available models grouped by provider
 *   POST /voice/stt        → Speech-to-text (Whisper)
 *   POST /voice/tts        → Text-to-speech (MeloTTS)
 *   POST /generate-image   → Generate background image → Cloudflare Images
 *   GET  /image/:key       → Redirect to Cloudflare Images delivery URL
 *   POST /chat             → Honi ChatAgent (streaming AI response)
 *   GET  /history          → Honi ChatAgent (conversation history)
 *   DELETE /history        → Honi ChatAgent (clear memory)
 *   POST /reset            → Alias for DELETE /history
 *   POST /mcp              → Honi ChatAgent MCP server
 *   GET  /mcp/tools        → Honi ChatAgent MCP tool listing
 *   GET  /config           → Get all config settings
 *   GET  /config/:key      → Get a single config value
 *   PUT  /config/:key      → Set a single config value
 *   DELETE /config/:key    → Delete a single config value
 *   PUT  /config           → Replace all config settings (bulk)
 *   *                      → Static Astro assets (ASSETS binding)
 *
 * Cron (daily at midnight UTC):
 *   scheduled              → Delete expired images from Cloudflare Images
 *
 * All API routes (except /auth, /auth/check, and static assets) require
 * authentication when WORKER_API_KEY is configured in the Secrets Store.
 *
 * @module entry
 */

import { Hono } from "hono";
import { cors } from "hono/cors";

/* ── Honi agent ── */
import { chatAgent, ChatAgentDO } from "./src/agents/chat-agent.js";

/**
 * Export the ChatAgent Durable Object class.
 *
 * Wrangler requires the DO class to be exported from the main entry file.
 * The class is created by honidev's `createAgent()` and provides persistent
 * per-thread conversation memory backed by Durable Object storage.
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

/* ── Hono app with Env bindings ── */

type HonoEnv = { Bindings: Env };

const app = new Hono<HonoEnv>();

/* ── CORS middleware ── */

app.use("*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Accept", "x-thread-id"],
}));

/* ── Auth routes (unprotected) ── */

/** POST /auth — verify password and set auth cookie. */
app.post("/auth", async (c) => {
  return handleAuth(c.req.raw, c.env);
});

/** GET /auth/check — check authentication status. */
app.get("/auth/check", async (c) => {
  const required = await isAuthRequired(c.env);
  if (!required) {
    return c.json({ authenticated: true, required: false });
  }
  const authed = await isAuthenticated(c.req.raw, c.env);
  return c.json({ authenticated: authed, required: true });
});

/* ── Auth middleware for all protected API routes ── */

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
];

for (const path of protectedPaths) {
  app.use(path, authGuard);
}

/**
 * Auth guard middleware — rejects unauthenticated requests with 401.
 *
 * Skips auth check if WORKER_API_KEY is not configured in the Secrets Store.
 */
async function authGuard(
  c: { env: Env; req: { raw: Request }; json: (data: unknown, status?: number) => Response },
  next: () => Promise<void>,
): Promise<Response | void> {
  const required = await isAuthRequired(c.env);
  if (required) {
    const authed = await isAuthenticated(c.req.raw, c.env);
    if (!authed) {
      return c.json({ error: "Unauthorized" }, 401);
    }
  }
  await next();
}

/* ── Model listing ── */

/** GET /models — return available models grouped by provider. */
app.get("/models", async (c) => {
  const models = await listModels(c.env);
  return c.json({ providers: models });
});

/* ── Voice endpoints ── */

/** POST /voice/stt — speech-to-text via Whisper. */
app.post("/voice/stt", async (c) => handleSTT(c.req.raw, c.env));

/** POST /voice/tts — text-to-speech via MeloTTS. */
app.post("/voice/tts", async (c) => handleTTS(c.req.raw, c.env));

/* ── Image generation ── */

/** POST /generate-image — generate a background image via SDXL Lightning. */
app.post("/generate-image", async (c) => {
  const body = await c.req.json<{ prompt?: string; threadId?: string }>();
  const prompt = body.prompt ?? "abstract background";
  const threadId = body.threadId ?? "default";
  const imageUrl = await generateBackgroundImage(c.env, threadId, prompt);
  return c.json({ imageUrl });
});

/** GET /image/:key — serve a stored image (redirect to CF Images or raw KV bytes). */
app.get("/image/:key", async (c) => {
  const key = c.req.param("key");

  // Try JSON record first (Cloudflare Images upload)
  const jsonData = await c.env.KV.get(`image:${key}`, "text");
  if (jsonData) {
    try {
      const record = JSON.parse(jsonData) as { url?: string };
      if (record.url) {
        return c.redirect(record.url, 302);
      }
    } catch {
      // Not JSON — fall through to raw bytes
    }
  }

  // Fallback: raw bytes in KV
  const imageData = await c.env.KV.get(`image:${key}`, "arrayBuffer");
  if (!imageData) {
    return c.text("Not found", 404);
  }
  return new Response(imageData, {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "public, max-age=86400",
    },
  });
});

/* ── Honi agent routes (chat, history, reset, mcp) ── */

/**
 * Delegate to the honidev agent's fetch handler.
 *
 * The honidev `createAgent()` returns a Hono-based fetch handler that
 * manages /chat (POST), /history (GET/DELETE), and /mcp routes internally.
 * We forward matching requests to the agent's handler, passing through
 * the Worker env and execution context.
 */
async function delegateToAgent(c: { req: { raw: Request }; env: Env; executionCtx: ExecutionContext }): Promise<Response> {
  return chatAgent.fetch(c.req.raw, c.env, c.executionCtx);
}

/** POST /chat — send a message to the Honi ChatAgent (streaming response). */
app.post("/chat", async (c) => delegateToAgent(c));

/** GET /history — retrieve conversation history from the Honi ChatAgent. */
app.get("/history", async (c) => delegateToAgent(c));

/** DELETE /history — clear conversation memory in the Honi ChatAgent. */
app.delete("/history", async (c) => delegateToAgent(c));

/**
 * POST /reset — alias for DELETE /history (backwards compatibility).
 *
 * Rewrites the request as a DELETE to /history and forwards to the agent.
 */
app.post("/reset", async (c) => {
  const deleteReq = new Request(new URL("/history", c.req.raw.url).href, {
    method: "DELETE",
    headers: c.req.raw.headers,
  });
  return chatAgent.fetch(deleteReq, c.env, c.executionCtx);
});

/** POST /mcp — Honi agent MCP server endpoint. */
app.post("/mcp", async (c) => delegateToAgent(c));

/** GET /mcp/tools — list available tools from the Honi agent. */
app.get("/mcp/tools", async (c) => delegateToAgent(c));

/* ── Config settings endpoints ── */

/** GET /config — return all config settings. */
app.get("/config", async (c) => handleGetAllConfig(c.env));

/** PUT /config — replace all config settings (bulk). */
app.put("/config", async (c) => handleSetAllConfig(c.req.raw, c.env));

/** GET /config/:key — return a single config value. */
app.get("/config/:key", async (c) => handleGetConfig(c.env, c.req.param("key")));

/** PUT /config/:key — set a single config value. */
app.put("/config/:key", async (c) => handleSetConfig(c.req.raw, c.env, c.req.param("key")));

/** DELETE /config/:key — delete a single config value. */
app.delete("/config/:key", async (c) => handleDeleteConfig(c.env, c.req.param("key")));

/* ── Catch-all: serve static Astro assets ── */

/** All unmatched routes fall through to the ASSETS binding (Astro static output). */
app.all("*", async (c) => c.env.ASSETS.fetch(c.req.raw));

/* ── Worker export ── */

export default {
  /**
   * Main fetch handler — delegates to the Hono app.
   *
   * The Hono app composes:
   * 1. Auth middleware (WORKER_API_KEY via Secrets Store)
   * 2. Honi agent routes (chat, history, mcp via createAgent)
   * 3. Custom routes (voice, images, config, models)
   * 4. Static assets catch-all (Astro via ASSETS binding)
   */
  fetch: app.fetch,

  /**
   * Cron trigger — runs daily at midnight UTC to delete expired Cloudflare Images.
   *
   * KV image records have a 30-day TTL. This handler lists all `image:*`
   * keys, checks the `createdAt` timestamp, and deletes the corresponding
   * Cloudflare Images entry for records older than 30 days.
   */
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(cleanupExpiredImages(env));
  },
};
