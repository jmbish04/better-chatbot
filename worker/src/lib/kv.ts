/**
 * KV persistence helpers for chat transcripts and image records.
 *
 * Provides two functions:
 * - `persistTranscript` — stores the full chat history under `transcript:{threadId}`
 * - `storeImageRecord` — stores Cloudflare Images metadata under `image:{threadId}`
 *
 * Both use 30-day TTLs. Write failures are caught and logged so they never
 * break the chat flow.
 *
 * @module kv
 */

import type { ChatMessage, ImageRecord } from "./types.js";

/** TTL for all KV entries: 30 days in seconds. */
const KV_TTL_SECONDS = 60 * 60 * 24 * 30;

/**
 * Persist the full chat transcript to KV with a 30-day TTL.
 *
 * Key format: `transcript:{threadId}`
 * Value: JSON with threadId, messages array, and updatedAt timestamp.
 */
export async function persistTranscript(
  env: Env,
  threadId: string,
  messages: ChatMessage[],
): Promise<void> {
  try {
    await env.KV.put(
      `transcript:${threadId}`,
      JSON.stringify({ threadId, messages, updatedAt: new Date().toISOString() }),
      { expirationTtl: KV_TTL_SECONDS },
    );
  } catch {
    // KV write failures shouldn't break chat
  }
}

/**
 * Store a Cloudflare Images record in KV with a 30-day TTL.
 *
 * Key format: `image:{threadId}`
 * Value: JSON with imageId (for cleanup), delivery URL, and createdAt timestamp.
 */
export async function storeImageRecord(
  env: Env,
  threadId: string,
  imageId: string,
  deliveryUrl: string,
): Promise<void> {
  try {
    const record: ImageRecord = {
      imageId,
      url: deliveryUrl,
      createdAt: new Date().toISOString(),
    };
    await env.KV.put(
      `image:${threadId}`,
      JSON.stringify(record),
      { expirationTtl: KV_TTL_SECONDS },
    );
  } catch {
    // KV write failures shouldn't break chat
  }
}
