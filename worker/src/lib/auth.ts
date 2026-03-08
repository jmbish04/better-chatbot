/**
 * Authentication middleware and helpers for the Worker API.
 *
 * Implements simple password-based auth using a shared secret stored in
 * the Secrets Store (`WORKER_API_KEY` binding). On successful verification,
 * sets an `__auth` cookie (HttpOnly, Secure, SameSite=Strict, 30-day expiry)
 * so the user doesn't need to re-authenticate on every page load.
 *
 * The frontend presents a password prompt with autofill disabled. All API
 * routes (except `/auth` and static assets) are protected by the auth check.
 *
 * @module auth
 */

/** Cookie name for the auth session token. */
const AUTH_COOKIE = "__auth";

/** Cookie max-age: 30 days in seconds. */
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

/**
 * Verify the auth cookie against the stored API key.
 *
 * The cookie value is a hex-encoded SHA-256 hash of the API key.
 * This avoids storing the raw key in the cookie while still allowing
 * stateless verification.
 *
 * @returns true if the request has a valid auth cookie
 */
export async function isAuthenticated(request: Request, env: Env): Promise<boolean> {
  const cookie = parseCookie(request.headers.get("Cookie") ?? "", AUTH_COOKIE);
  if (!cookie) return false;

  let apiKey: string;
  try {
    apiKey = await env.WORKER_API_KEY.get();
  } catch {
    // If secret store is unavailable, skip auth (development mode)
    return true;
  }

  if (!apiKey) return true; // No key configured = no auth required

  const expectedHash = await hashKey(apiKey);
  return cookie === expectedHash;
}

/**
 * Handle a POST /auth request — verify the password and set an auth cookie.
 *
 * Expects JSON body `{ password: string }`.
 * Returns 200 with Set-Cookie on success, 401 on failure.
 */
export async function handleAuth(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { password?: string };
  const password = body.password?.trim();

  if (!password) {
    return Response.json({ error: "Password is required" }, { status: 400 });
  }

  let apiKey: string;
  try {
    apiKey = await env.WORKER_API_KEY.get();
  } catch {
    return Response.json({ error: "Auth not configured" }, { status: 500 });
  }

  if (!apiKey) {
    return Response.json({ error: "Auth not configured" }, { status: 500 });
  }

  if (password !== apiKey) {
    return Response.json({ error: "Invalid password" }, { status: 401 });
  }

  const hash = await hashKey(apiKey);
  const isSecure = new URL(request.url).protocol === "https:";

  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": [
        `${AUTH_COOKIE}=${hash}`,
        `Max-Age=${COOKIE_MAX_AGE}`,
        "Path=/",
        "HttpOnly",
        "SameSite=Strict",
        isSecure ? "Secure" : "",
      ].filter(Boolean).join("; "),
    },
  });
}

/**
 * Check if auth is required (i.e., WORKER_API_KEY is configured).
 *
 * @returns true if a WORKER_API_KEY secret is set and non-empty
 */
export async function isAuthRequired(env: Env): Promise<boolean> {
  try {
    const key = await env.WORKER_API_KEY.get();
    return !!key;
  } catch {
    return false;
  }
}

/* ── Helpers ── */

/** Parse a specific cookie value from a Cookie header string. */
function parseCookie(header: string, name: string): string | null {
  const match = header.split(";").map(s => s.trim()).find(s => s.startsWith(`${name}=`));
  return match ? match.slice(name.length + 1) : null;
}

/** SHA-256 hash a string and return hex-encoded digest. */
async function hashKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}
