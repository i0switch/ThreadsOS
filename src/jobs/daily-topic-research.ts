import { ClaudeLlmClient, DryRunLlmClient } from "../adapters/llm/index.js";
import { FileSystemStorageClient } from "../adapters/storage/index.js";
import { OrchestrationServiceImpl } from "../services/orchestration/index.js";
import { runJob } from "./runner.js";

const dryRun = process.argv.includes("--dry-run");
const orchestration = new OrchestrationServiceImpl();
const llm = dryRun ? new DryRunLlmClient() : new ClaudeLlmClient();
const storage = new FileSystemStorageClient();

await runJob(
  { name: "daily-topic-research", dryRun },
  async ({ dryRun, logger }) => {
    const result = await orchestration.runDailyTopicResearch(
      llm,
      storage,
      dryRun,
    );
    logger.info(result);
    return result;
  },
);
