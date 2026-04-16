import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { loadEnv } from "../config/env.js";
import { assertContractStoreHealthy } from "../services/contracts/index.js";
import * as schema from "./schema.js";

assertContractStoreHealthy();

const env = loadEnv();

if (env.DATABASE_URL !== ":memory:") {
  const dir = dirname(env.DATABASE_URL);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

const sqlite = new Database(env.DATABASE_URL);
sqlite.pragma("foreign_keys = ON");
sqlite.pragma("busy_timeout = 5000");
sqlite.pragma("temp_store = MEMORY");
if (env.DATABASE_URL !== ":memory:") {
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
}
export const db = drizzle(sqlite, { schema });
