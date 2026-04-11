/**
 * 初回セットアップウィザード
 *
 * Usage: pnpm setup
 *
 * .env ファイルの設定と初回ジャンル登録をガイドする。
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { atomicWriteTextFile } from "../utils/atomic-file.js";

const projectRoot = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../..",
);
const envPath = path.join(projectRoot, ".env");

const rl = createInterface({ input: process.stdin, output: process.stdout });

async function ask(question: string, defaultValue = ""): Promise<string> {
  const hint = defaultValue ? ` (デフォルト: ${defaultValue})` : "";
  const answer = await rl.question(`${question}${hint}: `);
  return answer.trim() || defaultValue;
}

async function loadExistingEnv(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const content = await fs.readFile(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx === -1) continue;
      map.set(trimmed.slice(0, idx).trim(), trimmed.slice(idx + 1).trim());
    }
  } catch {
    // .env が存在しない場合は空のままでOK
  }
  return map;
}

async function writeEnv(entries: Map<string, string>): Promise<void> {
  const lines: string[] = ["# ThreadsOS 設定 (自動生成)", ""];
  for (const [key, value] of entries) {
    lines.push(`${key}=${value}`);
  }
  await atomicWriteTextFile(envPath, `${lines.join("\n")}\n`);
}

async function saveGenre(genre: string): Promise<void> {
  // DB が初期化されていれば human_inputs に保存する
  try {
    const { db } = await import("../db/index.js");
    const { humanInputs } = await import("../db/schema.js");
    const { ensureAutonomyTables } = await import("../db/bootstrap.js");
    ensureAutonomyTables();
    db.insert(humanInputs)
      .values({
        id: randomUUID(),
        inputType: "directive",
        content: `運用ジャンル: ${genre}`,
        processed: 0,
        createdAt: new Date().toISOString(),
      })
      .run();
    console.log("✓ ジャンルを DB に保存しました（次回ハートビートで反映）");
  } catch (err) {
    console.warn(
      "DB 保存をスキップ（先に pnpm db:migrate を実行してください）:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function main(): Promise<void> {
  console.log("\n=== ThreadsOS セットアップウィザード ===\n");

  const env = await loadExistingEnv();
  const isUpdate = env.size > 0;
  if (isUpdate) {
    console.log(
      "既存の .env を検出しました。値を変更する場合のみ入力してください。\n",
    );
  }

  // ── Threads API ──────────────────────────────────────────────────
  console.log("【Threads API 設定】");
  console.log("THREADS_ACCESS_TOKEN は Meta Graph API から取得してください。");
  const threadsToken = await ask(
    "THREADS_ACCESS_TOKEN",
    env.get("THREADS_ACCESS_TOKEN") ?? "",
  );
  const threadsUserId = await ask(
    "THREADS_USER_ID",
    env.get("THREADS_USER_ID") ?? "",
  );

  // ── note 設定 ────────────────────────────────────────────────────
  console.log("\n【note 設定】");
  console.log(
    "NOTE_STORAGE_STATE_PATH: ブラウザセッションの保存先（/note-login スキルで生成）",
  );
  const noteStoragePath = await ask(
    "NOTE_STORAGE_STATE_PATH",
    env.get("NOTE_STORAGE_STATE_PATH") ?? "data/note-storage-state.json",
  );

  // ── 通知 ─────────────────────────────────────────────────────────
  console.log("\n【Discord 通知 (任意)】");
  const discordWebhook = await ask(
    "NOTIFICATION_DISCORD_WEBHOOK",
    env.get("NOTIFICATION_DISCORD_WEBHOOK") ?? "",
  );

  // ── 設定値を保存 ─────────────────────────────────────────────────
  if (threadsToken) env.set("THREADS_ACCESS_TOKEN", threadsToken);
  if (threadsUserId) env.set("THREADS_USER_ID", threadsUserId);
  env.set("NOTE_STORAGE_STATE_PATH", noteStoragePath);
  env.set("NOTE_MODE", "browser_assisted");
  env.set("LLM_MODE", "heartbeat");
  if (discordWebhook) env.set("NOTIFICATION_DISCORD_WEBHOOK", discordWebhook);

  await writeEnv(env);
  console.log("\n✓ .env を保存しました。");

  // ── 初回ジャンル登録 ─────────────────────────────────────────────
  console.log("\n【初回ジャンル登録 (任意)】");
  console.log("例: 自己啓発 / マーケティング / 投資 / 恋愛・人間関係");
  const genre = await ask("運用するジャンル・テーマ (スキップ=Enter)");
  if (genre) {
    await saveGenre(genre);
  }

  // ── 完了 ─────────────────────────────────────────────────────────
  console.log("\n=== セットアップ完了 ===");
  console.log("");
  console.log("次のステップ:");
  console.log("  1. pnpm db:migrate          → DB 初期化");
  console.log("  2. /note-login スキル        → note セッション保存");
  console.log("  3. pnpm job:heartbeat:dry   → 動作確認（dry-run）");
  console.log("  4. pnpm job:heartbeat       → 本番実行");
  console.log("");

  rl.close();
}

main().catch((err) => {
  console.error("セットアップ中にエラーが発生しました:", err);
  rl.close();
  process.exit(1);
});
