import Database from "better-sqlite3";
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

  it("transitions to observe_only when a runner is tripped", () => {
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
    const service = createOperationsModeService();
    const first = service.reconcileMode();
    expect(first.mode).toBe("full_autonomy");

    const now = new Date().toISOString();
    db.insert(schema.sessionHealth)
      .values({
        scope: "note",
        state: "degraded",
        provider: "note-browser",
        consecutiveFailures: 1,
        lastFailureAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const second = service.reconcileMode();
    expect(second.mode).toBe("threads_only");
    expect(second.previousMode).toBe("full_autonomy");
    expect(second.changed).toBe(true);
  });
});
