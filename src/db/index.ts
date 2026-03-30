import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { loadEnv } from "../config/env.js";
import * as schema from "./schema.js";

const env = loadEnv();

if (env.DATABASE_URL !== ":memory:") {
  const dir = dirname(env.DATABASE_URL);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

const sqlite = new Database(env.DATABASE_URL);
export const db = drizzle(sqlite, { schema });
