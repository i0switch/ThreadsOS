import { createLlmClient, DryRunLlmClient } from "../adapters/llm/index.js";
import { FileSystemStorageClient } from "../adapters/storage/index.js";
import { OrchestrationServiceImpl } from "../services/orchestration/index.js";
import { runJob } from "./runner.js";

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
