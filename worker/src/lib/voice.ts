/**
 * Voice chat handlers: speech-to-text (STT) and text-to-speech (TTS).
 *
 * Provides:
 * - `handleSTT()` — transcribes audio using Workers AI Whisper model
 * - `handleTTS()` — synthesizes speech using Workers AI MeloTTS model
 *
 * Both functions accept a Request and Env, returning a Response directly.
 * Used by the Hono route handlers in entry.ts.
 *
 * @module voice
 */

/**
 * Transcribe audio to text using `@cf/openai/whisper-large-v3-turbo`.
 *
 * Expects raw audio bytes in the request body.
 * Returns JSON `{ text: string }` on success.
 */
export async function handleSTT(request: Request, env: Env): Promise<Response> {
  try {
    const audioData = await request.arrayBuffer();
    if (audioData.byteLength === 0) {
      return Response.json({ error: "No audio data provided" }, { status: 400 });
    }

    const result = await env.AI.run("@cf/openai/whisper-large-v3-turbo", {
      audio: [...new Uint8Array(audioData)],
    }) as { text?: string };

    return Response.json({ text: result.text ?? "" });
  } catch (err) {
    return Response.json(
      { error: `STT failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
}

/**
 * Synthesize speech from text using `@cf/myshell-ai/melotts`.
 *
 * Expects JSON body `{ text: string, voice?: string }`.
 * Returns audio/wav stream on success.
 */
export async function handleTTS(request: Request, env: Env): Promise<Response> {
  try {
    const body = (await request.json()) as { text?: string; voice?: string };
    const text = body.text?.trim();
    if (!text) {
      return Response.json({ error: "text is required" }, { status: 400 });
    }

    const audio = await env.AI.run("@cf/myshell-ai/melotts", {
      text,
      language: "en",
    });

    const headers = {
      "Content-Type": "audio/wav",
      "Cache-Control": "public, max-age=3600",
    };

    if (audio instanceof ReadableStream) {
      return new Response(audio, { headers });
    }

    return new Response(audio as BodyInit, { headers });
  } catch (err) {
    return Response.json(
      { error: `TTS failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
}
