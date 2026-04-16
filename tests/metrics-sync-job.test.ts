import { beforeEach, describe, expect, it, vi } from "vitest";

const syncAll = vi.fn();
const summarize = vi.fn();
const runJob = vi.fn();

vi.mock("../src/jobs/runner.js", () => ({
  runJob,
}));

vi.mock("../src/services/metrics-sync/index.js", () => ({
  MetricsSyncServiceImpl: class {
    syncAll = syncAll;
    summarize = summarize;
  },
}));

vi.mock("../src/adapters/threads-api/index.js", () => ({
  DryRunThreadsApiClient: class {},
  ThreadsGraphApiClient: class {},
}));

vi.mock("../src/adapters/note-api/index.js", () => ({
  DryRunNoteApiClient: class {},
  NoteApiClientImpl: class {},
  PlaywrightNoteApiClient: class {},
}));

vi.mock("../src/config/env.js", () => ({
  loadEnv: () => ({
    NOTE_MODE: "browser_assisted",
  }),
}));

describe("metrics-sync job", () => {
  beforeEach(() => {
    syncAll.mockReset();
    summarize.mockReset();
    runJob.mockReset();

    syncAll.mockResolvedValue({
      noteSessionState: "healthy",
      noteSessionDetail: "ok",
      noteArticlesSynced: 1,
      threadPostsSynced: 1,
      noteMetricsSnapshots: 1,
      threadsMetricsSnapshots: 1,
      revenueEventsRecorded: 1,
      anomaliesRecorded: 0,
      allowAggressiveExperiments: false,
    });
    summarize.mockReturnValue("summary");
    runJob.mockImplementation(async (_options, execute) => {
      await execute({
        dryRun: false,
        logger: { info: vi.fn() },
      });
    });
  });

  it("wires runJob to the metrics sync service", async () => {
    const mod = await import("../src/jobs/metrics-sync.js");

    await mod.main();

    expect(runJob).toHaveBeenCalledTimes(1);
    expect(runJob.mock.calls[0][0]).toMatchObject({ name: "metrics-sync" });
    expect(syncAll).toHaveBeenCalledTimes(1);
    expect(summarize).toHaveBeenCalledTimes(1);
  });
});
