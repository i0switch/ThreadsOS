/**
 * LLM Heartbeat Worker
 *
 * Claude Code（AI）がローカルで実行するワーカー。
 * llm_task_queue テーブルの pending タスクを拾い、
 * Claude CLI（`claude -p`）を使って処理して結果を書き戻す。
 *
 * 使い方:
 *   pnpm job:llm-worker
 *
 * または Claude Code スキル経由で呼び出す。
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { logger } from "../app/logger.js";
import { loadEnv } from "../config/env.js";
import { db } from "../db/index.js";
import { llmTaskQueue } from "../db/schema.js";

const LOCK_FILE = join(process.cwd(), "tmp", "llm-worker.lock");
type LlmTier = "fast" | "standard" | "premium";
type HeartbeatTaskOptions = {
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  tier?: LlmTier;
};

function acquireLock(): boolean {
  if (existsSync(LOCK_FILE)) {
    const pid = parseInt(readFileSync(LOCK_FILE, "utf-8").trim(), 10);
    try {
      process.kill(pid, 0); // throws if process doesn't exist
      logger.warn({ pid }, "[WORKER] Another instance is running, exiting");
      return false;
    } catch {
      // Stale lock — remove it
      unlinkSync(LOCK_FILE);
    }
  }
  writeFileSync(LOCK_FILE, String(process.pid), "utf-8");
  return true;
}

function releaseLock(): void {
  try {
    if (existsSync(LOCK_FILE)) {
      const pid = parseInt(readFileSync(LOCK_FILE, "utf-8").trim(), 10);
      if (pid === process.pid) unlinkSync(LOCK_FILE);
    }
  } catch {
    /* ignore */
  }
}

const POLL_INTERVAL_MS = 1000;
const CLAUDE_TIMEOUT_MS = 8 * 60 * 1000;

function parseTaskOptions(optionsJson: string | null): HeartbeatTaskOptions {
  if (!optionsJson) {
    return {};
  }

  try {
    const parsed = JSON.parse(optionsJson) as HeartbeatTaskOptions;
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "[WORKER] Failed to parse optionsJson, using defaults",
    );
    return {};
  }
}

