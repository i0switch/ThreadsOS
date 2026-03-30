import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { z } from "zod";

// .env ファイルを読み込む（存在しなくてもエラーにしない）
config();

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().default("data/threads-note-os.db"),
  THREADS_ACCESS_TOKEN: z.string().min(1).optional(),
  THREADS_USER_ID: z.string().min(1).optional(),
  LLM_API_KEY: z.string().min(1).optional(),
  JINA_API_KEY: z.string().optional(),
  NOTE_SESSION_COOKIE: z.string().optional(),
  NOTIFICATION_DISCORD_WEBHOOK: z.string().url().optional(),
  MAX_POSTS_PER_HOUR: z.coerce.number().min(1).max(10).default(3),
  MAX_REPLIES_PER_HOUR: z.coerce.number().min(1).max(30).default(10),
  SCRAPER_RATE_LIMIT_MS: z.coerce.number().default(3000),
  TZ: z.string().default("Asia/Tokyo"),
  NOTE_MODE: z
    .enum(["research_only", "draft_assist", "browser_assisted"])
    .default("research_only"),
});

export type Env = z.infer<typeof envSchema>;

const projectRoot = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../..",
);

export function resolveDatabaseUrl(databaseUrl: string): string {
  if (databaseUrl === ":memory:" || isAbsolute(databaseUrl)) {
    return databaseUrl;
  }

  return resolve(projectRoot, databaseUrl);
}

export function validateProductionEnv(env: Env): void {
  const missing: string[] = [];
  if (!env.THREADS_ACCESS_TOKEN) missing.push("THREADS_ACCESS_TOKEN");
  if (!env.THREADS_USER_ID) missing.push("THREADS_USER_ID");
  if (!env.LLM_API_KEY) missing.push("LLM_API_KEY");
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables for production: ${missing.join(", ")}`,
    );
  }
}

export function loadEnv(): Env {
  const env = envSchema.parse(process.env);
  const resolved = {
    ...env,
    DATABASE_URL: resolveDatabaseUrl(env.DATABASE_URL),
  };
  if (resolved.NODE_ENV === "production") validateProductionEnv(resolved);
  return resolved;
}
