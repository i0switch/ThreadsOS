import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { loadEnv } from "../config/env.js";
import * as schema from "./schema.js";

const env = loadEnv();
const sqlite = new Database(env.DATABASE_URL);
export const db = drizzle(sqlite, { schema });