export function buildClaudeSystemPrompt(
  systemPrompt?: string,
  options: HeartbeatTaskOptions = {},
): string | undefined {
  const constraints: string[] = [];
  const maxTokens = options.maxTokens;

  if (Number.isFinite(maxTokens) && (maxTokens ?? 0) > 0) {
    constraints.push(
      `Keep the response within approximately ${Math.floor(maxTokens ?? 0)} tokens.`,
    );
  }

  if (typeof options.temperature === "number") {
    if (options.temperature <= 0.3) {
      constraints.push(
        "Be deterministic, concise, and avoid unnecessary variation.",
      );
    } else if (options.temperature >= 0.85) {
      constraints.push(
        "You may explore multiple phrasings, but stay precise and follow the requested format.",
      );
    }
  }

  const merged = [
    systemPrompt?.trim(),
    constraints.length > 0
      ? `Additional generation constraints:\n${constraints.map((item) => `- ${item}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n")
    .trim();

  return merged || undefined;
}

export function resolveClaudeCliModel(tier?: LlmTier): string {
  const env = loadEnv();
  const resolvedTier = tier ?? env.LLM_DEFAULT_TIER;
  switch (resolvedTier) {
    case "fast":
      return env.LLM_HEARTBEAT_MODEL_FAST;
    case "premium":
      return env.LLM_HEARTBEAT_MODEL_PREMIUM;
    default:
      return env.LLM_HEARTBEAT_MODEL_STANDARD;
  }
}

export function buildClaudeCliArgs(
  systemPrompt?: string,
  options: HeartbeatTaskOptions = {},
): string[] {
  const args = [
    "--print",
    "--output-format",
    "text",
    "--model",
    resolveClaudeCliModel(options.tier),
  ];
  if (systemPrompt) {
    args.push("--system-prompt", systemPrompt);
  }
  return args;
}

function callClaudeCli(
  prompt: string,
  systemPrompt?: string,
  options: HeartbeatTaskOptions = {},
): string {
  const mergedSystemPrompt = buildClaudeSystemPrompt(systemPrompt, options);
  const args = buildClaudeCliArgs(mergedSystemPrompt, options);

  // プロンプトを stdin から渡す
  const result = spawnSync("claude", args, {
    input: prompt,
    encoding: "utf-8",
    timeout: CLAUDE_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    // フックのプロンプト汚染を防ぐ（UserPromptSubmit フックをスキップさせる）
    env: { ...process.env, THREADOS_INTERNAL: "1" },
  });

  if (result.error) {
    throw new Error(`Claude CLI 起動失敗: ${result.error.message}`);
  }

  const stdout = (result.stdout ?? "").trim();

  // 使用量制限メッセージを検出してエラーとして扱う
  if (
    stdout.includes("out of extra usage") ||
    stdout.includes("out of usage")
  ) {
    throw new Error(`Claude 使用量制限: ${stdout.slice(0, 100)}`);
  }

  // SessionEndフック失敗などでexit code != 0でもstdoutに出力がある場合は使う
  if (result.status !== 0 && !stdout) {
    const stderr = result.stderr?.trim() ?? "";
    throw new Error(`Claude CLI エラー (${result.status}): ${stderr}`);
  }

  return stdout;
}

export async function runHeartbeatWorkerOnce(): Promise<{
  processed: number;
  tasks: Array<{ id: string; status: string }>;
}> {
  const pending = db
    .select()
    .from(llmTaskQueue)
    .where(eq(llmTaskQueue.status, "pending"))
    .all();

  if (pending.length === 0) {
    return { processed: 0, tasks: [] };
  }

  const results: Array<{ id: string; status: string }> = [];

  for (const task of pending) {
    // 楽観的ロック: status=pending の行のみ更新（他ワーカーに先取りされたらスキップ）
    const claim = db
      .update(llmTaskQueue)
      .set({ status: "processing", updatedAt: new Date().toISOString() })
      .where(
        and(eq(llmTaskQueue.id, task.id), eq(llmTaskQueue.status, "pending")),
      )
      .run();
    if (claim.changes === 0) {
      logger.info(
        { taskId: task.id },
        "[WORKER] Task already claimed by another worker, skipping",
      );
      continue;
    }

    logger.info(
      { taskId: task.id },
      "[WORKER] Processing LLM task via Claude CLI",
    );

    try {
      const options = parseTaskOptions(task.optionsJson);
      const result = callClaudeCli(
        task.prompt,
        task.systemPrompt ?? options.systemPrompt ?? undefined,
        options,
      );
      await writeTaskResult(task.id, result);
      logger.info({ taskId: task.id }, "[WORKER] Task completed");
      results.push({ id: task.id, status: "done" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ taskId: task.id, error: message }, "[WORKER] Task failed");
      await writeTaskError(task.id, message);
      results.push({ id: task.id, status: "error" });
    }
  }

  return { processed: pending.length, tasks: results };
}

export async function writeTaskResult(
  taskId: string,
  result: string,
): Promise<void> {
  db.update(llmTaskQueue)
    .set({
      status: "done",
      result,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(llmTaskQueue.id, taskId))
    .run();

  logger.info({ taskId }, "[WORKER] Task result written");
}

export async function writeTaskError(
  taskId: string,
  error: string,
): Promise<void> {
  db.update(llmTaskQueue)
    .set({
      status: "error",
      error,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(llmTaskQueue.id, taskId))
    .run();

  logger.warn({ taskId, error }, "[WORKER] Task error written");
}

// CLI エントリーポイント（ループ実行）
// Windows対応: パス区切りの違いを吸収
const isWorkerEntry =
  fileURLToPath(import.meta.url).replace(/\\/g, "/") ===
  (process.argv[1] ?? "").replace(/\\/g, "/");
if (isWorkerEntry) {
  if (!acquireLock()) {
    process.exit(0);
  }

  // クリーンアップ登録
  for (const sig of ["exit", "SIGINT", "SIGTERM"] as const) {
    process.on(sig, releaseLock);
  }

  logger.info("[WORKER] LLM Heartbeat Worker started");

  const run = async () => {
    const result = await runHeartbeatWorkerOnce();
    if (result.processed > 0) {
      logger.info(result, "[WORKER] Processed tasks");
    }
    setTimeout(run, POLL_INTERVAL_MS);
  };

  run().catch((err) => {
    logger.error(err, "[WORKER] Fatal error");
    process.exit(1);
  });
}
