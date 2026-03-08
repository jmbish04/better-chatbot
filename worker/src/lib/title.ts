/**
 * Thread title generation via Workers AI.
 *
 * Uses the fast `@cf/meta/llama-3.1-8b-instruct` model to produce a short
 * (3–6 word) title summarising the user's first message in a thread.
 * Falls back to "New Chat" on any error so title generation is never blocking.
 *
 * @module title
 */

/**
 * Ask Workers AI to generate a concise thread title from the first user message.
 *
 * @param env   Worker environment (needs `AI` binding)
 * @param message  The first user message in the thread
 * @returns A short title string, or "New Chat" on failure
 */
export async function generateThreadTitle(env: Env, message: string): Promise<string> {
  try {
    const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct" as Parameters<typeof env.AI.run>[0], {
      messages: [
        {
          role: "system",
          content:
            "Generate a short, concise title (3 to 6 words) for a chat conversation based on the user's first message. " +
            "Return only the title text — no quotes, no punctuation at the end, no explanation.",
        },
        { role: "user", content: message.slice(0, 500) },
      ],
      max_tokens: 24,
    } as Parameters<typeof env.AI.run>[1]);

    const title = (result as { response?: string }).response?.trim();
    return title && title.length > 0 ? title : "New Chat";
  } catch {
    return "New Chat";
  }
}
