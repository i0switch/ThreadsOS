/**
 * ハートビート常駐ループ実行 (要件18: ループ実行モード)
 *
 * PM2 の cron_restart に依存せず、アプリ内部で1時間間隔を保証する。
 * 各イテレーションは子プロセスとして hourly-heartbeat.ts を実行し、
 * プロセス分離によるメモリリークの防止と、各実行の独立性を確保する。
 *
 * Usage:
 *   npx tsx src/jobs/heartbeat-loop.ts [--dry-run]
 *   HEARTBEAT_LOOP_INTERVAL_MS=1800000 npx tsx src/jobs/heartbeat-loop.ts
 */
import { fork } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../app/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_INTERVAL_MS = 3_600_000; // 1 hour
const MIN_INTERVAL_MS = 60_000; // 1 minute minimum

function readIntervalMs(): number {
  const raw = process.env.HEARTBEAT_LOOP_INTERVAL_MS;
  if (!raw) return DEFAULT_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < MIN_INTERVAL_MS) {
    logger.warn(
      { raw, min: MIN_INTERVAL_MS },
      "Invalid HEARTBEAT_LOOP_INTERVAL_MS, using default",
    );
    return DEFAULT_INTERVAL_MS;
  }
  return Math.floor(parsed);
}

const intervalMs = readIntervalMs();
const dryRun = process.argv.includes("--dry-run");
const heartbeatScript = resolve(__dirname, "hourly-heartbeat.ts");

let iterationCount = 0;
let isShuttingDown = false;

function runHeartbeatIteration(): Promise<{
  code: number | null;
  signal: string | null;
}> {
  return new Promise((resolve) => {
    iterationCount++;
    const args = dryRun ? ["--dry-run"] : [];

    logger.info(
      { iteration: iterationCount, script: heartbeatScript },
      "Starting heartbeat iteration",
    );

    const child = fork(heartbeatScript, args, {
      execArgv: ["--import", "tsx"],
      stdio: "inherit",
    });

    child.on("exit", (code, signal) => {
      if (code === 0) {
        logger.info(
          { iteration: iterationCount },
          "Heartbeat iteration completed",
        );
      } else {
        logger.error(
          { iteration: iterationCount, code, signal },
          "Heartbeat iteration exited with error",
        );
      }
      resolve({ code, signal });
    });

    child.on("error", (err) => {
      logger.error(
        { iteration: iterationCount, error: err.message },
        "Failed to spawn heartbeat process",
      );
      resolve({ code: 1, signal: null });
    });
  });
}

async function loop(): Promise<void> {
  logger.info(
    { intervalMs, dryRun },
    "Heartbeat loop started — Ctrl+C to stop",
  );

  // First iteration runs immediately
  await runHeartbeatIteration();

  while (!isShuttingDown) {
    const nextRunAt = new Date(Date.now() + intervalMs).toISOString();
    logger.info({ nextRunAt, intervalMs }, "Waiting for next heartbeat");

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      // Allow clean shutdown during wait
      const onShutdown = () => {
        clearTimeout(timer);
        resolve();
      };
      process.once("SIGINT", onShutdown);
      process.once("SIGTERM", onShutdown);
    });

    if (isShuttingDown) break;
    await runHeartbeatIteration();
  }

  logger.info({ totalIterations: iterationCount }, "Heartbeat loop stopped");
}

process.on("SIGINT", () => {
  logger.info("Received SIGINT, shutting down loop gracefully...");
  isShuttingDown = true;
});

process.on("SIGTERM", () => {
  logger.info("Received SIGTERM, shutting down loop gracefully...");
  isShuttingDown = true;
});

loop().catch((err) => {
  logger.error(
    { error: err instanceof Error ? err.message : String(err) },
    "Loop crashed",
  );
  process.exit(1);
});
