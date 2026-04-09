import { createLlmClient, DryRunLlmClient } from "../adapters/llm/index.js";
import {
  DryRunThreadsApiClient,
  ThreadsGraphApiClient,
} from "../adapters/threads-api/index.js";
import { OrchestrationServiceImpl } from "../services/orchestration/index.js";
import { runJob } from "./runner.js";

const dryRun = process.argv.includes("--dry-run");
const orchestration = new OrchestrationServiceImpl();
const llm = dryRun ? new DryRunLlmClient() : createLlmClient();
const api = dryRun ? new DryRunThreadsApiClient() : new ThreadsGraphApiClient();

await runJob(
  { name: "post-publish-followup", dryRun },
  async ({ dryRun, logger }) => {
    const result = await orchestration.runPostPublishFollowup(api, llm, dryRun);
    logger.info(result);
    return result;
  },
);
