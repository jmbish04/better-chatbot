/**
 * ChatAgent — Durable Object for persistent chat conversation management.
 *
 * Implements the chat agent pattern with:
 * - Persistent conversation memory via Durable Object storage
 * - Streaming SSE responses for Workers AI models
 * - Multi-provider AI Gateway routing (OpenAI, Anthropic, Google) with BYOK
 * - Thread isolation via `x-thread-id` header
 * - KV transcript persistence for 30-day retention
 *
 * Routes handled inside the DO:
 *   POST /chat    → Send message and get AI response (streaming or plain)
 *   GET  /history → Retrieve conversation history
 *   POST /reset   → Clear conversation memory
 *
 * The agent determines whether to use Workers AI directly or route through
 * the AI Gateway based on the model ID prefix (`@cf/` or `@hf/` = Workers AI).
 *
 * @module chat-agent
 */

import type { ChatMessage } from "../lib/types.js";
import { persistTranscript } from "../lib/kv.js";
import { GATEWAY_PROVIDERS } from "../lib/models.js";
import { getAllConfig } from "../lib/config.js";

/** Default system prompt used when no custom prompt is configured. */
const DEFAULT_SYSTEM_PROMPT = `You are a helpful, friendly chat assistant powered by Cloudflare Workers AI.
You run on Cloudflare's global edge network with zero cold starts.
Keep responses concise and helpful. Use markdown formatting when appropriate.
When asked about the time, use the current UTC time provided in your context.`;

/**
 * ChatAgent Durable Object — manages a single chat thread's conversation state.
 *
 * Each instance is identified by a thread ID and maintains its own message
 * history in Durable Object storage. Messages are also persisted to KV for
 * 30-day retention and cross-request access.
 */
