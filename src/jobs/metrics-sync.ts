import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DryRunNoteApiClient,
  NoteApiClientImpl,
  PlaywrightNoteApiClient,
} from "../adapters/note-api/index.js";
import {
  DryRunThreadsApiClient,
  ThreadsGraphApiClient,
} from "../adapters/threads-api/index.js";
import { loadEnv } from "../config/env.js";
import { MetricsSyncServiceImpl } from "../services/metrics-sync/index.js";
import { runJob } from "./runner.js";

function isDirectExecution(): boolean {
  return (
    typeof process.argv[1] === "string" &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  );
}

function createNoteApiClient(dryRun: boolean) {
  if (dryRun) {
    return new DryRunNoteApiClient();
  }

  const env = loadEnv();
  if (env.NOTE_MODE === "browser_assisted") {
    return new PlaywrightNoteApiClient();
  }

  return new NoteApiClientImpl(env.NOTE_MODE);
}

export async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const service = new MetricsSyncServiceImpl();
  const threadsApi = dryRun
    ? new DryRunThreadsApiClient()
    : new ThreadsGraphApiClient();
  const noteApi = createNoteApiClient(dryRun);

  await runJob({ name: "metrics-sync", dryRun }, async ({ dryRun, logger }) => {
    const result = await service.syncAll({
      noteApi,
      threadsApi,
      dryRun,
    });
    logger.info(result, "Metrics sync finished");
    return service.summarize(result);
  });
}

if (isDirectExecution()) {
  await main();
}
