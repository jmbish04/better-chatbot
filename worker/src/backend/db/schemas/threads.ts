/**
 * Threads and messages schema.
 *
 * SQLite constraints:
 * - Timestamps stored as integers (Unix milliseconds).
 *
 * @module schemas/threads
 */

import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

/** One chat conversation, identified by a backend-generated UUID. */
export const threads = sqliteTable("threads", {
  id: text("id").primaryKey(),
  title: text("title").notNull().default("New Chat"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** A single message within a thread. */
export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  threadId: text("thread_id")
    .notNull()
    .references(() => threads.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["user", "assistant"] }).notNull(),
  content: text("content").notNull(),
  createdAt: integer("created_at").notNull(),
});

export type Thread = typeof threads.$inferSelect;
export type NewThread = typeof threads.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
