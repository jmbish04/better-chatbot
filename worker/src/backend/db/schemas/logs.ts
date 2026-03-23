/**
 * Logs table schema.
 *
 * SQLite constraints:
 * - No native boolean — use `integer({ mode: 'boolean' })`
 * - No native Date  — use `integer({ mode: 'timestamp' })`
 *
 * @module schemas/logs
 */

import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const logs = sqliteTable("logs", {
  id: text("id").primaryKey(),
  level: text("level", { enum: ["debug", "info", "warn", "error"] }).notNull(),
  message: text("message").notNull(),
  timestamp: integer("timestamp", { mode: "timestamp" }).notNull(),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
});

export type Log = typeof logs.$inferSelect;
export type NewLog = typeof logs.$inferInsert;
