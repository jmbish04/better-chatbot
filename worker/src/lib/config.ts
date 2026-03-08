/**
 * Config settings API — persists user preferences in KV.
 *
 * Provides CRUD endpoints for application configuration stored in KV
 * under the `config:` prefix. Settings include system prompt, default
 * model, theme, and any other key/value pairs the frontend needs.
 *
 * KV key format: `config:{key}` (no TTL — config persists indefinitely).
 * A master key `config:__all__` stores the full settings object for
 * efficient bulk reads.
 *
 * API routes (registered in entry.ts):
 *   GET  /config           → Get all config settings
 *   GET  /config/:key      → Get a single config value
 *   PUT  /config/:key      → Set a single config value
 *   DELETE /config/:key    → Delete a single config value
 *   PUT  /config           → Replace all config settings (bulk)
 *
 * @module config
 */

/** Default config values applied when no settings exist yet. */
const DEFAULT_CONFIG: Record<string, string> = {
  systemPrompt: "You are a helpful, friendly chat assistant powered by Cloudflare Workers AI.\nYou run on Cloudflare's global edge network with zero cold starts.\nKeep responses concise and helpful. Use markdown formatting when appropriate.\nWhen asked about the time, use the current UTC time provided in your context.",
  defaultModel: "@cf/meta/llama-3.1-8b-instruct",
  theme: "system",
};

/** The KV key that stores the full config object. */
const CONFIG_KEY = "config:__all__";

/**
 * Get all config settings from KV, merged with defaults.
 *
 * Returns the full settings object as JSON.
 */
export async function getAllConfig(env: Env): Promise<Record<string, string>> {
  try {
    const raw = await env.KV.get(CONFIG_KEY, "text");
    if (!raw) return { ...DEFAULT_CONFIG };
    const stored = JSON.parse(raw) as Record<string, string>;
    return { ...DEFAULT_CONFIG, ...stored };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Get a single config value by key.
 *
 * Falls back to the default value if the key is not set.
 */
export async function getConfigValue(env: Env, key: string): Promise<string | null> {
  const all = await getAllConfig(env);
  return all[key] ?? null;
}

/**
 * Set a single config value and persist the full object to KV.
 */
export async function setConfigValue(env: Env, key: string, value: string): Promise<void> {
  const all = await getAllConfig(env);
  all[key] = value;
  await env.KV.put(CONFIG_KEY, JSON.stringify(all));
}

/**
 * Delete a single config key and persist the updated object to KV.
 */
export async function deleteConfigValue(env: Env, key: string): Promise<void> {
  const all = await getAllConfig(env);
  delete all[key];
  await env.KV.put(CONFIG_KEY, JSON.stringify(all));
}

/**
 * Replace all config settings with the provided object.
 *
 * Merges with defaults to ensure required keys always exist.
 */
export async function setAllConfig(env: Env, config: Record<string, string>): Promise<void> {
  const merged = { ...DEFAULT_CONFIG, ...config };
  await env.KV.put(CONFIG_KEY, JSON.stringify(merged));
}

/* ── Hono route handlers ── */

/**
 * Handle GET /config — return all config settings.
 */
export async function handleGetAllConfig(env: Env): Promise<Response> {
  const config = await getAllConfig(env);
  return Response.json(config);
}

/**
 * Handle GET /config/:key — return a single config value.
 */
export async function handleGetConfig(env: Env, key: string): Promise<Response> {
  const value = await getConfigValue(env, key);
  if (value === null) {
    return Response.json({ error: `Config key '${key}' not found` }, { status: 404 });
  }
  return Response.json({ key, value });
}

/**
 * Handle PUT /config/:key — set a single config value.
 *
 * Expects JSON body `{ value: string }`.
 */
export async function handleSetConfig(request: Request, env: Env, key: string): Promise<Response> {
  const body = (await request.json()) as { value?: string };
  if (body.value === undefined) {
    return Response.json({ error: "value is required" }, { status: 400 });
  }
  await setConfigValue(env, key, String(body.value));
  return Response.json({ ok: true, key, value: body.value });
}

/**
 * Handle DELETE /config/:key — delete a single config value.
 */
export async function handleDeleteConfig(env: Env, key: string): Promise<Response> {
  await deleteConfigValue(env, key);
  return Response.json({ ok: true, key });
}

/**
 * Handle PUT /config — replace all config settings (bulk).
 *
 * Expects JSON body with key/value pairs.
 */
export async function handleSetAllConfig(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as Record<string, string>;
  if (typeof body !== "object" || body === null) {
    return Response.json({ error: "Expected JSON object" }, { status: 400 });
  }
  await setAllConfig(env, body);
  const updated = await getAllConfig(env);
  return Response.json(updated);
}
