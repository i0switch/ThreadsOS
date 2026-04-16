import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = ":memory:";

type Db = typeof import("../src/db/index.js")["db"];
type SchemaModule = typeof import("../src/db/schema.js");
type ExecutiveExperimentServiceCtor =
  typeof import("../src/services/executive-experiment/index.js")["ExecutiveExperimentServiceImpl"];

let db: Db;
let schema: SchemaModule;
let ExecutiveExperimentServiceImpl: ExecutiveExperimentServiceCtor;

function insertThreadResult(input: {
  id: string;
  publishedAt: string;
  impressions: number;
  likes: number;
  repliesCount: number;
  shares: number;
  campaignId?: string | null;
}) {
  db.insert(schema.threadPostResults)
    .values({
      id: input.id,
      draftId: `${input.id}-draft`,
      threadsPostId: `${input.id}-post`,
      campaignId: input.campaignId ?? null,
      angleId: null,
      ctaId: null,
      canaryGroup: input.campaignId ? "canary" : null,
      impressions: input.impressions,
      likes: input.likes,
      repliesCount: input.repliesCount,
      shares: input.shares,
      publishedAt: input.publishedAt,
      createdAt: input.publishedAt,
    })
    .run();
}

function insertNoteResult(input: {
  id: string;
  publishedAt: string;
  views: number;
  likes: number;
  commentsCount: number;
  purchasesCount: number;
  revenueYen: number;
  campaignId?: string | null;
}) {
  db.insert(schema.notePostResults)
    .values({
      id: input.id,
      draftId: `${input.id}-draft`,
      title: `${input.id}-title`,
      noteUrl: `https://example.com/${input.id}`,
      priceYen: 980,
      campaignId: input.campaignId ?? null,
      angleId: null,
      ctaId: null,
      priceVariantId: null,
      canaryGroup: input.campaignId ? "canary" : null,
      views: input.views,
      likes: input.likes,
      commentsCount: input.commentsCount,
      purchasesCount: input.purchasesCount,
      revenueYen: input.revenueYen,
      conversionRate: input.views > 0 ? input.purchasesCount / input.views : 0,
      trafficSource: "test",
      publishedAt: input.publishedAt,
      createdAt: input.publishedAt,
    })
    .run();
}

beforeAll(async () => {
  ({ db } = await import("../src/db/index.js"));
  schema = await import("../src/db/schema.js");
  const { ensureAutonomyTables } = await import("../src/db/bootstrap.js");
  ({ ExecutiveExperimentServiceImpl } = await import(
    "../src/services/executive-experiment/index.js"
  ));

  ensureAutonomyTables();
});

beforeEach(() => {
  db.delete(schema.decisionEvidence).run();
  db.delete(schema.experimentResults).run();
  db.delete(schema.experiments).run();
  db.delete(schema.winningPatterns).run();
  db.delete(schema.losingPatterns).run();
  db.delete(schema.funnelSnapshots).run();
  db.delete(schema.notePostResults).run();
  db.delete(schema.threadPostResults).run();
});

