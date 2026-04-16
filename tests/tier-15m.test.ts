import { beforeEach, describe, expect, it, vi } from "vitest";

const runJob = vi.fn();
const runInternalJob = vi.fn();
const reconcileMode = vi.fn();
const applyIfNeeded = vi.fn();

vi.mock("../src/jobs/runner.js", () => ({
  runJob,
}));

vi.mock("../src/jobs/internal-job.js", () => ({
  runInternalJob,
}));

vi.mock("../src/services/operations-mode/index.js", () => ({
  createOperationsModeService: () => ({
    reconcileMode,
  }),
}));

vi.mock("../src/services/rollback/index.js", () => ({
  createRollbackService: () => ({
    applyIfNeeded,
  }),
}));

describe("tier-15m job", () => {
  beforeEach(() => {
    runJob.mockReset();
    runInternalJob.mockReset();
    reconcileMode.mockReset();
    applyIfNeeded.mockReset();

    reconcileMode.mockReturnValue({
      mode: "full_autonomy",
      changed: false,
      reason: "stable",
      previousMode: null,
    });
    runInternalJob.mockResolvedValue("metrics ok");
    applyIfNeeded.mockReturnValue({
      applied: false,
      channel: null,
      reason: "rollback conditions not met",
    });
    runJob.mockImplementation(async (_options, execute) => {
      return execute({
        dryRun: true,
        logger: { info: vi.fn() },
      });
    });
  });

  it("runs metrics-sync inside the 15-minute tier", async () => {
    const mod = await import("../src/jobs/tier-15m.js");

    await mod.main();

    expect(runJob).toHaveBeenCalledTimes(1);
    expect(runInternalJob).toHaveBeenCalledWith("metrics-sync.ts", {
      dryRun: false,
    });
    expect(applyIfNeeded).toHaveBeenCalledTimes(1);
  });
});
