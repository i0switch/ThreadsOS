import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLlmClient, DryRunLlmClient } from "../adapters/llm/index.js";
import { FileSystemStorageClient } from "../adapters/storage/index.js";
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
  const storage = new FileSystemStorageClient();

  await runJob(
    { name: "daily-threads-plan", dryRun },
    async ({ dryRun, logger }) => {
      const result = await orchestration.runDailyThreadsPlan(
        llm,
        storage,
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
