/**
 * ChatAgent — Honi agent for persistent multi-provider chat.
 *
 * Uses honidev's `createAgent()` to create a Durable Object-backed chat agent
 * with persistent memory, streaming responses, and multi-provider LLM support
 * via the Vercel AI SDK.
 *
 * The agent is configured with:
 * - Workers AI model as default (`@cf/meta/llama-3.1-8b-instruct`)
 * - Durable Object working memory (enabled)
 * - Bound to the `AGENT` DO namespace
 *
 * Routes handled by the agent (via honidev internally):
 *   POST /chat            → Send message, get streaming AI response
 *   GET  /history         → Retrieve conversation history
 *   DELETE /history       → Clear conversation memory
 *   POST /mcp             → MCP server endpoint for tool exposure
 *   GET  /mcp/tools       → List available tools
 *
 * The agent uses honidev's `resolveModel()` which auto-routes based on
 * model ID prefix:
 *   - `@cf/*`     → Workers AI (via @ai-sdk/cloudflare binding)
 *   - `claude-*`  → Anthropic
 *   - `gpt-*`     → OpenAI
 *   - `gemini-*`  → Google
 *
 * For AI Gateway BYOK routing (openai:*, anthropic:*, google-ai-studio:*),
 * the main entry.ts handles those via direct fetch to gateway URLs before
 * they reach the honidev agent.
 *
 * @module chat-agent
 */

import { createAgent } from "honidev";

/** Default system prompt for the chat agent. */
const SYSTEM_PROMPT = `You are a helpful, friendly chat assistant powered by Cloudflare Workers AI.
You run on Cloudflare's global edge network with zero cold starts.
Keep responses concise and helpful. Use markdown formatting when appropriate.
When asked about the time, use the current UTC time provided in your context.
Current UTC time: ${new Date().toISOString()}`;

/**
 * Create the Honi chat agent.
 *
 * Returns `{ fetch, DurableObject }`:
 * - `fetch` — Hono-based HTTP handler for /chat, /history, /mcp routes
 * - `DurableObject` — The DO class to export from entry.ts
 */
export const chatAgent = createAgent({
  name: "better-chatbot",
  model: "@cf/meta/llama-3.1-8b-instruct",
  system: SYSTEM_PROMPT,
  memory: { enabled: true },
  binding: "AGENT",
  maxSteps: 10,
});

/**
 * The ChatAgent Durable Object class.
 *
 * Export this from entry.ts so wrangler can register it:
 * ```ts
 * export const ChatAgent = chatAgent.DurableObject;
 * ```
 */
export const ChatAgentDO = chatAgent.DurableObject;
