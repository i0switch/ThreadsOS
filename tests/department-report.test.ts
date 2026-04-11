import { sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = ":memory:";

type Db = typeof import("../src/db/index.js")["db"];
type DepartmentExecutionServiceImplCtor =
  typeof import("../src/services/department-execution/index.js")["DepartmentExecutionServiceImpl"];

let db: Db;
let DepartmentExecutionServiceImpl: DepartmentExecutionServiceImplCtor;

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
  db.run(sql`DELETE FROM department_summaries`);
});

describe("DepartmentExecution collectReports()", () => {
  it("returns a report for each of the 6 departments", () => {
    const service = new DepartmentExecutionServiceImpl(makeMinimalDeps());
    const reports = service.collectReports();

    expect(reports).toHaveLength(6);

    const departments = reports.map((r) => r.department);
    expect(departments).toContain("command");
    expect(departments).toContain("research");
    expect(departments).toContain("threads");
    expect(departments).toContain("note");
    expect(departments).toContain("community");
    expect(departments).toContain("optimization");
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

  it("optimization report recommends retro when none has ever run", () => {
    const service = new DepartmentExecutionServiceImpl(makeMinimalDeps());
    const reports = service.collectReports();
    const optReport = reports.find((r) => r.department === "optimization");

    expect(optReport).toBeDefined();
    expect(optReport!.metrics.daysSinceRetro).toBeGreaterThanOrEqual(7);
    expect(optReport!.recommendation).toContain("振り返り");
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
});