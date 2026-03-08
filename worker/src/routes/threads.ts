/**
 * Thread management API — Hono router with Zod-validated responses.
 *
 * Routes:
 *   GET    /threads      → list all threads (newest first)
 *   GET    /threads/:id  → get one thread + its messages
 *   DELETE /threads/:id  → delete thread (cascades to messages)
 *
 * @module routes/threads
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { eq, desc } from "drizzle-orm";
import { z } from "zod";
import { getDb, threads, messages } from "../backend/db/index.js";

type HonoEnv = { Bindings: Env };

/* ── Zod schemas ── */

export const ThreadSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const MessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  createdAt: z.number(),
});

export const ThreadWithMessagesSchema = ThreadSchema.extend({
  messages: z.array(MessageSchema),
});

const IdParamSchema = z.object({ id: z.string().uuid() });

/* ── Router ── */

export const threadsRouter = new Hono<HonoEnv>();

/** GET /threads — return all threads sorted by updatedAt descending. */
threadsRouter.get("/", async (c) => {
  const db = getDb(c.env);
  const rows = await db.select().from(threads).orderBy(desc(threads.updatedAt));
  const parsed = z.array(ThreadSchema).parse(rows);
  return c.json({ threads: parsed });
});

/** GET /threads/:id — return a single thread with all its messages. */
threadsRouter.get(
  "/:id",
  zValidator("param", IdParamSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const db = getDb(c.env);

    const thread = await db.select().from(threads).where(eq(threads.id, id)).get();
    if (!thread) return c.json({ error: "Thread not found" }, 404);

    const msgs = await db
      .select()
      .from(messages)
      .where(eq(messages.threadId, id))
      .orderBy(messages.createdAt);

    const parsed = ThreadWithMessagesSchema.parse({ ...thread, messages: msgs });
    return c.json(parsed);
  },
);

/** DELETE /threads/:id — delete a thread and all its messages. */
threadsRouter.delete(
  "/:id",
  zValidator("param", IdParamSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const db = getDb(c.env);

    const thread = await db.select({ id: threads.id }).from(threads).where(eq(threads.id, id)).get();
    if (!thread) return c.json({ error: "Thread not found" }, 404);

    await db.delete(threads).where(eq(threads.id, id));
    return c.json({ success: true });
  },
);
