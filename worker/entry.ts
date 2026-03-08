/**
 * Worker entry point — Honi-style agent on Cloudflare Workers.
 *
 * Implements the honidev agent pattern (createAgent / tool / streaming SSE)
 * directly on top of Workers AI + Durable Objects.
 *
 * Routes:
 *   POST /chat     → Send a message, stream a response (SSE)
 *   GET  /history  → Retrieve conversation history
 *   POST /reset    → Clear conversation memory
 *   *              → Static Astro assets (ASSETS binding)
 */

/* ── Types ── */

interface Env {
  AI: Ai;
  ASSETS: Fetcher;
  AGENT: DurableObjectNamespace;
}

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/* ── Agent configuration (mirrors honidev createAgent API) ── */

const AGENT_CONFIG = {
  name: "better-chatbot",
  model: "@cf/meta/llama-3.1-8b-instruct" as const,
  system: `You are a helpful, friendly chat assistant powered by Cloudflare Workers AI.
You run on Cloudflare's global edge network with zero cold starts.
Keep responses concise and helpful. Use markdown formatting when appropriate.
When asked about the time, use the current UTC time provided in your context.`,
};

/* ── Durable Object — ChatAgent ── */

export class ChatAgent implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

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

  private async handleChat(request: Request): Promise<Response> {
    const body = (await request.json()) as { message?: string };
    const userMessage = body.message?.trim();
    if (!userMessage) {
      return new Response(
        JSON.stringify({ error: "message is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const history =
      (await this.state.storage.get<ChatMessage[]>("messages")) ?? [];

    history.push({ role: "user", content: userMessage });

    const messages: ChatMessage[] = [
      { role: "system", content: AGENT_CONFIG.system },
      {
        role: "system",
        content: `Current UTC time: ${new Date().toISOString()}`,
      },
      ...history.slice(-20),
    ];

    const wantsStream =
      request.headers.get("Accept")?.includes("text/event-stream") ?? false;

    if (wantsStream) {
      return this.streamResponse(messages, history);
    }

    return this.plainResponse(messages, history);
  }

  private async streamResponse(
    messages: ChatMessage[],
    history: ChatMessage[],
  ): Promise<Response> {
    const ai = this.env.AI;
    const storage = this.state.storage;

    const stream = await ai.run(AGENT_CONFIG.model, {
      messages,
      stream: true,
    });

    const reader = (stream as ReadableStream).getReader();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let fullText = "";

    const readable = new ReadableStream({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          history.push({ role: "assistant", content: fullText });
          await storage.put("messages", history);
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

  private async plainResponse(
    messages: ChatMessage[],
    history: ChatMessage[],
  ): Promise<Response> {
    const result = (await this.env.AI.run(AGENT_CONFIG.model, {
      messages,
    })) as { response: string };

    const text = result.response ?? "";
    history.push({ role: "assistant", content: text });
    await this.state.storage.put("messages", history);

    return new Response(JSON.stringify({ response: text }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async handleHistory(): Promise<Response> {
    const messages =
      (await this.state.storage.get<ChatMessage[]>("messages")) ?? [];
    return new Response(JSON.stringify({ messages }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async handleReset(): Promise<Response> {
    await this.state.storage.delete("messages");
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }
}

/* ── Worker fetch handler ── */

const AGENT_PATHS = ["/chat", "/history", "/reset"];

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (AGENT_PATHS.some((p) => url.pathname === p)) {
      const threadId =
        request.headers.get("x-thread-id") ??
        url.searchParams.get("threadId") ??
        "default";
      const id = env.AGENT.idFromName(threadId);
      const agent = env.AGENT.get(id);
      return agent.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};
