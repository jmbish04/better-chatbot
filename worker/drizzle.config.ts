import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/backend/db/schemas/*.ts",
  out: "./drizzle/migrations",
  dialect: "sqlite",
});
