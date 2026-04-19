import { sql } from "drizzle-orm";
import Fastify from "fastify";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = ":memory:";

type Db = typeof import("../src/db/index.js")["db"];
type SchemaModule = typeof import("../src/db/schema.js");
type DashboardRoutes =
  typeof import("../src/dashboard/routes.js")["dashboardRoutes"];

let db: Db;
let schema: SchemaModule;
let dashboardRoutes: DashboardRoutes;

const now = new Date().toISOString();

async function resetState() {
  db.run(sql`DELETE FROM runner_budget`);
  db.run(sql`DELETE FROM runner_health`);
  db.run(sql`DELETE FROM session_health`);
  db.run(sql`DELETE FROM execution_outbox`);
  db.run(sql`DELETE FROM anomaly_events`);
  db.run(sql`DELETE FROM decision_evidence`);
  db.run(sql`DELETE FROM rollbacks`);
  db.run(sql`DELETE FROM funnel_snapshots`);
  db.run(sql`DELETE FROM thread_post_audits`);
  db.run(sql`DELETE FROM note_audits`);
}

async function seedObservationState() {
  db.insert(schema.runnerHealth)
    .values({
      runner: "claude",
      status: "healthy",
      consecutiveFailures: 0,
      timeoutCount: 0,
      invalidJsonCount: 0,
      totalCalls: 8,
      lastModel: "claude-sonnet",
      lastError: null,
      lastDurationMs: 3200,
      lastSuccessAt: now,
      lastFailureAt: null,
      updatedAt: now,
    })
    .run();

  db.insert(schema.runnerBudgets)
    .values({
      id: "runner-budget-1",
      runner: "claude",
      periodKey: "2026-04-15T10",
      tokensUsed: 1800,
      callsUsed: 8,
      tokensLimit: 10000,
      callsLimit: 40,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  db.insert(schema.sessionHealth)
    .values({
      scope: "note",
      provider: "note",
      state: "healthy",
      consecutiveFailures: 0,
      lastSuccessAt: now,
      lastFailureAt: null,
      detail: "browser session healthy",
      metadataJson: JSON.stringify({ browser: true }),
      createdAt: now,
      updatedAt: now,
    })
    .run();

  db.insert(schema.executionOutbox)
    .values({
      id: "outbox-1",
      idempotencyKey: "publish:threads:slot-1:d1",
      payloadHash: "hash-1",
      targetPlatform: "threads",
      operationType: "publish",
      status: "failed",
      payloadJson: JSON.stringify({ slotId: "slot-1", draftId: "d1" }),
      availableAt: now,
      claimedBy: null,
      claimedAt: null,
      attempts: 2,
      lastError: "upstream timeout",
      createdAt: now,
      updatedAt: now,
    })
    .run();

  db.insert(schema.funnelSnapshots)
    .values({
      id: "funnel-1",
      periodKey: "2026-04-15T10",
      periodType: "hourly",
      impressions: 1000,
      profileTransitions: 50,
      noteClicks: 10,
      noteViews: 8,
      purchases: 1,
      revenue: 1980,
      capturedAt: now,
      createdAt: now,
    })
    .run();

  db.insert(schema.threadPostAudits)
    .values({
      id: "thread-audit-1",
      draftId: "thread-draft-1",
      verdict: "revise",
      severity: "medium",
      reasons: JSON.stringify(["hook weak"]),
      suggestions: JSON.stringify(["tighten opening"]),
      createdAt: now,
    })
    .run();

  db.insert(schema.noteAudits)
    .values({
      id: "note-audit-1",
      draftId: "note-draft-1",
      verdict: "reject",
      strongestSection: "導入",
      weakestSection: "CTA",
      rewriteGuidance: "価格訴求を弱める",
      score: 3,
      createdAt: now,
    })
    .run();
}

beforeAll(async () => {
  ({ db } = await import("../src/db/index.js"));
  schema = await import("../src/db/schema.js");
  ({ dashboardRoutes } = await import("../src/dashboard/routes.js"));
  const { ensureAutonomyTables } = await import("../src/db/bootstrap.js");
  ensureAutonomyTables();
});

beforeEach(async () => {
  await resetState();
  await seedObservationState();
});

describe("dashboard observation API", () => {
  it("serves observation-first data with five runtime contracts", async () => {
    const app = Fastify();
    await app.register(dashboardRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/dashboard/observation",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.mode.current).toBe("observe_only");
    expect(body.contracts.summary.agents).toBe(5);
    expect(
      body.auditor.items.every(
        (item: { source: string }) => item.source !== "legacy_review_queue",
      ),
    ).toBe(true);
    await app.close();
  });

  it("does not expose legacy query or mutation endpoints", async () => {
    const app = Fastify();
    await app.register(dashboardRoutes);

    const summary = await app.inject({
      method: "GET",
      url: "/api/dashboard/summary",
    });
    const proposal = await app.inject({
      method: "GET",
      url: "/api/dashboard/proposals/p1",
    });
    const control = await app.inject({
      method: "POST",
      url: "/api/dashboard/control/pause",
    });

    expect(summary.statusCode).toBe(404);
    expect(proposal.statusCode).toBe(404);
    expect(control.statusCode).toBe(404);
    await app.close();
  });
});
