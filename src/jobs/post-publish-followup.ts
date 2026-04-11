import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLlmClient, DryRunLlmClient } from "../adapters/llm/index.js";
import {
  DryRunThreadsApiClient,
  ThreadsGraphApiClient,
} from "../adapters/threads-api/index.js";
import { OrchestrationServiceImpl } from "../services/orchestration/index.js";
import { runJob } from "./runner.js";

function isDirectExecution(): boolean {
  return (
    typeof process.argv[1] === "string" &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  );
}

export async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const orchestration = new OrchestrationServiceImpl();
  const llm = dryRun ? new DryRunLlmClient() : createLlmClient();
  const api = dryRun
    ? new DryRunThreadsApiClient()
    : new ThreadsGraphApiClient();

  await runJob(
    { name: "post-publish-followup", dryRun },
    async ({ dryRun, logger }) => {
      const result = await orchestration.runPostPublishFollowup(
        api,
        llm,
        dryRun,
      );
      logger.info(result);
      return result;
    },
  );
}

if (isDirectExecution()) {
  await main();
}