describe("ExecutiveExperimentService", () => {
  it("detects the Click bottleneck and registers one experiment with scoring windows", () => {
    const service = new ExecutiveExperimentServiceImpl();
    const now = new Date("2026-04-15T12:00:00.000Z");

    insertThreadResult({
      id: "baseline-thread",
      publishedAt: "2026-04-09T10:00:00.000Z",
      impressions: 1400,
      likes: 140,
      repliesCount: 20,
      shares: 18,
    });
    insertNoteResult({
      id: "baseline-note",
      publishedAt: "2026-04-09T11:00:00.000Z",
      views: 220,
      likes: 40,
      commentsCount: 12,
      purchasesCount: 6,
      revenueYen: 9600,
    });

    insertThreadResult({
      id: "current-thread",
      publishedAt: "2026-04-14T10:00:00.000Z",
      impressions: 1500,
      likes: 110,
      repliesCount: 12,
      shares: 10,
    });

    const plan = service.planHeartbeatExperiment({
      cycleId: "cycle-click",
      heartbeatPeriodKey: "hb-2026-04-15T12",
      candidateActions: [
        { type: "generate_and_post", priority: 1, reason: "due threads slot" },
        { type: "generate_note", priority: 2, reason: "daily note" },
      ],
      approvedActions: [
        { type: "generate_and_post", priority: 1, reason: "due threads slot" },
      ],
      now,
    });

    expect(plan).not.toBeNull();
    expect(plan?.diagnosis.bottleneck).toBe("Click");
    expect(plan?.candidates.length).toBeLessThanOrEqual(3);
    expect(plan?.executionContext.actionType).toBe("generate_and_post");

    const experimentRows = db.select().from(schema.experiments).all();
    const resultRows = db.select().from(schema.experimentResults).all();
    const evidenceRows = db.select().from(schema.decisionEvidence).all();
    const funnelRows = db.select().from(schema.funnelSnapshots).all();

    expect(experimentRows).toHaveLength(1);
    expect(resultRows).toHaveLength(2);
    expect(resultRows.map((row) => row.windowHours).sort()).toEqual([24, 72]);
    expect(evidenceRows.some((row) => row.decisionType === "selected")).toBe(
      true,
    );
    expect(funnelRows).toHaveLength(1);
  });

  it("promotes a winning canary at 72h and updates winning_patterns", () => {
    const service = new ExecutiveExperimentServiceImpl();
    const now = new Date("2026-04-15T12:00:00.000Z");

    insertThreadResult({
      id: "baseline-thread",
      publishedAt: "2026-04-09T10:00:00.000Z",
      impressions: 1200,
      likes: 100,
      repliesCount: 14,
      shares: 12,
    });
    insertNoteResult({
      id: "baseline-note",
      publishedAt: "2026-04-09T11:00:00.000Z",
      views: 100,
      likes: 18,
      commentsCount: 6,
      purchasesCount: 2,
      revenueYen: 2000,
    });

    insertThreadResult({
      id: "current-thread",
      publishedAt: "2026-04-14T09:00:00.000Z",
      impressions: 1300,
      likes: 90,
      repliesCount: 10,
      shares: 9,
    });
    insertNoteResult({
      id: "current-note",
      publishedAt: "2026-04-14T10:00:00.000Z",
      views: 120,
      likes: 22,
      commentsCount: 5,
      purchasesCount: 0,
      revenueYen: 0,
    });

    const plan = service.planHeartbeatExperiment({
      cycleId: "cycle-promote",
      heartbeatPeriodKey: "hb-2026-04-15T12",
      candidateActions: [
        { type: "generate_note", priority: 1, reason: "due note slot" },
      ],
      approvedActions: [
        { type: "generate_note", priority: 1, reason: "due note slot" },
      ],
      now,
    });

    expect(plan?.diagnosis.bottleneck).toBe("Buy");
    expect(plan?.executionContext.actionType).toBe("generate_note");
    if (!plan) {
      throw new Error("expected phase 4 experiment plan");
    }

    service.markCanaryLaunched({
      experimentId: plan.experimentId,
      publishedCount: 1,
      launchedAt: "2026-04-12T11:00:00.000Z",
    });

    insertNoteResult({
      id: "canary-note",
      publishedAt: "2026-04-14T18:00:00.000Z",
      views: 100,
      likes: 20,
      commentsCount: 8,
      purchasesCount: 4,
      revenueYen: 6000,
      campaignId: plan.experimentId,
    });

    const evaluation = service.evaluateDueExperiments(now);

    expect(evaluation.promotedCount).toBe(1);
    expect(evaluation.rejectedCount).toBe(0);

    const experimentRow = db
      .select()
      .from(schema.experiments)
      .where(eq(schema.experiments.id, plan.experimentId))
      .get();
    const winningRows = db.select().from(schema.winningPatterns).all();
    const evidenceRows = db
      .select()
      .from(schema.decisionEvidence)
      .where(eq(schema.decisionEvidence.entityId, plan.experimentId))
      .all();

    expect(experimentRow?.status).toBe("promoted");
    expect(winningRows).toHaveLength(1);
    expect(
      evidenceRows.some((row) => row.decisionType === "canary_launched"),
    ).toBe(true);
    expect(
      evidenceRows.some((row) => row.decisionType === "evaluate_24h"),
    ).toBe(true);
    expect(
      evidenceRows.some((row) => row.decisionType === "evaluate_72h"),
    ).toBe(true);
  });

  it("rejects a weak canary at 24h and updates losing_patterns", () => {
    const service = new ExecutiveExperimentServiceImpl();
    const now = new Date("2026-04-15T12:00:00.000Z");

    insertThreadResult({
      id: "baseline-thread",
      publishedAt: "2026-04-09T10:00:00.000Z",
      impressions: 1250,
      likes: 100,
      repliesCount: 16,
      shares: 11,
    });
    insertNoteResult({
      id: "baseline-note",
      publishedAt: "2026-04-09T11:00:00.000Z",
      views: 120,
      likes: 18,
      commentsCount: 7,
      purchasesCount: 3,
      revenueYen: 3600,
    });

    insertThreadResult({
      id: "current-thread",
      publishedAt: "2026-04-14T09:00:00.000Z",
      impressions: 1150,
      likes: 80,
      repliesCount: 10,
      shares: 8,
    });
    insertNoteResult({
      id: "current-note",
      publishedAt: "2026-04-14T10:00:00.000Z",
      views: 100,
      likes: 14,
      commentsCount: 4,
      purchasesCount: 0,
      revenueYen: 0,
    });

    const plan = service.planHeartbeatExperiment({
      cycleId: "cycle-reject",
      heartbeatPeriodKey: "hb-2026-04-15T12",
      candidateActions: [
        { type: "generate_note", priority: 1, reason: "due note slot" },
      ],
      approvedActions: [
        { type: "generate_note", priority: 1, reason: "due note slot" },
      ],
      now,
    });

    if (!plan) {
      throw new Error("expected phase 4 experiment plan");
    }

    service.markCanaryLaunched({
      experimentId: plan.experimentId,
      publishedCount: 1,
      launchedAt: "2026-04-14T11:00:00.000Z",
    });

    insertNoteResult({
      id: "canary-note-weak",
      publishedAt: "2026-04-15T08:00:00.000Z",
      views: 80,
      likes: 10,
      commentsCount: 2,
      purchasesCount: 1,
      revenueYen: 200,
      campaignId: plan.experimentId,
    });

    const evaluation = service.evaluateDueExperiments(now);

    expect(evaluation.promotedCount).toBe(0);
    expect(evaluation.rejectedCount).toBe(1);

    const experimentRow = db
      .select()
      .from(schema.experiments)
      .where(eq(schema.experiments.id, plan.experimentId))
      .get();
    const losingRows = db.select().from(schema.losingPatterns).all();
    const resultRows = db
      .select()
      .from(schema.experimentResults)
      .where(eq(schema.experimentResults.experimentId, plan.experimentId))
      .all();

    expect(experimentRow?.status).toBe("rejected");
    expect(losingRows).toHaveLength(1);
    expect(resultRows.some((row) => row.status === "cancelled")).toBe(true);
  });
});
