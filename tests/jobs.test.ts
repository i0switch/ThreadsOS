import { sql } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = ":memory:";

type Db = typeof import("../src/db/index.js")["db"];
type SchemaModule = typeof import("../src/db/schema.js");
type RunJob = typeof import("../src/jobs/runner.js")["runJob"];

let db: Db;
let schema: SchemaModule;
let runJob: RunJob;

beforeAll(async () => {
  vi.resetModules();

  ({ db } = await import("../src/db/index.js"));
  schema = await import("../src/db/schema.js");
  ({ runJob } = await import("../src/jobs/runner.js"));

  db.run(sql`CREATE TABLE IF NOT EXISTS scheduled_job_runs (
    id TEXT PRIMARY KEY,
    job_name TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    dry_run INTEGER NOT NULL DEFAULT 0,
    result_summary TEXT,
    created_at TEXT NOT NULL
  )`);
});

afterEach(() => {
  db.run(sql`DELETE FROM scheduled_job_runs`);
  vi.restoreAllMocks();
});

describe("runJob", () => {
  it("records a completed run and passes dryRun to the executor", async () => {
    const execute = vi.fn(async ({ dryRun }: { dryRun: boolean }) => {
      expect(dryRun).toBe(true);
      return "done";
    });

    await runJob({ name: "daily-topic-research", dryRun: true }, execute);

    expect(execute).toHaveBeenCalledTimes(1);

    const rows = db.select().from(schema.scheduledJobRuns).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].jobName).toBe("daily-topic-research");
    expect(rows[0].status).toBe("completed");
    expect(rows[0].dryRun).toBe(1);
    expect(rows[0].resultSummary).toBe("done");
    expect(rows[0].finishedAt).toBeTruthy();
  });

  it("stores failure details and rethrows executor errors", async () => {
    const execute = vi.fn(async () => {
      throw new Error("boom");
    });

    await expect(
      runJob({ name: "daily-topic-research" }, execute),
    ).rejects.toThrow("boom");

    expect(execute).toHaveBeenCalledTimes(1);

    const rows = db.select().from(schema.scheduledJobRuns).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].resultSummary).toBe("boom");
    expect(rows[0].finishedAt).toBeTruthy();
  });

  it("skips execution when the same job is already running", async () => {
    const now = new Date().toISOString();
    db.run(sql`INSERT INTO scheduled_job_runs (
      id, job_name, status, started_at, finished_at, dry_run, result_summary, created_at
    ) VALUES (
      'existing-run', 'daily-topic-research', 'running', ${now}, NULL, 0, NULL, ${now}
    )`);

    const execute = vi.fn(async () => "should not run");

    await runJob({ name: "daily-topic-research" }, execute);

    expect(execute).not.toHaveBeenCalled();

    const rows = db.select().from(schema.scheduledJobRuns).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("existing-run");
    expect(rows[0].status).toBe("running");
  });
});