export class ChatAgent implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  /** Route incoming requests to the appropriate handler. */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/chat" && request.method === "POST") {
      return this.handleChat(request);
    }
    if (url.pathname === "/history" && request.method === "GET") {
      return this.handleHistory();
    }
    if (url.pathname === "/reset" && request.method === "POST") {
      return this.handleReset();
    }

    return new Response("Not found", { status: 404 });
  }

  /**
   * Handle a chat message — route to Workers AI or AI Gateway provider.
   *
   * Reads the model ID from the request body. Models starting with `@cf/`
   * or `@hf/` are routed to Workers AI directly; all others are parsed as
   * `provider:model-id` and routed through the AI Gateway.
   */
  private async handleChat(request: Request): Promise<Response> {
    const body = (await request.json()) as { message?: string; model?: string };
    const userMessage = body.message?.trim();
    if (!userMessage) {
      return Response.json({ error: "message is required" }, { status: 400 });
    }

    const selectedModel = body.model || "@cf/meta/llama-3.1-8b-instruct";

    const history =
      (await this.state.storage.get<ChatMessage[]>("messages")) ?? [];

    history.push({ role: "user", content: userMessage });

    // Load system prompt from config
    let systemPrompt = DEFAULT_SYSTEM_PROMPT;
    try {
      const config = await getAllConfig(this.env);
      if (config.systemPrompt) {
        systemPrompt = config.systemPrompt;
      }
    } catch {
      // Use default on failure
    }

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "system", content: `Current UTC time: ${new Date().toISOString()}` },
      ...history.slice(-20),
    ];

    const wantsStream =
      request.headers.get("Accept")?.includes("text/event-stream") ?? false;

    const isWorkersAI = selectedModel.startsWith("@cf/") || selectedModel.startsWith("@hf/");

    if (isWorkersAI) {
      if (wantsStream) {
        return this.streamWorkersAI(messages, history, selectedModel);
      }
      return this.plainWorkersAI(messages, history, selectedModel);
    }

    return this.handleGatewayChat(messages, history, selectedModel, wantsStream);
  }

  /**
   * Stream a Workers AI response as SSE events.
   *
   * Emits `{ type: "text", text }` events as tokens arrive, then a
   * `{ type: "generateImage", prompt }` event on the first assistant
   * response to trigger background image generation on the frontend.
   */
  private async streamWorkersAI(
    messages: ChatMessage[],
    history: ChatMessage[],
    model: string,
  ): Promise<Response> {
    const ai = this.env.AI;
    const storage = this.state.storage;

    const stream = await ai.run(model as BaseAiTextGenerationModels, {
      messages,
      stream: true,
    });

    const reader = (stream as ReadableStream).getReader();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let fullText = "";
    const isFirst = history.filter(m => m.role === "assistant").length === 0;
    const chatEnv = this.env;
    const threadId = (await this.state.storage.get<string>("threadId")) ?? "default";

    const readable = new ReadableStream({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          history.push({ role: "assistant", content: fullText });
          await storage.put("messages", history);
          await persistTranscript(chatEnv, threadId, history);

          if (isFirst && fullText.length > 0) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: "generateImage", prompt: fullText.slice(0, 200) })}\n\n`,
              ),
            );
          }

          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          return;
        }

        const chunk = typeof value === "string" ? value : decoder.decode(value);
        const lines = chunk.split("\n");
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data);
            const text = parsed.response ?? "";
            if (text) {
              fullText += text;
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "text", text })}\n\n`,
                ),
              );
            }
          } catch {
            /* skip malformed */
          }
        }
      },
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  /** Handle a non-streaming Workers AI response. */
  private async plainWorkersAI(
    messages: ChatMessage[],
    history: ChatMessage[],
    model: string,
  ): Promise<Response> {
    const result = (await this.env.AI.run(model as BaseAiTextGenerationModels, {
      messages,
    })) as { response: string };

    const text = result.response ?? "";
    history.push({ role: "assistant", content: text });
    await this.state.storage.put("messages", history);

    const threadId = (await this.state.storage.get<string>("threadId")) ?? "default";
    await persistTranscript(this.env, threadId, history);

    return Response.json({ response: text });
  }

  /**
   * Route a chat request through the AI Gateway to an external provider.
   *
   * Parses the model format `provider:model-id` (e.g. `openai:gpt-4o`),
   * resolves the gateway URL, and forwards the request with BYOK auth.
   * Handles Anthropic's different message format automatically.
   */
  private async handleGatewayChat(
    messages: ChatMessage[],
    history: ChatMessage[],
    model: string,
    wantsStream: boolean,
  ): Promise<Response> {
    const [providerSlug, ...modelParts] = model.split(":");
    const modelId = modelParts.join(":");

    const provider = GATEWAY_PROVIDERS.find(p => p.slug === providerSlug);
    if (!provider) {
      return Response.json({ error: `Unknown provider: ${providerSlug}` }, { status: 400 });
    }

    const gatewayId = this.env.AI_GATEWAY_ID || "default-gateway";
    const gateway = this.env.AI.gateway(gatewayId);
    const baseUrl = await gateway.getUrl(providerSlug);

    let gatewayToken: string | undefined;
    try {
      gatewayToken = await this.env.CLOUDFLARE_AI_GATEWAY_TOKEN.get();
    } catch (err) {
      console.warn("Failed to read CLOUDFLARE_AI_GATEWAY_TOKEN from secret store:", err);
    }

    const isAnthropic = providerSlug === "anthropic";
    const requestBody = isAnthropic
      ? {
          model: modelId,
          max_tokens: 4096,
          system: messages.filter(m => m.role === "system").map(m => m.content).join("\n"),
          messages: messages.filter(m => m.role !== "system").map(m => ({
            role: m.role,
            content: m.content,
          })),
          stream: wantsStream,
        }
      : {
          model: modelId,
          messages: messages.map(m => ({ role: m.role, content: m.content })),
          stream: wantsStream,
        };

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (isAnthropic) {
      headers["anthropic-version"] = "2023-06-01";
    }
    if (gatewayToken) {
      headers["cf-aig-authorization"] = `Bearer ${gatewayToken}`;
    }

    const res = await fetch(baseUrl + provider.chatEndpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
    });

    if (!res.ok) {
      const errText = await res.text();
      return Response.json(
        { error: `Provider error: ${res.status} ${errText}` },
        { status: 502 },
      );
    }

    if (wantsStream && res.body) {
      return this.proxyGatewayStream(res.body, history, isAnthropic);
    }

    const data = await res.json() as Record<string, unknown>;
    let text = "";
    if (isAnthropic) {
      const content = (data as { content?: { text?: string }[] }).content;
      text = content?.[0]?.text ?? "";
    } else {
      const choices = (data as { choices?: { message?: { content?: string } }[] }).choices;
      text = choices?.[0]?.message?.content ?? "";
    }

    history.push({ role: "assistant", content: text });
    await this.state.storage.put("messages", history);
    const threadId = (await this.state.storage.get<string>("threadId")) ?? "default";
    await persistTranscript(this.env, threadId, history);

    return Response.json({ response: text });
  }

  /**
   * Proxy a streaming gateway response, normalizing to our SSE format.
   *
   * Handles both OpenAI-style (`choices[0].delta.content`) and Anthropic-style
   * (`content_block_delta.delta.text`) streaming formats.
   */
  private proxyGatewayStream(
    body: ReadableStream,
    history: ChatMessage[],
    isAnthropic: boolean,
  ): Response {
    const reader = body.getReader();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let fullText = "";
    const storage = this.state.storage;
    const env = this.env;

    const readable = new ReadableStream({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          history.push({ role: "assistant", content: fullText });
          await storage.put("messages", history);
          const threadId = (await storage.get<string>("threadId")) ?? "default";
          await persistTranscript(env, threadId, history);
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          return;
        }

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data);
            let text = "";
            if (isAnthropic) {
              if (parsed.type === "content_block_delta" && parsed.delta?.text) {
                text = parsed.delta.text;
              }
            } else {
              text = parsed.choices?.[0]?.delta?.content ?? "";
            }
            if (text) {
              fullText += text;
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "text", text })}\n\n`,
                ),
              );
            }
          } catch {
            /* skip malformed */
          }
        }
      },
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  /** Return the full conversation history. */
  private async handleHistory(): Promise<Response> {
    const messages =
      (await this.state.storage.get<ChatMessage[]>("messages")) ?? [];
    return Response.json({ messages });
  }

  /** Clear all conversation memory for this thread. */
  private async handleReset(): Promise<Response> {
    await this.state.storage.delete("messages");
    return Response.json({ ok: true });
  }
}
