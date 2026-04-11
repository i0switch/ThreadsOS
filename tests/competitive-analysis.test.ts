import { beforeAll, describe, expect, it, vi } from "vitest";
import { DepartmentExecutionServiceImpl } from "../src/services/department-execution/index.js";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = ":memory:";

beforeAll(async () => {
  const { ensureAutonomyTables } = await import("../src/db/bootstrap.js");
  ensureAutonomyTables();
});

describe("CompetitiveAnalysisExecutor", () => {
  function buildService(overrides: Record<string, unknown> = {}) {
    const llm = {
      generate: vi.fn(async () =>
        JSON.stringify({
          themes: ["副業", "AI活用"],
          hooks: ["数字フック", "逆張りフック"],
          engagementPatterns: "午前投稿が高エンゲージメント",
          winningPatterns: [
            {
              pattern: "具体数字+逆張り",
              frequency: "high",
              estimatedEngagement: "high",
            },
          ],
        }),
      ),
    } as never;
    const runtimeState = {
      startAgent: vi.fn(),
      finishAgent: vi.fn(),
    } as const;
    const runTrackedSubJob = vi.fn(
      async (_jobName: string, task: () => Promise<string>) => task(),
    );

    return new DepartmentExecutionServiceImpl({
      dryRun: false,
      maxPostsPerHour: 3,
      llm,
      storage: {} as never,
      threadsApi: {} as never,
      orchestration: {} as never,
      scheduler: {} as never,
      autoPublisher: {} as never,
      optimizer: {} as never,
      replyExecution: {} as never,
      noteEngagement: {} as never,
      notification: {} as never,
      runTrackedSubJob,
      createNoteApiClient: vi.fn() as never,
      runtimeState: runtimeState as never,
      ...overrides,
    });
  }

  it("supports analyze_competitors action", () => {
    const service = buildService();
    const reports = service.collectReports();
    const caReport = reports.find((r) => r.department === "competitive-analysis");
    expect(caReport).toBeDefined();
    expect(caReport!.department).toBe("competitive-analysis");
  });

  it("executes competitor analysis and returns structured result", async () => {
    const service = buildService();
    const result = await service.execute({
      type: "analyze_competitors",
      priority: 9,
      reason: "週次競合分析",
    });
    expect(result.department).toBe("competitive-analysis");
    expect(result.status).toBe("completed");
    expect(result.summary).toContain("競合分析");
  });
});
