/**
 * Threads 長期トークン自動更新ジョブ
 *
 * Usage:
 *   pnpm job:refresh-token          # 実行
 *   pnpm job:refresh-token --dry-run # dry-run
 *
 * Meta Threads Graph API の長期トークンは 60 日で失効する。
 * このジョブを定期実行（週1回推奨）することで自動的にリフレッシュし、
 * .env の THREADS_ACCESS_TOKEN を更新する。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runJob } from "./runner.js";

const projectRoot = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../..",
);
const envPath = path.join(projectRoot, ".env");

const REFRESH_ENDPOINT = "https://graph.threads.net/refresh_access_token";

type RefreshResponse = {
  access_token: string;
  token_type: string;
  expires_in: number;
};

type ErrorResponse = {
  error?: { message?: string; type?: string; code?: number };
};

export async function refreshToken(currentToken: string): Promise<RefreshResponse> {
  const url = new URL(REFRESH_ENDPOINT);
  url.searchParams.set("grant_type", "th_refresh_token");
  url.searchParams.set("access_token", currentToken);

  const res = await fetch(url.toString());
  const body = (await res.json()) as RefreshResponse & ErrorResponse;

  if (!res.ok || body.error) {
    const msg = body.error?.message ?? `HTTP ${res.status}`;
    throw new Error(`TOKEN_REFRESH_FAILED: ${msg}`);
  }

  if (!body.access_token) {
    throw new Error("TOKEN_REFRESH_FAILED: no access_token in response");
  }

  return body;
}

export async function updateEnvFile(newToken: string): Promise<void> {
  let content: string;
  try {
    content = await fs.readFile(envPath, "utf-8");
  } catch {
    throw new Error(".env ファイルが見つかりません");
  }

  const lines = content.split("\n");
  let found = false;

  const updated = lines.map((line) => {
    if (line.startsWith("THREADS_ACCESS_TOKEN=")) {
      found = true;
      return `THREADS_ACCESS_TOKEN=${newToken}`;
    }
    return line;
  });

  if (!found) {
    updated.push(`THREADS_ACCESS_TOKEN=${newToken}`);
  }

  await fs.writeFile(envPath, updated.join("\n"), "utf-8");
}

// CLI エントリーポイント（直接実行時のみ）
const isDirectRun =
  import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}` ||
  import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`;

if (isDirectRun) {
const dryRun = process.argv.includes("--dry-run");

runJob({ name: "refresh-threads-token", dryRun }, async (ctx) => {
  const token = process.env.THREADS_ACCESS_TOKEN;
  if (!token) {
    throw new Error("THREADS_ACCESS_TOKEN が設定されていません");
  }

  if (ctx.dryRun) {
    ctx.logger.info("dry-run: トークンリフレッシュをスキップ");
    return "dry-run: skipped";
  }

  ctx.logger.info("トークンリフレッシュを実行中...");
  const result = await refreshToken(token);

  const expiresInDays = Math.floor(result.expires_in / 86400);
  ctx.logger.info(
    { expiresInDays, tokenType: result.token_type },
    "新しいトークンを取得",
  );

  await updateEnvFile(result.access_token);
  ctx.logger.info(".env の THREADS_ACCESS_TOKEN を更新しました");

  return `トークン更新完了（有効期限: ${expiresInDays}日）`;
});
}
