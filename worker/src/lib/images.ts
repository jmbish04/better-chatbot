/**
 * Background image generation and Cloudflare Images lifecycle management.
 *
 * Provides:
 * - `generateBackgroundImage()` — generates an image via Workers AI (SDXL Lightning),
 *   optimizes it through the Images binding, uploads to Cloudflare Images API,
 *   and stores the record in KV. Falls back to raw KV bytes if secrets are unavailable.
 * - `cleanupExpiredImages()` — daily cron handler that deletes images older than
 *   30 days from Cloudflare Images API and KV.
 *
 * Secrets used (from Secret Store):
 * - `CLOUDFLARE_ACCOUNT_ID` — Cloudflare account ID for Images API
 * - `CLOUDFLARE_IMAGES_TOKEN` — API token for Cloudflare Images
 *
 * @module images
 */

import { storeImageRecord } from "./kv.js";

/** 30-day TTL in milliseconds, used by the cron cleanup job. */
const IMAGE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 30-day TTL in seconds, used for KV expiration. */
const KV_TTL_SECONDS = 60 * 60 * 24 * 30;

/**
 * Generate a contextual background image and store it in Cloudflare Images.
 *
 * Pipeline:
 * 1. Workers AI (SDXL Lightning) generates the image from a prompt
 * 2. Images binding optimizes/resizes to 1280px JPEG
 * 3. Cloudflare Images API uploads and stores the image
 * 4. KV stores the image ID + delivery URL for serving and cleanup
 *
 * Falls back to storing raw bytes in KV if Cloudflare Images secrets
 * are not configured.
 *
 * @returns The image URL (Cloudflare Images delivery URL or `/image/{threadId}`)
 */
export async function generateBackgroundImage(
  env: Env,
  threadId: string,
  prompt: string,
): Promise<string | null> {
  try {
    const imagePrompt = `Beautiful abstract background inspired by: ${prompt.slice(0, 150)}. Ethereal, soft gradients, subtle, suitable as a chat background, no text, artistic`;

    const imageStream = await env.AI.run(
      "@cf/bytedance/stable-diffusion-xl-lightning",
      { prompt: imagePrompt },
    );

    // Optimize via Images binding (transform + encode as JPEG)
    let imageData: ArrayBuffer;
    try {
      const optimized = await env.IMAGES.input(imageStream as ReadableStream)
        .transform({ width: 1280 })
        .output({ format: "image/jpeg" });
      const imgResponse = optimized.response();
      imageData = await imgResponse.arrayBuffer();
    } catch {
      if (imageStream instanceof ReadableStream) {
        const response = new Response(imageStream);
        imageData = await response.arrayBuffer();
      } else {
        return null;
      }
    }

    // Upload to Cloudflare Images via API
    let accountId: string | undefined;
    let imagesToken: string | undefined;
    try {
      accountId = await env.CLOUDFLARE_ACCOUNT_ID.get();
      imagesToken = await env.CLOUDFLARE_IMAGES_TOKEN.get();
    } catch (err) {
      console.warn("Failed to read Images secrets from Secret Store:", err);
    }

    if (accountId && imagesToken) {
      const formData = new FormData();
      formData.append(
        "file",
        new File([imageData], `bg-${threadId}.jpg`, { type: "image/jpeg" }),
      );

      const uploadRes = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/images/v1`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${imagesToken}` },
          body: formData,
        },
      );

      if (uploadRes.ok) {
        const uploadData = (await uploadRes.json()) as {
          result?: { id?: string; variants?: string[] };
        };
        const imageId = uploadData.result?.id;
        const deliveryUrl = uploadData.result?.variants?.[0];
        if (imageId && deliveryUrl) {
          await storeImageRecord(env, threadId, imageId, deliveryUrl);
          return deliveryUrl;
        }
      }
    }

    // Fallback: store raw bytes in KV
    await env.KV.put(`image:${threadId}`, imageData, {
      expirationTtl: KV_TTL_SECONDS,
    });
    return `/image/${threadId}`;
  } catch {
    return null;
  }
}

/**
 * Delete expired images from Cloudflare Images API.
 *
 * Called by the daily cron trigger. Lists all `image:*` keys in KV,
 * checks the `createdAt` timestamp, and deletes Cloudflare Images entries
 * older than 30 days. KV entries self-expire via TTL but are also deleted
 * proactively.
 */
export async function cleanupExpiredImages(env: Env): Promise<void> {
  let accountId: string | undefined;
  let imagesToken: string | undefined;
  try {
    accountId = await env.CLOUDFLARE_ACCOUNT_ID.get();
    imagesToken = await env.CLOUDFLARE_IMAGES_TOKEN.get();
  } catch (err) {
    console.warn("Cron cleanup: failed to read secrets from Secret Store:", err);
    return;
  }

  if (!accountId || !imagesToken) return;

  const now = Date.now();
  let cursor: string | undefined;

  do {
    const listResult = await env.KV.list({ prefix: "image:", cursor });

    for (const key of listResult.keys) {
      try {
        const data = await env.KV.get(key.name, "text");
        if (!data) continue;

        const record = JSON.parse(data) as {
          imageId?: string;
          createdAt?: string;
        };

        if (!record.imageId || !record.createdAt) continue;

        const age = now - new Date(record.createdAt).getTime();
        if (age >= IMAGE_TTL_MS) {
          await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${accountId}/images/v1/${record.imageId}`,
            {
              method: "DELETE",
              headers: { Authorization: `Bearer ${imagesToken}` },
            },
          );
          await env.KV.delete(key.name);
        }
      } catch (err) {
        console.warn(`Cron cleanup: failed to process ${key.name}:`, err);
      }
    }

    cursor = listResult.list_complete ? undefined : listResult.cursor;
  } while (cursor);
}
