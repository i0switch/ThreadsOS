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
  DASHBOARD_HOST: z.string().default("127.0.0.1"),
  DASHBOARD_AUTH_TOKEN: z.string().min(1).optional(),
  DATABASE_URL: z.string().default("data/threads-note-os.db"),
  THREADS_ACCESS_TOKEN: z.string().min(1).optional(),
  THREADS_USER_ID: z.string().min(1).optional(),
  THREADS_APP_ID: z.string().min(1).optional(),
  THREADS_APP_SECRET: z.string().min(1).optional(),
  LLM_API_KEY: z.string().min(1).optional(),
  LLM_MODE: z.enum(["heartbeat", "direct", "dry-run"]).default("heartbeat"),
  LLM_DEFAULT_TIER: z.enum(["fast", "standard", "premium"]).default("standard"),
  LLM_DIRECT_MODEL_FAST: z.string().default("claude-3-5-haiku-latest"),
  LLM_DIRECT_MODEL_STANDARD: z.string().default("claude-sonnet-4-20250514"),
  LLM_DIRECT_MODEL_PREMIUM: z.string().default("claude-opus-4-20250514"),
  LLM_HEARTBEAT_MODEL_FAST: z.string().default("haiku"),
  LLM_HEARTBEAT_MODEL_STANDARD: z.string().default("sonnet"),
  LLM_HEARTBEAT_MODEL_PREMIUM: z.string().default("opus"),
  JINA_API_KEY: z.string().optional(),
  NOTE_SESSION_COOKIE: z.string().optional(),
  NOTE_STORAGE_STATE_PATH: z.string().default("data/note-storage-state.json"),
  NOTE_PLAYWRIGHT_HEADLESS: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  NOTIFICATION_DISCORD_WEBHOOK: z.string().url().optional(),
  MAX_POSTS_PER_HOUR: z.coerce.number().min(1).max(10).default(3),
  MAX_REPLIES_PER_HOUR: z.coerce.number().min(1).max(30).default(10),
  SCRAPER_RATE_LIMIT_MS: z.coerce.number().default(3000),
  TZ: z.string().default("Asia/Tokyo"),
  NOTE_MODE: z
    .enum(["research_only", "draft_assist", "browser_assisted"])
    .default("browser_assisted"),
});

export type Env = z.infer<typeof envSchema>;

const projectRoot = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../..",
);

function isLocalDashboardHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost";
}

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
  if (!env.DASHBOARD_AUTH_TOKEN && !isLocalDashboardHost(env.DASHBOARD_HOST)) {
    missing.push("DASHBOARD_AUTH_TOKEN");
  }
  // LLM_API_KEY は direct モード時のみ必須
  if (env.LLM_MODE === "direct" && !env.LLM_API_KEY) {
    missing.push("LLM_API_KEY (LLM_MODE=direct の場合必須)");
  }
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
