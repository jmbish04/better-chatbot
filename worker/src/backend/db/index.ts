/**
 * D1 database client factory.
 *
 * Call `getDb(env)` inside any Worker handler to get a Drizzle client
 * bound to the D1 database via the `DB` binding.
 *
 * @module backend/db
 */

import { drizzle } from "drizzle-orm/d1";
import * as threadsSchema from "./schemas/threads.js";
import * as logsSchema from "./schemas/logs.js";

export const schema = { ...threadsSchema, ...logsSchema };

export function getDb(env: Env) {
  return drizzle(env.DB, { schema });
}

export * from "./schemas/threads.js";
export * from "./schemas/logs.js";
