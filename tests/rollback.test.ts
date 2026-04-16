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
import { createRollbackService } from "../src/services/rollback/index.js";

describe("rollback service", () => {
  beforeEach(() => {
    ensureAutonomyTables();
    db.delete(schema.anomalyEvents).run();
    db.delete(schema.funnelSnapshots).run();
    db.delete(schema.improvementInsights).run();
    db.delete(schema.rollbacks).run();
    db.delete(schema.winningPatterns).run();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not request rollback when snapshots are insufficient", () => {
    const service = createRollbackService();
    const decision = service.evaluate();

    expect(decision.shouldRollback).toBe(false);
    expect(decision.reason).toContain("not enough");
  });

  it("applies note rollback to the latest winning pattern when purchase rate drops", () => {
    const now = new Date().toISOString();
    db.insert(schema.funnelSnapshots)
      .values({
        id: "previous",
        periodKey: "2026-04-14T08",
        periodType: "hourly",
        impressions: 1000,
        profileTransitions: 100,
        noteClicks: 60,
        noteViews: 50,
        purchases: 10,
        revenue: 10000,
        capturedAt: "2026-04-14T08:00:00.000Z",
        createdAt: now,
      })
      .run();
    db.insert(schema.funnelSnapshots)
      .values({
        id: "latest",
        periodKey: "2026-04-14T09",
        periodType: "hourly",
        impressions: 1100,
        profileTransitions: 90,
        noteClicks: 55,
        noteViews: 40,
        purchases: 2,
        revenue: 2000,
        capturedAt: "2026-04-14T09:00:00.000Z",
        createdAt: now,
      })
      .run();

    const service = createRollbackService();
    const patternId = service.recordWinningPattern({
      channel: "note",
      sourceType: "note",
      sourceId: "winner-1",
      insight: "高CVの導入と価格帯が効いていた",
      action: "前回勝ち型の導入構成と価格帯に戻す",
      metricName: "purchase_rate",
      metricValue: 0.2,
    });

    const result = service.applyIfNeeded();

    expect(result.shouldRollback).toBe(true);
    expect(result.applied).toBe(true);
    expect(result.channel).toBe("note");

    const rollbackRows = db.select().from(schema.rollbacks).all();
    expect(rollbackRows).toHaveLength(1);
    expect(rollbackRows[0].scope).toBe("note");
    expect(rollbackRows[0].trigger).toBe("purchase_rate_drop");

    const appliedState = JSON.parse(
      rollbackRows[0].appliedStateJson ?? "{}",
    ) as Record<string, string>;
    expect(appliedState.targetPatternId).toBe(patternId);
    expect(appliedState.targetAction).toContain("前回勝ち型");

    const insightRows = db.select().from(schema.improvementInsights).all();
    expect(insightRows).toHaveLength(1);
    expect(insightRows[0].sourceType).toBe("note");
    expect(insightRows[0].action).toContain("前回勝ち型");
  });

  it("detects threads rollback when profile transition rate drops", () => {
    const now = new Date().toISOString();
    db.insert(schema.funnelSnapshots)
      .values({
        id: "threads-prev",
        periodKey: "2026-04-14T10",
        periodType: "hourly",
        impressions: 1000,
        profileTransitions: 120,
        noteClicks: 30,
        noteViews: 20,
        purchases: 3,
        revenue: 3000,
        capturedAt: "2026-04-14T10:00:00.000Z",
        createdAt: now,
      })
      .run();
    db.insert(schema.funnelSnapshots)
      .values({
        id: "threads-latest",
        periodKey: "2026-04-14T11",
        periodType: "hourly",
        impressions: 1000,
        profileTransitions: 50,
        noteClicks: 20,
        noteViews: 15,
        purchases: 3,
        revenue: 3000,
        capturedAt: "2026-04-14T11:00:00.000Z",
        createdAt: now,
      })
      .run();

    const service = createRollbackService();
    service.recordWinningPattern({
      channel: "threads",
      sourceType: "thread_post",
      sourceId: "winner-thread-1",
      insight: "強いフックと明確CTAが効いていた",
      action: "強いフックとCTAの型へ戻す",
      metricName: "profile_transition_rate",
      metricValue: 0.12,
    });

    const decision = service.evaluate();

    expect(decision.shouldRollback).toBe(true);
    expect(decision.channel).toBe("threads");
    expect(decision.reason).toContain("profile transition");
    expect(decision.targetPattern?.action).toContain("フック");
  });

  it("does not duplicate rollback for the same trigger snapshot", () => {
    const now = new Date().toISOString();
    db.insert(schema.funnelSnapshots)
      .values({
        id: "prev",
        periodKey: "2026-04-14T12",
        periodType: "hourly",
        impressions: 1000,
        profileTransitions: 90,
        noteClicks: 50,
        noteViews: 40,
        purchases: 8,
        revenue: 8000,
        capturedAt: "2026-04-14T12:00:00.000Z",
        createdAt: now,
      })
      .run();
    db.insert(schema.funnelSnapshots)
      .values({
        id: "next",
        periodKey: "2026-04-14T13",
        periodType: "hourly",
        impressions: 1000,
        profileTransitions: 80,
        noteClicks: 45,
        noteViews: 35,
        purchases: 2,
        revenue: 2000,
        capturedAt: "2026-04-14T13:00:00.000Z",
        createdAt: now,
      })
      .run();

    const service = createRollbackService();
    service.recordWinningPattern({
      channel: "note",
      sourceType: "note",
      sourceId: "winner-2",
      insight: "価格訴求が効いていた",
      action: "前回の価格訴求パターンへ戻す",
      metricName: "purchase_rate",
      metricValue: 0.2,
    });

    const first = service.applyIfNeeded();
    const second = service.applyIfNeeded();

    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(db.select().from(schema.rollbacks).all()).toHaveLength(1);
  });
});
