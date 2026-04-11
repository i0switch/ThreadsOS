/**
 * note.com ログイン — Playwright ブラウザでセッション取得
 *
 * Usage: pnpm note:login
 *
 * ヘッドフルブラウザを起動 → 手動ログイン → storageState を保存
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const projectRoot = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../..",
);

const storageStatePath =
  process.env.NOTE_STORAGE_STATE_PATH ??
  path.join(projectRoot, "data", "note-storage-state.json");

async function main(): Promise<void> {
  await fs.mkdir(path.dirname(storageStatePath), { recursive: true });

  console.log("\n=== note.com ログイン ===\n");
  console.log("Playwright ブラウザを起動します...");
  console.log("ブラウザでログインしてください。");
  console.log("ログイン成功を検知したら自動でセッション保存＆終了します。\n");

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });

  try {
    const page = await context.newPage();
    await page.goto("https://note.com/login", {
      waitUntil: "domcontentloaded",
    });

    console.log("⏳ ログイン待機中...");
    await page.waitForURL((url) => !url.toString().includes("/login"), {
      timeout: 300_000,
    });

    await context.storageState({ path: storageStatePath });
    console.log(`\n✓ セッションを保存しました: ${storageStatePath}`);

    const api = await context.request;
    const res = await api.get("https://note.com/api/v2/current_user");
    if (res.ok()) {
      const data = (await res.json()) as { data?: { urlname?: string } };
      console.log(`✓ ログインユーザー: ${data.data?.urlname ?? "(取得失敗)"}`);
    }
  } finally {
    await context.close();
    await browser.close();
  }

  console.log("\nNOTE_MODE=browser_assisted で自動投稿が使えます。\n");
}

main().catch((err) => {
  console.error("エラー:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
