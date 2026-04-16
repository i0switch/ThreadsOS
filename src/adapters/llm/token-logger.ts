import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface TokenUsageEntry {
  timestamp: string;
  heartbeatId: string | null;
  callSite: string;
  tier: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  costUsd?: number;
  durationMs: number;
}

const TOKEN_LOG_DIR = "tmp/token-usage";

function ensureTokenLogDir(): void {
  const fullDir = join(process.cwd(), TOKEN_LOG_DIR);
  if (!existsSync(fullDir)) {
    mkdirSync(fullDir, { recursive: true });
  }
}

function getTodayLogFile(): string {
  const today = new Date().toISOString().slice(0, 10);
  return join(process.cwd(), TOKEN_LOG_DIR, `${today}.jsonl`);
}

export function logTokenUsage(entry: TokenUsageEntry): void {
  ensureTokenLogDir();
  const logFile = getTodayLogFile();
  const line = `${JSON.stringify(entry)}\n`;
  writeFileSync(logFile, line, { flag: "a" });
}
