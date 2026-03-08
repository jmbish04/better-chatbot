# Better Chatbot — Cloudflare Workers

A chat experience powered by a **Honi-style agent** running on [Cloudflare Workers](https://developers.cloudflare.com/workers/) with [Workers AI](https://developers.cloudflare.com/workers-ai/). The frontend is built with [Astro](https://astro.build/) and served from [Worker assets](https://developers.cloudflare.com/workers/static-assets/) (NOT Cloudflare Pages).

## Architecture

```
┌──────────────────────────────────────────────┐
│                Cloudflare Worker              │
│                                              │
│  ┌──────────────┐    ┌────────────────────┐  │
│  │ Static Assets │    │  ChatAgent (DO)    │  │
│  │ (Astro SSG)  │    │  · Workers AI      │  │
│  │              │    │  · Conversation     │  │
│  │ index.html   │    │    memory           │  │
│  │ _astro/*.js  │    │  · Streaming SSE    │  │
│  └──────────────┘    └────────────────────┘  │
│         ↑                     ↑              │
│         │                     │              │
│    env.ASSETS.fetch     env.AGENT (DO)       │
│         │                     │              │
│         └──── Worker fetch ───┘              │
│               handler                        │
└──────────────────────────────────────────────┘
```

- **Frontend** — Astro (static site generation) with a React island for the interactive chat UI.
- **Backend** — A Durable Object (`ChatAgent`) implementing the [Honi agent pattern](../SKILLS/honi-agents/SKILL.md): persistent conversation memory, streaming SSE responses, and thread isolation via `x-thread-id` header.
- **AI** — `@cf/meta/llama-3.1-8b-instruct` via the Workers AI binding. No API keys required.
- **Serving** — Worker assets (`[assets]` in `wrangler.toml`) serve the Astro output at the edge. NOT Cloudflare Pages.

## API Endpoints

| Endpoint     | Method | Description                        |
| ------------ | ------ | ---------------------------------- |
| `POST /chat` | POST   | Send a message, stream a response  |
| `GET /history` | GET  | Retrieve conversation history      |
| `POST /reset` | POST  | Clear conversation memory          |
| `/*`         | GET    | Static Astro assets                |

Thread isolation is supported via the `x-thread-id` header or `?threadId=` query parameter.

## Development

```bash
cd worker

# Install dependencies
npm install

# Build the Astro frontend
npm run build

# Start local dev server (requires CLOUDFLARE_API_TOKEN for AI binding)
npm run dev
```

## Deployment

```bash
# Build and deploy to Cloudflare Workers
npm run deploy
```

This runs `astro build` (generates static assets to `dist/`) followed by `wrangler deploy` (uploads Worker + assets).

## Configuration

See `wrangler.toml` for the full Worker configuration:

- `main` — Worker entry point (`./entry.ts`)
- `[assets]` — Astro build output served from the edge
- `[ai]` — Workers AI binding for LLM inference
- `[[durable_objects.bindings]]` — ChatAgent Durable Object for persistent chat
- `[observability]` — Enabled for monitoring

## Key Files

| File | Purpose |
| ---- | ------- |
| `entry.ts` | Worker entry point; routes requests to agent or assets |
| `wrangler.toml` | Cloudflare Workers configuration |
| `astro.config.mjs` | Astro framework configuration (SSG + React) |
| `src/pages/index.astro` | Chat page (Astro) |
| `src/components/Chat.tsx` | Interactive chat UI (React island) |
| `src/layouts/Layout.astro` | Page layout with dark theme |
