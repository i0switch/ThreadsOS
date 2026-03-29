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
  THREADS_ACCESS_TOKEN: z.string().optional(),
  THREADS_USER_ID: z.string().optional(),
  LLM_API_KEY: z.string().optional(),
  JINA_API_KEY: z.string().optional(),
  NOTE_SESSION_COOKIE: z.string().optional(),
  NOTIFICATION_DISCORD_WEBHOOK: z.string().url().optional(),
  NOTIFICATION_LINE_TOKEN: z.string().optional(),
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

export function loadEnv(): Env {
  const env = envSchema.parse(process.env);
  return {
    ...env,
    DATABASE_URL: resolveDatabaseUrl(env.DATABASE_URL),
  };
}
