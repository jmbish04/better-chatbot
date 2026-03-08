/**
 * Model registry and listing for the model selector dropdown.
 *
 * Provides:
 * - `WORKERS_AI_MODELS` — static registry of Workers AI models grouped by provider
 * - `GATEWAY_PROVIDERS` — AI Gateway provider definitions (OpenAI, Anthropic, Google)
 * - `listModels()` — fetches and merges Workers AI + gateway provider models,
 *   filtering out embeddings/moderation and categorizing vision models
 *
 * Gateway models are fetched dynamically via the AI Gateway URL with BYOK auth.
 * Static fallbacks are used when the gateway token is not configured or the
 * provider API is unreachable.
 *
 * @module models
 */

import type { ModelInfo, ProviderGroup } from "./types.js";

/* ── Workers AI models registry ── */

/** Static list of Workers AI models, grouped by author/provider. */
export const WORKERS_AI_MODELS: ModelInfo[] = [
  // Meta
  { id: "@cf/meta/llama-3.1-8b-instruct", name: "Llama 3.1 8B Instruct", provider: "Meta", category: "chat", supportsStreaming: true },
  { id: "@cf/meta/llama-3.1-70b-instruct", name: "Llama 3.1 70B Instruct", provider: "Meta", category: "chat", supportsStreaming: true },
  { id: "@cf/meta/llama-3.2-1b-instruct", name: "Llama 3.2 1B Instruct", provider: "Meta", category: "chat", supportsStreaming: true },
  { id: "@cf/meta/llama-3.2-3b-instruct", name: "Llama 3.2 3B Instruct", provider: "Meta", category: "chat", supportsStreaming: true },
  { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", name: "Llama 3.3 70B Instruct", provider: "Meta", category: "chat", supportsStreaming: true },
  { id: "@cf/meta/llama-4-scout-17b-16e-instruct", name: "Llama 4 Scout 17B", provider: "Meta", category: "chat", supportsStreaming: true },
  // Google
  { id: "@hf/google/gemma-7b-it", name: "Gemma 7B", provider: "Google", category: "chat", supportsStreaming: true },
  // Mistral
  { id: "@cf/mistral/mistral-7b-instruct-v0.2", name: "Mistral 7B Instruct v0.2", provider: "Mistral", category: "chat", supportsStreaming: true },
  // Qwen
  { id: "@cf/qwen/qwen2.5-coder-32b-instruct", name: "Qwen 2.5 Coder 32B", provider: "Qwen", category: "code", supportsStreaming: true },
  // DeepSeek
  { id: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b", name: "DeepSeek R1 Distill 32B", provider: "DeepSeek", category: "chat", supportsStreaming: true },
  // Image generation
  { id: "@cf/bytedance/stable-diffusion-xl-lightning", name: "SDXL Lightning", provider: "ByteDance", category: "image", supportsStreaming: false },
  { id: "@cf/black-forest-labs/flux-1-schnell", name: "FLUX.1 Schnell", provider: "Black Forest Labs", category: "image", supportsStreaming: false },
  // Vision
  { id: "@cf/meta/llama-3.2-11b-vision-instruct", name: "Llama 3.2 11B Vision", provider: "Meta", category: "vision", supportsStreaming: true },
  // Audio
  { id: "@cf/openai/whisper-large-v3-turbo", name: "Whisper Large v3 Turbo", provider: "OpenAI", category: "audio", supportsStreaming: false },
  { id: "@cf/myshell-ai/melotts", name: "MeloTTS", provider: "MyShell AI", category: "audio", supportsStreaming: false },
];

/* ── Gateway provider definitions ── */

/** AI Gateway provider configs for multi-provider routing. */
export const GATEWAY_PROVIDERS: {
  slug: string;
  name: string;
  chatEndpoint: string;
  modelListEndpoint?: string;
  modelsPath?: string;
}[] = [
  {
    slug: "openai",
    name: "OpenAI",
    chatEndpoint: "/v1/chat/completions",
    modelListEndpoint: "/v1/models",
    modelsPath: "data",
  },
  {
    slug: "anthropic",
    name: "Anthropic",
    chatEndpoint: "/v1/messages",
  },
  {
    slug: "google-ai-studio",
    name: "Google (Gemini)",
    chatEndpoint: "/v1/chat/completions",
    modelListEndpoint: "/v1/models",
    modelsPath: "data",
  },
];

/* ── Category filter for gateway models ── */

/**
 * Classify a model ID into a category for the dropdown, or return null to exclude it.
 *
 * Filters out embeddings, moderation, TTS, Whisper, and DALL-E models.
 * Vision and code models are categorized separately.
 */
export function categorizeModel(modelId: string): ModelInfo["category"] | null {
  const lower = modelId.toLowerCase();
  if (lower.includes("embedding") || lower.includes("embed")) return null;
  if (lower.includes("moderation")) return null;
  if (lower.includes("tts") || lower.includes("whisper") || lower.includes("audio")) return null;
  if (lower.includes("dall-e") || lower.includes("image") || lower.includes("flux") || lower.includes("stable-diffusion")) return "image";
  if (lower.includes("vision") || lower.includes("llava")) return "vision";
  if (lower.includes("code") || lower.includes("codex")) return "code";
  return "chat";
}

/* ── Static fallback models ── */

/**
 * Return hardcoded models for a gateway provider when the API is unreachable
 * or the gateway token is not configured.
 */
function getStaticFallbackModels(slug: string, name: string): ProviderGroup {
  switch (slug) {
    case "openai":
      return {
        provider: name,
        slug,
        models: [
          { id: "openai:gpt-4o", name: "GPT-4o", provider: "OpenAI", category: "chat", supportsStreaming: true },
          { id: "openai:gpt-4o-mini", name: "GPT-4o Mini", provider: "OpenAI", category: "chat", supportsStreaming: true },
          { id: "openai:gpt-4.1", name: "GPT-4.1", provider: "OpenAI", category: "chat", supportsStreaming: true },
          { id: "openai:gpt-4.1-mini", name: "GPT-4.1 Mini", provider: "OpenAI", category: "chat", supportsStreaming: true },
        ],
      };
    case "google-ai-studio":
      return {
        provider: name,
        slug,
        models: [
          { id: "google-ai-studio:gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "Google", category: "chat", supportsStreaming: true },
          { id: "google-ai-studio:gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "Google", category: "chat", supportsStreaming: true },
        ],
      };
    default:
      return { provider: name, slug, models: [] };
  }
}

/* ── Model listing ── */

/**
 * Fetch and merge all available models from Workers AI and gateway providers.
 *
 * Workers AI models are grouped by author/provider from the static registry.
 * Gateway provider models are fetched dynamically via AI Gateway URLs with
 * BYOK token auth; falls back to static lists on failure.
 *
 * Excludes embeddings, moderation, TTS, and audio-only models from the dropdown.
 */
export async function listModels(env: Env): Promise<ProviderGroup[]> {
  const groups: ProviderGroup[] = [];

  // 1. Workers AI models grouped by provider
  const workersAiByProvider = new Map<string, ModelInfo[]>();
  for (const model of WORKERS_AI_MODELS) {
    if (model.category === "chat" || model.category === "code" || model.category === "vision") {
      const existing = workersAiByProvider.get(model.provider) ?? [];
      existing.push(model);
      workersAiByProvider.set(model.provider, existing);
    }
  }

  for (const [provider, models] of workersAiByProvider) {
    groups.push({ provider: `Workers AI / ${provider}`, slug: "workers-ai", models });
  }

  // 2. Gateway providers — try to list models from each
  const gatewayId = env.AI_GATEWAY_ID || "default-gateway";

  let gatewayToken: string | undefined;
  try {
    gatewayToken = await env.CLOUDFLARE_AI_GATEWAY_TOKEN.get();
  } catch (err) {
    console.warn("Failed to read CLOUDFLARE_AI_GATEWAY_TOKEN from secret store:", err);
  }

  for (const provider of GATEWAY_PROVIDERS) {
    if (!provider.modelListEndpoint) {
      if (provider.slug === "anthropic") {
        groups.push({
          provider: provider.name,
          slug: provider.slug,
          models: [
            { id: "anthropic:claude-sonnet-4-20250514", name: "Claude Sonnet 4", provider: "Anthropic", category: "chat", supportsStreaming: true },
            { id: "anthropic:claude-haiku-3-5-20241022", name: "Claude 3.5 Haiku", provider: "Anthropic", category: "chat", supportsStreaming: true },
          ],
        });
      }
      continue;
    }

    try {
      const gateway = env.AI.gateway(gatewayId);
      const baseUrl = await gateway.getUrl(provider.slug);
      const fetchHeaders: Record<string, string> = { "Content-Type": "application/json" };
      if (gatewayToken) {
        fetchHeaders["cf-aig-authorization"] = `Bearer ${gatewayToken}`;
      }
      const res = await fetch(baseUrl + provider.modelListEndpoint, { headers: fetchHeaders });

      if (!res.ok) {
        groups.push(getStaticFallbackModels(provider.slug, provider.name));
        continue;
      }

      const data = await res.json() as Record<string, unknown>;
      const modelList = (provider.modelsPath
        ? (data as Record<string, unknown[]>)[provider.modelsPath]
        : data) as { id: string; name?: string }[];

      if (!Array.isArray(modelList)) {
        groups.push(getStaticFallbackModels(provider.slug, provider.name));
        continue;
      }

      const filtered: ModelInfo[] = [];
      for (const m of modelList) {
        const cat = categorizeModel(m.id);
        if (cat === null) continue;
        filtered.push({
          id: `${provider.slug}:${m.id}`,
          name: m.name ?? m.id,
          provider: provider.name,
          category: cat,
          supportsStreaming: true,
        });
      }

      if (filtered.length > 0) {
        groups.push({ provider: provider.name, slug: provider.slug, models: filtered });
      } else {
        groups.push(getStaticFallbackModels(provider.slug, provider.name));
      }
    } catch {
      groups.push(getStaticFallbackModels(provider.slug, provider.name));
    }
  }

  return groups;
}
