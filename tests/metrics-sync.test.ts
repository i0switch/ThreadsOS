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
import { MetricsSyncServiceImpl } from "../src/services/metrics-sync/index.js";

type TestDb = typeof db & { $client: Database.Database };

function clearTables() {
  const sqlite = (db as TestDb).$client;
  sqlite.exec(`
    DELETE FROM note_metrics;
    DELETE FROM threads_metrics;
    DELETE FROM revenue_events;
    DELETE FROM funnel_snapshots;
    DELETE FROM session_health;
    DELETE FROM anomaly_events;
    DELETE FROM runner_health;
    DELETE FROM strategy_states;
    DELETE FROM publication_events;
    DELETE FROM note_post_results;
    DELETE FROM note_drafts;
    DELETE FROM note_ideas;
    DELETE FROM thread_post_results;
    DELETE FROM thread_post_drafts;
  `);
}

describe("metrics sync service", () => {
  beforeEach(() => {
    process.env.NOTE_MODE = "browser_assisted";
    process.env.NOTE_STORAGE_STATE_PATH = "data/note-storage-state.json";
    process.env.NOTE_PLAYWRIGHT_HEADLESS = "true";
    ensureAutonomyTables();
    clearTables();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("syncs note and Threads metrics, preserves metadata, and writes safety flags", async () => {
    const now = new Date().toISOString();

    db.insert(schema.noteIdeas)
      .values({
        id: "idea-1",
        sourceTopicId: "topic-1",
        angle: "angle-label",
        targetReader: "reader",
        priorityScore: 80,
        status: "drafted",
        createdAt: now,
      })
      .run();
    db.insert(schema.noteDrafts)
      .values({
        id: "draft-note-1",
        ideaId: "idea-1",
        title: "note title",
        body: "body",
        outline: "outline",
        cta: "cta text",
        campaignId: "campaign-1",
        angleId: "angle-1",
        ctaId: "cta-1",
        priceVariantId: "price-1",
        canaryGroup: "canary-1",
        status: "audited",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(schema.notePostResults)
      .values({
        id: "note-result-1",
        draftId: "draft-note-1",
        title: "note title",
        noteUrl: "https://note.com/example/n/1",
        priceYen: 980,
        campaignId: null,
        angleId: null,
        ctaId: null,
        priceVariantId: null,
        canaryGroup: null,
        views: 0,
        likes: 0,
        commentsCount: 0,
        purchasesCount: 0,
        revenueYen: 0,
        conversionRate: 0,
        trafficSource: "threads",
        publishedAt: now,
        createdAt: now,
      })
      .run();
    db.insert(schema.publicationEvents)
      .values({
        id: "pub-note-1",
        targetPlatform: "note",
        outboxId: null,
        draftId: "draft-note-1",
        slotId: null,
        campaignId: "campaign-1",
        angleId: "angle-1",
        ctaId: "cta-1",
        priceVariantId: "price-1",
        canaryGroup: "canary-1",
        externalId: "note-1",
        externalUrl: "https://note.com/example/n/1",
        externalFingerprint: "note:1",
        publishedAt: now,
        createdAt: now,
      })
      .run();

    db.insert(schema.threadPostDrafts)
      .values({
        id: "thread-draft-1",
        topicId: "topic-1",
        body: "thread body",
        hookType: "hook",
        ctaType: "cta",
        noteTransition: null,
        campaignId: "campaign-thread",
        angleId: "angle-thread",
        ctaId: "cta-thread",
        canaryGroup: "canary-thread",
        status: "audited",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(schema.threadPostResults)
      .values({
        id: "thread-result-1",
        draftId: "thread-draft-1",
        threadsPostId: "threads-post-1",
        campaignId: null,
        angleId: null,
        ctaId: null,
        canaryGroup: null,
        impressions: 10,
        likes: 1,
        repliesCount: 0,
        shares: 0,
        publishedAt: now,
        createdAt: now,
      })
      .run();
    db.insert(schema.publicationEvents)
      .values({
        id: "pub-thread-1",
        targetPlatform: "threads",
        outboxId: null,
        draftId: "thread-draft-1",
        slotId: null,
        campaignId: "campaign-thread",
        angleId: "angle-thread",
        ctaId: "cta-thread",
        priceVariantId: null,
        canaryGroup: "canary-thread",
        externalId: "threads-post-1",
        externalUrl: "https://threads.net/p/1",
        externalFingerprint: "threads:1",
        publishedAt: now,
        createdAt: now,
      })
      .run();

    const noteApi = {
      getMyArticles: vi.fn().mockResolvedValue([
        {
          id: "note-1",
          title: "note title",
          url: "https://note.com/example/n/1",
          views: 100,
          likes: 12,
          comments: 2,
        },
      ]),
      getArticleStats: vi.fn().mockResolvedValue({
        views: 100,
        likes: 12,
        comments: 2,
        priceYen: 980,
        purchasesCount: 2,
        revenueYen: 1960,
        conversionRate: 0.02,
      }),
    };
    const threadsApi = {
      getInsights: vi.fn().mockResolvedValue({
        impressions: 1200,
        likes: 80,
        replies: 10,
        shares: 4,
        views: 0,
      }),
    } as unknown as Parameters<
      MetricsSyncServiceImpl["syncAll"]
    >[0]["threadsApi"];

    const service = new MetricsSyncServiceImpl({
      browserSessionVerifier: vi.fn().mockResolvedValue({
        ok: true,
        detail: "session ok",
      }),
    });

    const result = await service.syncAll({
      noteApi,
      threadsApi,
    });

    expect(result.noteSessionState).toBe("healthy");
    expect(result.noteArticlesSynced).toBe(1);
    expect(result.threadPostsSynced).toBe(1);
    expect(result.noteMetricsSnapshots).toBe(1);
    expect(result.threadsMetricsSnapshots).toBe(1);
    expect(result.revenueEventsRecorded).toBe(1);
    expect(result.allowAggressiveExperiments).toBe(false);

    const syncedNote = db
      .select()
      .from(schema.notePostResults)
      .where(eq(schema.notePostResults.id, "note-result-1"))
      .get();
    expect(syncedNote?.campaignId).toBe("campaign-1");
    expect(syncedNote?.angleId).toBe("angle-1");
    expect(syncedNote?.ctaId).toBe("cta-1");
    expect(syncedNote?.priceVariantId).toBe("price-1");
    expect(syncedNote?.canaryGroup).toBe("canary-1");

    const noteMetric = db.select().from(schema.noteMetrics).all()[0];
    expect(noteMetric.campaignId).toBe("campaign-1");
    expect(noteMetric.noteViews).toBe(100);
    expect(noteMetric.purchases).toBe(2);

    const threadMetric = db.select().from(schema.threadsMetrics).all()[0];
    expect(threadMetric.campaignId).toBe("campaign-thread");
    expect(threadMetric.impressions).toBe(1200);
    expect(threadMetric.likes).toBe(80);

    const revenueEvent = db.select().from(schema.revenueEvents).all()[0];
    expect(revenueEvent.amountYen).toBe(1960);
    expect(revenueEvent.draftId).toBe("draft-note-1");

    const funnel = db.select().from(schema.funnelSnapshots).all()[0];
    expect(funnel.impressions).toBe(1200);
    expect(funnel.noteViews).toBe(100);
    expect(funnel.revenue).toBe(1960);

    const session = db.select().from(schema.sessionHealth).all()[0];
    expect(session.state).toBe("healthy");

    const syncState = db
      .select()
      .from(schema.strategyStates)
      .where(eq(schema.strategyStates.key, "metrics:sync-status"))
      .get();
    expect(syncState).toBeTruthy();
    expect(
      JSON.parse(syncState?.stateJson ?? "{}").allowAggressiveExperiments,
    ).toBe(false);
  });

  it("quarantines note session, records anomaly, and still syncs Threads metrics", async () => {
    const now = new Date().toISOString();

    db.insert(schema.threadPostDrafts)
      .values({
        id: "thread-draft-2",
        topicId: "topic-1",
        body: "thread body",
        hookType: "hook",
        ctaType: "cta",
        noteTransition: null,
        campaignId: "campaign-thread-2",
        angleId: "angle-thread-2",
        ctaId: "cta-thread-2",
        canaryGroup: "canary-thread-2",
        status: "audited",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(schema.threadPostResults)
      .values({
        id: "thread-result-2",
        draftId: "thread-draft-2",
        threadsPostId: "threads-post-2",
        campaignId: null,
        angleId: null,
        ctaId: null,
        canaryGroup: null,
        impressions: 0,
        likes: 0,
        repliesCount: 0,
        shares: 0,
        publishedAt: now,
        createdAt: now,
      })
      .run();
    db.insert(schema.publicationEvents)
      .values({
        id: "pub-thread-2",
        targetPlatform: "threads",
        outboxId: null,
        draftId: "thread-draft-2",
        slotId: null,
        campaignId: "campaign-thread-2",
        angleId: "angle-thread-2",
        ctaId: "cta-thread-2",
        priceVariantId: null,
        canaryGroup: "canary-thread-2",
        externalId: "threads-post-2",
        externalUrl: "https://threads.net/p/2",
        externalFingerprint: "threads:2",
        publishedAt: now,
        createdAt: now,
      })
      .run();

    const noteApi = {
      getMyArticles: vi.fn(),
      getArticleStats: vi.fn(),
    };
    const threadsApi = {
      getInsights: vi.fn().mockResolvedValue({
        impressions: 500,
        likes: 20,
        replies: 3,
        shares: 1,
        views: 0,
      }),
    } as unknown as Parameters<
      MetricsSyncServiceImpl["syncAll"]
    >[0]["threadsApi"];

    const service = new MetricsSyncServiceImpl({
      browserSessionVerifier: vi.fn().mockResolvedValue({
        ok: false,
        detail: "NOTE_SESSION_EXPIRED",
      }),
    });

    const result = await service.syncAll({
      noteApi,
      threadsApi,
    });

    expect(result.noteSessionState).toBe("quarantined");
    expect(noteApi.getMyArticles).not.toHaveBeenCalled();
    expect(result.threadPostsSynced).toBe(1);
    expect(db.select().from(schema.threadsMetrics).all()).toHaveLength(1);

    const session = db.select().from(schema.sessionHealth).all()[0];
    expect(session.state).toBe("quarantined");

    const anomalies = db.select().from(schema.anomalyEvents).all();
    expect(anomalies.some((row) => row.category === "note_session")).toBe(true);

    const noteRunner = db
      .select()
      .from(schema.runnerHealth)
      .where(eq(schema.runnerHealth.runner, "note-metrics-sync"))
      .get();
    expect(noteRunner?.status).toBe("degraded");
  });
});
