import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createOperationsModeService } from "../services/operations-mode/index.js";
import { runInternalJob } from "./internal-job.js";
import { runJob } from "./runner.js";

function isDirectExecution(): boolean {
  return (
    typeof process.argv[1] === "string" &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  );
}

export async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const operationsMode = createOperationsModeService();

  await runJob(
    { name: "tier-1d", dryRun, stuckThresholdMinutes: 180 },
    async ({ logger }) => {
      const modeEvaluation = operationsMode.reconcileMode();
      if (
        modeEvaluation.mode === "observe_only" ||
        modeEvaluation.mode === "safe_freeze"
      ) {
        logger.warn(
          { modeEvaluation },
          "Skipping daily tier due to active mode",
        );
        return `mode=${modeEvaluation.mode}; skipped daily jobs`;
      }

      const summaries = [
        await runInternalJob("daily-topic-research.ts", { dryRun }),
        await runInternalJob("daily-threads-plan.ts", { dryRun }),
      ];

      if (modeEvaluation.mode === "full_autonomy") {
        summaries.push(
          await runInternalJob("nightly-note-pipeline.ts", { dryRun }),
        );
      }

      logger.info({ modeEvaluation, summaries }, "Daily tier completed");
      return `mode=${modeEvaluation.mode}; ${summaries.join(" | ")}`;
    },
  );
}

if (isDirectExecution()) {
  await main();
}
