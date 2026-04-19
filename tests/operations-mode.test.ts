import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../src/db/schema.js";

vi.mock("../src/db/index.js", () => {
  const sqlite = new Database(":memory:");
  const mockDb = drizzle(sqlite, { schema });
  return { db: mockDb };
});

import { ensureAutonomyTables } from "../src/db/bootstrap.js";
import { db } from "../src/db/index.js";
import { createOperationsModeService } from "../src/services/operations-mode/index.js";

function insertHealthyNoteSession(): void {
  const now = new Date().toISOString();
  db.insert(schema.sessionHealth)
    .values({
      scope: "note",
      state: "healthy",
      provider: "note.com",
      consecutiveFailures: 0,
      lastFailureAt: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

describe("operations-mode service", () => {
  beforeEach(() => {
    ensureAutonomyTables();
    db.delete(schema.operationsModeState).run();
    db.delete(schema.anomalyEvents).run();
    db.delete(schema.runnerHealth).run();
    db.delete(schema.scheduledJobRuns).run();
    db.delete(schema.sessionHealth).run();
    db.delete(schema.systemControls).run();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stays in full_autonomy when monitored systems are healthy", () => {
    insertHealthyNoteSession();
    const service = createOperationsModeService();

    const evaluation = service.reconcileMode();

    expect(evaluation.mode).toBe("full_autonomy");
    expect(evaluation.changed).toBe(true);
    const persisted = db.select().from(schema.operationsModeState).all();
    expect(persisted).toHaveLength(1);
    expect(persisted[0].mode).toBe("full_autonomy");
  });

  it("transitions to threads_only when note session is quarantined", () => {
    const now = new Date().toISOString();
    db.insert(schema.sessionHealth)
      .values({
        scope: "note",
        state: "quarantined",
        provider: "note.com",
        consecutiveFailures: 3,
        lastFailureAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const service = createOperationsModeService();
    const evaluation = service.reconcileMode();

    expect(evaluation.mode).toBe("threads_only");
    expect(evaluation.reason).toContain("note session");
    expect(service.isChannelWritable("threads")).toBe(true);
    expect(service.isChannelWritable("note")).toBe(false);
  });

  it("transitions to observe_only when a critical runner is tripped", () => {
    insertHealthyNoteSession();
    const now = new Date().toISOString();
    db.insert(schema.runnerHealth)
      .values({
        runner: "claude",
        status: "tripped",
        consecutiveFailures: 4,
        timeoutCount: 2,
        invalidJsonCount: 0,
        totalCalls: 10,
        updatedAt: now,
      })
      .run();

    const service = createOperationsModeService();
    const evaluation = service.reconcileMode();

    expect(evaluation.mode).toBe("observe_only");
    expect(service.getActionDecision("generate_and_post").allowed).toBe(false);
    expect(service.getActionDecision("fetch_engagement").allowed).toBe(true);
  });

  it("stays in full_autonomy when only the advisory codex runner is tripped", () => {
    insertHealthyNoteSession();
    const now = new Date().toISOString();
    db.insert(schema.runnerHealth)
      .values({
        runner: "codex",
        status: "tripped",
        consecutiveFailures: 3,
        timeoutCount: 0,
        invalidJsonCount: 0,
        totalCalls: 3,
        lastError: "Codex CLI 起動失敗: spawnSync codex ENOENT",
        updatedAt: now,
      })
      .run();

    const service = createOperationsModeService();
    const evaluation = service.reconcileMode();

    expect(evaluation.mode).toBe("full_autonomy");
    expect(service.getActionDecision("generate_and_post").allowed).toBe(true);
  });

  it("does not safe_freeze from repeated identical executive fallback anomalies alone", () => {
    insertHealthyNoteSession();
    const now = new Date();
    for (let i = 0; i < 3; i += 1) {
      db.insert(schema.anomalyEvents)
        .values({
          id: `anomaly-${i}`,
          category: "executive_runner_failure",
          severity: "high",
          message:
            "Executive LLM request failed; safe-stop applied. Connected anomalies feed operations-mode safe_freeze trigger.",
          metadataJson: JSON.stringify({ index: i }),
          detectedAt: new Date(now.getTime() - i * 60_000).toISOString(),
          createdAt: new Date(now.getTime() - i * 60_000).toISOString(),
        })
        .run();
    }

    const service = createOperationsModeService();
    const evaluation = service.reconcileMode();

    expect(evaluation.mode).toBe("full_autonomy");
  });

  it("transitions to safe_freeze when three distinct high anomalies are recent", () => {
    insertHealthyNoteSession();
    const now = new Date();
    const anomalies = [
      {
        id: "anomaly-exec",
        category: "executive_runner_failure",
        message: "Executive LLM request failed",
      },
      {
        id: "anomaly-research",
        category: "research_pipeline_failure",
        message: "research parser corrupted cache",
      },
      {
        id: "anomaly-strategy",
        category: "strategy_state_corruption",
        message: "strategy state checksum mismatch",
      },
    ];

    db.insert(schema.anomalyEvents)
      .values(
        anomalies.map((anomaly, index) => ({
          ...anomaly,
          severity: "high",
          metadataJson: JSON.stringify({ index }),
          detectedAt: new Date(now.getTime() - index * 60_000).toISOString(),
          createdAt: new Date(now.getTime() - index * 60_000).toISOString(),
        })),
      )
      .run();

    const service = createOperationsModeService();
    const evaluation = service.reconcileMode();

    expect(evaluation.mode).toBe("safe_freeze");
  });

  it("enters observe_only for a single latest publish failure", () => {
    insertHealthyNoteSession();
    const now = Date.now();
    db.insert(schema.scheduledJobRuns)
      .values([
        {
          id: "job-hourly-failed",
          jobName: "hourly-heartbeat",
          status: "failed",
          startedAt: new Date(now - 20 * 60_000).toISOString(),
          finishedAt: new Date(now - 19 * 60_000).toISOString(),
          dryRun: 0,
          resultSummary: "codex runner is circuit-open",
          createdAt: new Date(now - 20 * 60_000).toISOString(),
        },
        {
          id: "job-hourly-ok",
          jobName: "hourly-heartbeat",
          status: "completed",
          startedAt: new Date(now - 10 * 60_000).toISOString(),
          finishedAt: new Date(now - 9 * 60_000).toISOString(),
          dryRun: 0,
          resultSummary: "ok",
          createdAt: new Date(now - 10 * 60_000).toISOString(),
        },
        {
          id: "job-note-failed",
          jobName: "nightly-note-pipeline",
          status: "failed",
          startedAt: new Date(now - 5 * 60_000).toISOString(),
          finishedAt: new Date(now - 4 * 60_000).toISOString(),
          dryRun: 0,
          resultSummary: "codex runner is circuit-open",
          createdAt: new Date(now - 5 * 60_000).toISOString(),
        },
      ])
      .run();

    const service = createOperationsModeService();
    const evaluation = service.reconcileMode();

    expect(evaluation.mode).toBe("observe_only");
  });

  it("transitions to observe_only when multiple latest publish jobs are failed", () => {
    insertHealthyNoteSession();
    const now = Date.now();
    db.insert(schema.scheduledJobRuns)
      .values([
        {
          id: "job-hourly-failed",
          jobName: "hourly-heartbeat",
          status: "failed",
          startedAt: new Date(now - 10 * 60_000).toISOString(),
          finishedAt: new Date(now - 9 * 60_000).toISOString(),
          dryRun: 0,
          resultSummary: "codex runner is circuit-open",
          createdAt: new Date(now - 10 * 60_000).toISOString(),
        },
        {
          id: "job-note-failed",
          jobName: "nightly-note-pipeline",
          status: "failed",
          startedAt: new Date(now - 5 * 60_000).toISOString(),
          finishedAt: new Date(now - 4 * 60_000).toISOString(),
          dryRun: 0,
          resultSummary: "codex runner is circuit-open",
          createdAt: new Date(now - 5 * 60_000).toISOString(),
        },
      ])
      .run();

    const service = createOperationsModeService();
    const evaluation = service.reconcileMode();

    expect(evaluation.mode).toBe("observe_only");
  });

  it("transitions to safe_freeze when a global pause is active", () => {
    const now = new Date().toISOString();
    db.insert(schema.systemControls)
      .values({
        id: "pause-global",
        scope: "global",
        action: "pause",
        reason: "manual freeze",
        createdBy: "system",
        active: 1,
        createdAt: now,
        resolvedAt: null,
      })
      .run();

    const service = createOperationsModeService();
    const evaluation = service.reconcileMode();

    expect(evaluation.mode).toBe("safe_freeze");
    expect(service.getActionDecision("notify").allowed).toBe(true);
    expect(service.getActionDecision("fetch_engagement").allowed).toBe(false);
  });

  it("records previous mode when transitioning between states", () => {
    insertHealthyNoteSession();
    const service = createOperationsModeService();
    const first = service.reconcileMode();
    expect(first.mode).toBe("full_autonomy");

    const now = new Date().toISOString();
    db.update(schema.sessionHealth)
      .set({
        state: "degraded",
        provider: "note-browser",
        consecutiveFailures: 1,
        lastFailureAt: now,
        updatedAt: now,
      })
      .where(eq(schema.sessionHealth.scope, "note"))
      .run();

    const second = service.reconcileMode();
    expect(second.mode).toBe("threads_only");
    expect(second.previousMode).toBe("full_autonomy");
    expect(second.changed).toBe(true);
  });
});
