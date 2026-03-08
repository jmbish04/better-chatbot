/**
 * Worker entrypoint — Hono app with hono-agents middleware.
 *
 * This is the main entry point for the Cloudflare Worker. It uses Hono
 * for HTTP routing and hono-agents middleware for Cloudflare Agents SDK
 * integration (routing requests to the ChatAgent Durable Object).
 *
 * Route map:
 *   POST /auth             → Verify password, set auth cookie
 *   GET  /auth/check       → Check if user is authenticated
 *   GET  /models           → List available models grouped by provider
 *   POST /voice/stt        → Speech-to-text (Whisper)
 *   POST /voice/tts        → Text-to-speech (MeloTTS)
 *   POST /generate-image   → Generate background image → Cloudflare Images
 *   GET  /image/:key       → Redirect to Cloudflare Images delivery URL
 *   POST /chat             → ChatAgent DO: send message (SSE streaming)
 *   GET  /history          → ChatAgent DO: retrieve conversation history
 *   POST /reset            → ChatAgent DO: clear conversation memory
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
 * All API routes (except /auth and static assets) require authentication
 * when WORKER_API_KEY is configured in the Secrets Store.
 *
 * @module entry
 */

import { Hono } from "hono";
import { cors } from "hono/cors";

/* ── Re-export the ChatAgent DO class so wrangler can find it ── */
export { ChatAgent } from "./src/agents/chat-agent.js";

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
  "/config",
  "/config/*",
];

for (const path of protectedPaths) {
  app.use(path, authGuard);
}

/**
 * Auth guard middleware — rejects unauthenticated requests with 401.
 *
 * Skips auth check if WORKER_API_KEY is not configured.
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
app.post("/voice/stt", async (c) => {
  return handleSTT(c.req.raw, c.env);
});

/** POST /voice/tts — text-to-speech via MeloTTS. */
app.post("/voice/tts", async (c) => {
  return handleTTS(c.req.raw, c.env);
});

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

/* ── Agent paths (chat, history, reset) → ChatAgent Durable Object ── */

/**
 * Route a request to the ChatAgent Durable Object.
 *
 * Uses the `x-thread-id` header or `threadId` query parameter to determine
 * which DO instance to route to. Defaults to "default" if not specified.
 */
function routeToAgent(c: { env: Env; req: { raw: Request; header: (name: string) => string | undefined; query: (name: string) => string | undefined } }): Promise<Response> {
  const threadId =
    c.req.header("x-thread-id") ??
    c.req.query("threadId") ??
    "default";
  const id = c.env.AGENT.idFromName(threadId);
  const agent = c.env.AGENT.get(id);
  return agent.fetch(c.req.raw);
}

/** POST /chat — route to ChatAgent DO for message handling. */
app.post("/chat", async (c) => routeToAgent(c));

/** GET /history — route to ChatAgent DO for history retrieval. */
app.get("/history", async (c) => routeToAgent(c));

/** POST /reset — route to ChatAgent DO for memory reset. */
app.post("/reset", async (c) => routeToAgent(c));

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
   */
  fetch: app.fetch,

  /**
   * Cron trigger — runs daily at midnight UTC to delete expired Cloudflare Images.
   *
   * KV image records have a 30-day TTL. This handler lists all `image:*`
   * keys, checks the `createdAt` timestamp, and deletes the corresponding
   * Cloudflare Images entry for records older than 30 days. KV handles
   * its own expiration, so we only need to clean up the Images API side.
   */
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(cleanupExpiredImages(env));
  },
};
