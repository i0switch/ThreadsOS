import { sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { departmentNotifications } from "../src/db/schema.js";
import { DepartmentExecutionServiceImpl } from "../src/services/department-execution/index.js";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = ":memory:";

type Db = typeof import("../src/db/index.js")["db"];

let db: Db;

beforeAll(async () => {
  ({ db } = await import("../src/db/index.js"));
  const { ensureAutonomyTables } = await import("../src/db/bootstrap.js");
  ensureAutonomyTables();
});

beforeEach(() => {
  db.run(sql`DELETE FROM competitor_analyses`);
  db.run(sql`DELETE FROM competitor_snapshots`);
  db.run(sql`DELETE FROM department_notifications`);
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
    const caReport = reports.find(
      (r) => r.department === "competitive-analysis",
    );
    expect(caReport).toBeDefined();
    expect(caReport?.department).toBe("competitive-analysis");
  });

  it("executes competitor analysis and returns structured result", async () => {
    const now = new Date().toISOString();
    db.run(
      sql`INSERT INTO competitor_snapshots (id, source, data, snapshot_date, created_at)
          VALUES ('snapshot-1', 'https://example.com/threads/1', '具体数字と逆張りフックの投稿が高反応', ${now.split("T")[0]}, ${now})`,
    );

    const service = buildService();
    const result = await service.execute({
      type: "analyze_competitors",
      priority: 9,
      reason: "週次競合分析",
    });
    expect(result.department).toBe("competitive-analysis");
    expect(result.status).toBe("completed");
    expect(result.summary).toContain("競合分析");

    const notifications = db
      .select()
      .from(departmentNotifications)
      .all()
      .sort((left, right) =>
        left.toDepartment.localeCompare(right.toDepartment),
      );

    expect(notifications.map((row) => row.toDepartment)).toEqual([
      "command",
      "note",
      "threads",
    ]);
    expect(
      notifications.every(
        (row) =>
          row.fromDepartment === "competitive-analysis" &&
          row.notificationType === "analysis_complete",
      ),
    ).toBe(true);

    const commandNotification = notifications.find(
      (row) => row.toDepartment === "command",
    );
    expect(commandNotification).toBeDefined();
    expect(commandNotification?.content).toContain("combinedWinningPatterns");
  });
});
