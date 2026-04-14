import { sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { departmentNotifications } from "../src/db/schema.js";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = ":memory:";

type Db = typeof import("../src/db/index.js")["db"];
type DepartmentExecutionServiceImplCtor =
  typeof import("../src/services/department-execution/index.js")["DepartmentExecutionServiceImpl"];
type ResearchServiceImplCtor =
  typeof import("../src/services/research/index.js")["ResearchServiceImpl"];

let db: Db;
let DepartmentExecutionServiceImpl: DepartmentExecutionServiceImplCtor;
let ResearchServiceImpl: ResearchServiceImplCtor;

function makeMinimalDeps() {
  return {
    dryRun: true,
    maxPostsPerHour: 3,
    llm: {} as never,
    storage: {} as never,
    threadsApi: {} as never,
    orchestration: {} as never,
    scheduler: {} as never,
    autoPublisher: {} as never,
    optimizer: {} as never,
    replyExecution: {} as never,
    noteEngagement: {} as never,
    notification: {} as never,
    runTrackedSubJob: (() => {}) as never,
    createNoteApiClient: (() => {}) as never,
    runtimeState: {} as never,
  };
}

beforeAll(async () => {
  ({ db } = await import("../src/db/index.js"));
  const { ensureAutonomyTables } = await import("../src/db/bootstrap.js");
  ({ DepartmentExecutionServiceImpl } = await import(
    "../src/services/department-execution/index.js"
  ));
  ({ ResearchServiceImpl } = await import("../src/services/research/index.js"));
  ensureAutonomyTables();
});

beforeEach(() => {
  db.run(sql`DELETE FROM department_runs`);
  db.run(sql`DELETE FROM human_inputs`);
  db.run(sql`DELETE FROM topics`);
  db.run(sql`DELETE FROM thread_post_drafts`);
  db.run(sql`DELETE FROM content_slots`);
  db.run(sql`DELETE FROM note_drafts`);
  db.run(sql`DELETE FROM note_post_results`);
  db.run(sql`DELETE FROM reply_decisions`);
  db.run(sql`DELETE FROM thread_post_results`);
  db.run(sql`DELETE FROM department_notifications`);
  db.run(sql`DELETE FROM department_summaries`);
  db.run(sql`DELETE FROM research_items`);
  db.run(sql`DELETE FROM memory_entries`);
});

describe("DepartmentExecution collectReports()", () => {
  it("returns a report for each of the 5 departments", () => {
    const service = new DepartmentExecutionServiceImpl(makeMinimalDeps());
    const reports = service.collectReports();

    expect(reports).toHaveLength(5);

    const departments = reports.map((r) => r.department);
    expect(departments).toContain("command");
    expect(departments).toContain("external-research");
    expect(departments).toContain("competitive-analysis");
    expect(departments).toContain("threads");
    expect(departments).toContain("note");
  });

  it("each report has the required shape", () => {
    const service = new DepartmentExecutionServiceImpl(makeMinimalDeps());
    const reports = service.collectReports();

    for (const report of reports) {
      expect(typeof report.department).toBe("string");
      expect(typeof report.summary).toBe("string");
      expect(typeof report.metrics).toBe("object");
      expect(typeof report.recommendation).toBe("string");
      expect(
        report.lastExecutedAt === null ||
          typeof report.lastExecutedAt === "string",
      ).toBe(true);
    }
  });

  it("command report reflects pending human inputs", () => {
    const now = new Date().toISOString();
    db.run(
      sql`INSERT INTO human_inputs (id, input_type, content, processed, created_at)
          VALUES ('hi-1', 'directive', '新テーマ', 0, ${now})`,
    );

    const service = new DepartmentExecutionServiceImpl(makeMinimalDeps());
    const reports = service.collectReports();
    const commandReport = reports.find((r) => r.department === "command");

    expect(commandReport).toBeDefined();
    expect(commandReport!.metrics.pendingInputs).toBe(1);
    expect(commandReport!.recommendation).toContain("process_human_inputs");
  });

  it("command report shows no-action when no pending inputs", () => {
    const service = new DepartmentExecutionServiceImpl(makeMinimalDeps());
    const reports = service.collectReports();
    const commandReport = reports.find((r) => r.department === "command");

    expect(commandReport!.metrics.pendingInputs).toBe(0);
    expect(commandReport!.recommendation).toBe("動く必要なし");
  });

  it("note report prioritizes generation when no published notes exist", () => {
    const service = new DepartmentExecutionServiceImpl(makeMinimalDeps());
    const reports = service.collectReports();
    const noteReport = reports.find((r) => r.department === "note");

    expect(noteReport).toBeDefined();
    expect(noteReport!.metrics.publishedNotes).toBe(0);
    expect(noteReport!.recommendation).toContain("最優先");
  });

  it("competitive analysis report highlights missing snapshots when none exist", () => {
    const service = new DepartmentExecutionServiceImpl(makeMinimalDeps());
    const reports = service.collectReports();
    const analysisReport = reports.find(
      (r) => r.department === "competitive-analysis",
    );

    expect(analysisReport).toBeDefined();
    expect(analysisReport!.metrics.snapshotCount).toBe(0);
    expect(analysisReport!.recommendation).toContain("蓄積");
  });

  it("report summary includes DB-backed current-state summary when present", () => {
    const now = new Date().toISOString();
    db.run(
      sql`INSERT INTO department_summaries (id, department, summary_type, content, period_key, created_at, updated_at)
          VALUES ('ds-cmd-1', 'command', 'daily', '前回: 指示を3件処理済み', '2024-01-01', ${now}, ${now})`,
    );

    const service = new DepartmentExecutionServiceImpl(makeMinimalDeps());
    const reports = service.collectReports();
    const commandReport = reports.find((r) => r.department === "command");

    expect(commandReport).toBeDefined();
    expect(commandReport!.summary).toContain("前回: 指示を3件処理済み");
  });

  it("report summary is live-only when no DB summary exists", () => {
    const service = new DepartmentExecutionServiceImpl(makeMinimalDeps());
    const reports = service.collectReports();
    const commandReport = reports.find((r) => r.department === "command");

    expect(commandReport).toBeDefined();
    expect(commandReport!.summary).not.toContain("前回の状態");
  });

  it("command report surfaces unread notifications from other departments", async () => {
    const researchService = new ResearchServiceImpl({
      search: async () => [],
    } as never);
    const llm = {
      generate: async () =>
        JSON.stringify([
          {
            source: "community",
            content: "AI副業では具体的な事例付きの投稿が伸びている",
            evidenceType: "trend",
            confidence: "high",
          },
        ]),
    } as never;

    await researchService.researchTopic("topic-1", "AI副業", llm);

    const now = new Date().toISOString();
    db.run(
      sql`INSERT INTO department_notifications (id, from_department, to_department, notification_type, content, read_at, created_at)
          VALUES ('notif-ca-1', 'competitive-analysis', 'command', 'analysis_complete', ${JSON.stringify({ winningPatterns: ["具体数字+逆張り"] })}, NULL, ${now})`,
    );

    const service = new DepartmentExecutionServiceImpl(makeMinimalDeps());
    const reports = service.collectReports();
    const commandReport = reports.find((r) => r.department === "command");

    expect(commandReport).toBeDefined();
    expect(commandReport!.summary).toContain("他部署からの通知2件");
    expect(commandReport!.summary).toContain(
      "[external-research→research_update]",
    );
    expect(commandReport!.summary).toContain(
      "[competitive-analysis→analysis_complete]",
    );
    expect(commandReport!.recommendation).toBe(
      "他部署通知を踏まえて全体判断を更新すべき",
    );

    const commandNotifications = db
      .select()
      .from(departmentNotifications)
      .all()
      .filter((row) => row.toDepartment === "command");

    expect(commandNotifications).toHaveLength(2);
    expect(
      commandNotifications.every((row) => row.readAt !== null),
    ).toBe(true);
  });
});