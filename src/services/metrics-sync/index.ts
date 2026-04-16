import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type {
  NoteApiClient,
  NoteArticleSummary,
} from "../../adapters/note-api/index.js";
import { PlaywrightNoteClient } from "../../adapters/note-api/playwright-client.js";
import type { ThreadsApiClient } from "../../adapters/threads-api/index.js";
import { loadEnv } from "../../config/env.js";
import { db } from "../../db/index.js";
import { createRuntimeLedgerRepository } from "../../db/repositories/runtime-ledger.js";
import {
  noteDrafts,
  noteMetrics,
  notePostResults,
  publicationEvents,
  revenueEvents,
  runnerHealth,
  type SESSION_HEALTH_STATES,
  sessionHealth,
  strategyStates,
  threadPostDrafts,
  threadPostResults,
  threadsMetrics,
} from "../../db/schema.js";

type SessionHealthState = (typeof SESSION_HEALTH_STATES)[number];

type SessionCheckResult = {
  ok: boolean;
  detail: string;
  provider: string;
};

type NoteAttribution = {
  publicationEventId: string | null;
  draftId: string;
  campaignId: string | null;
  angleId: string | null;
  ctaId: string | null;
  priceVariantId: string | null;
  canaryGroup: string | null;
};

type ThreadAttribution = {
  publicationEventId: string | null;
  draftId: string;
  campaignId: string | null;
  angleId: string | null;
  ctaId: string | null;
  canaryGroup: string | null;
};

export interface MetricsSyncResult {
  noteSessionState: SessionHealthState;
  noteSessionDetail: string;
  noteArticlesSynced: number;
  threadPostsSynced: number;
  noteMetricsSnapshots: number;
  threadsMetricsSnapshots: number;
  revenueEventsRecorded: number;
  anomaliesRecorded: number;
  allowAggressiveExperiments: boolean;
}

export interface MetricsSyncService {
  syncAll(input: {
    noteApi: NoteApiClient;
    threadsApi: ThreadsApiClient;
    dryRun?: boolean;
  }): Promise<MetricsSyncResult>;
  summarize(result: MetricsSyncResult): string;
}

export interface MetricsSyncServiceOptions {
  browserSessionVerifier?: () => Promise<{ ok: boolean; detail: string }>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function formatJstDayKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function toNumber(value: number | null | undefined): number {
  return Number.isFinite(value) ? Number(value) : 0;
}

function inferNoteMetrics(params: {
  article: NoteArticleSummary;
  stats: Awaited<ReturnType<NoteApiClient["getArticleStats"]>>;
  existing: typeof notePostResults.$inferSelect | undefined;
}) {
  const views = toNumber(params.stats.views ?? params.article.views);
  const likes = toNumber(params.stats.likes ?? params.article.likes);
  const comments = toNumber(params.stats.comments ?? params.article.comments);
  const priceYen = toNumber(
    params.stats.priceYen ??
      params.article.priceYen ??
      params.existing?.priceYen ??
      0,
  );
  const purchases = toNumber(
    params.stats.purchasesCount ??
      params.article.purchasesCount ??
      params.existing?.purchasesCount ??
      0,
  );
  const revenue = toNumber(
    params.stats.revenueYen ??
      params.article.revenueYen ??
      (priceYen > 0 && purchases > 0 ? priceYen * purchases : 0),
  );
  const conversionRate =
    params.stats.conversionRate ??
    params.article.conversionRate ??
    (views > 0 && purchases > 0 ? purchases / views : 0);

  return {
    views,
    likes,
    comments,
    priceYen,
    purchases,
    revenue,
    conversionRate,
    trafficSource:
      params.stats.trafficSource ??
      params.article.trafficSource ??
      params.existing?.trafficSource ??
      null,
    publishedAt:
      params.stats.publishedAt ??
      params.article.publishedAt ??
      params.existing?.publishedAt ??
      nowIso(),
  };
}

export class MetricsSyncServiceImpl implements MetricsSyncService {
  private readonly browserSessionVerifier?: MetricsSyncServiceOptions["browserSessionVerifier"];

  constructor(options: MetricsSyncServiceOptions = {}) {
    this.browserSessionVerifier = options.browserSessionVerifier;
  }

  async syncAll(input: {
    noteApi: NoteApiClient;
    threadsApi: ThreadsApiClient;
    dryRun?: boolean;
  }): Promise<MetricsSyncResult> {
    const ledger = createRuntimeLedgerRepository();
    let anomaliesRecorded = 0;

    const sessionCheck = await this.checkNoteSession();
    const noteSessionState = this.writeSessionHealth(sessionCheck);

    let noteArticlesSynced = 0;
    let threadPostsSynced = 0;
    let noteMetricsSnapshots = 0;
    let threadsMetricsSnapshots = 0;
    let revenueEventsRecorded = 0;

    if (sessionCheck.ok) {
      const noteSync = await this.syncNoteMetrics(input.noteApi);
      noteArticlesSynced = noteSync.articlesSynced;
      noteMetricsSnapshots = noteSync.metricsSnapshots;
      revenueEventsRecorded = noteSync.revenueEventsRecorded;
      this.recordRunnerHealthSuccess("note-metrics-sync");
    } else {
      ledger.recordAnomaly({
        category: "note_session",
        severity: "high",
        message: sessionCheck.detail,
        metadata: {
          provider: sessionCheck.provider,
          state: noteSessionState,
        },
      });
      anomaliesRecorded += 1;
      this.recordRunnerHealthFailure("note-metrics-sync", sessionCheck.detail);
    }

    try {
      const threadsSync = await this.syncThreadsMetrics(input.threadsApi);
      threadPostsSynced = threadsSync.postsSynced;
      threadsMetricsSnapshots = threadsSync.metricsSnapshots;
      this.recordRunnerHealthSuccess("threads-metrics-sync");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ledger.recordAnomaly({
        category: "threads_metrics",
        severity: "high",
        message,
      });
      anomaliesRecorded += 1;
      this.recordRunnerHealthFailure("threads-metrics-sync", message);
      throw error;
    }

    const funnelSummary = this.syncFunnelSnapshot();
    const allowAggressiveExperiments = false;
    this.writeMetricsSyncState({
      noteSessionState,
      noteSessionDetail: sessionCheck.detail,
      noteArticlesSynced,
      threadPostsSynced,
      noteMetricsSnapshots,
      threadsMetricsSnapshots,
      revenueEventsRecorded,
      anomaliesRecorded,
      allowAggressiveExperiments,
      funnelSummary,
    });

    return {
      noteSessionState,
      noteSessionDetail: sessionCheck.detail,
      noteArticlesSynced,
      threadPostsSynced,
      noteMetricsSnapshots,
      threadsMetricsSnapshots,
      revenueEventsRecorded,
      anomaliesRecorded,
      allowAggressiveExperiments,
    };
  }

  summarize(result: MetricsSyncResult): string {
    return [
      `noteSession=${result.noteSessionState}`,
      `noteArticles=${result.noteArticlesSynced}`,
      `threadsPosts=${result.threadPostsSynced}`,
      `noteSnapshots=${result.noteMetricsSnapshots}`,
      `threadsSnapshots=${result.threadsMetricsSnapshots}`,
      `revenueEvents=${result.revenueEventsRecorded}`,
      `anomalies=${result.anomaliesRecorded}`,
      `aggressiveExperiments=${result.allowAggressiveExperiments}`,
    ].join(" ");
  }

  private async checkNoteSession(): Promise<SessionCheckResult> {
    const env = loadEnv();
    if (env.NOTE_MODE !== "browser_assisted") {
      return {
        ok: true,
        detail: `NOTE_MODE=${env.NOTE_MODE}`,
        provider: env.NOTE_MODE,
      };
    }

    try {
      const verifier =
        this.browserSessionVerifier ??
        (async () => {
          const client = new PlaywrightNoteClient(
            env.NOTE_STORAGE_STATE_PATH,
            env.NOTE_PLAYWRIGHT_HEADLESS,
          );
          return client.verifySession();
        });
      const result = await verifier();
      return {
        ok: result.ok,
        detail: result.detail,
        provider: "browser_assisted",
      };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
        provider: "browser_assisted",
      };
    }
  }

  private writeSessionHealth(session: SessionCheckResult): SessionHealthState {
    const now = nowIso();
    const scope = "note";
    const existing = db
      .select()
      .from(sessionHealth)
      .where(eq(sessionHealth.scope, scope))
      .get();

    const state: SessionHealthState = session.ok
      ? existing && existing.state !== "healthy"
        ? "recovered"
        : "healthy"
      : "quarantined";

    db.insert(sessionHealth)
      .values({
        scope,
        state,
        provider: session.provider,
        consecutiveFailures: session.ok
          ? 0
          : (existing?.consecutiveFailures ?? 0) + 1,
        lastSuccessAt: session.ok ? now : (existing?.lastSuccessAt ?? null),
        lastFailureAt: session.ok ? (existing?.lastFailureAt ?? null) : now,
        detail: session.detail,
        metadataJson: JSON.stringify({ provider: session.provider }),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: sessionHealth.scope,
        set: {
          state,
          provider: session.provider,
          consecutiveFailures: session.ok
            ? 0
            : (existing?.consecutiveFailures ?? 0) + 1,
          lastSuccessAt: session.ok ? now : (existing?.lastSuccessAt ?? null),
          lastFailureAt: session.ok ? (existing?.lastFailureAt ?? null) : now,
          detail: session.detail,
          metadataJson: JSON.stringify({ provider: session.provider }),
          updatedAt: now,
        },
      })
      .run();

    return state;
  }

  private async syncNoteMetrics(noteApi: NoteApiClient): Promise<{
    articlesSynced: number;
    metricsSnapshots: number;
    revenueEventsRecorded: number;
  }> {
    const articles = await noteApi.getMyArticles();
    const allResults = db.select().from(notePostResults).all();
    const allDrafts = db.select().from(noteDrafts).all();
    const allPublicationEvents = db.select().from(publicationEvents).all();
    const now = nowIso();
    let metricsSnapshots = 0;
    let revenueEventsRecorded = 0;

    for (const article of articles) {
      const publication = allPublicationEvents.find(
        (row) =>
          row.targetPlatform === "note" &&
          (row.externalId === article.id || row.externalUrl === article.url),
      );
      const existing = allResults.find(
        (row) =>
          row.noteUrl === article.url ||
          (publication?.draftId ? row.draftId === publication.draftId : false),
      );
      const draftId = existing?.draftId ?? publication?.draftId ?? null;

      if (!draftId) {
        continue;
      }

      const draft = allDrafts.find((row) => row.id === draftId);
      const attribution: NoteAttribution = {
        publicationEventId: publication?.id ?? null,
        draftId,
        campaignId:
          existing?.campaignId ??
          publication?.campaignId ??
          draft?.campaignId ??
          null,
        angleId:
          existing?.angleId ?? publication?.angleId ?? draft?.angleId ?? null,
        ctaId: existing?.ctaId ?? publication?.ctaId ?? draft?.ctaId ?? null,
        priceVariantId:
          existing?.priceVariantId ??
          publication?.priceVariantId ??
          draft?.priceVariantId ??
          null,
        canaryGroup:
          existing?.canaryGroup ??
          publication?.canaryGroup ??
          draft?.canaryGroup ??
          null,
      };

      const stats = await noteApi.getArticleStats(article.id);
      const normalized = inferNoteMetrics({ article, stats, existing });
      const previousRevenue = existing?.revenueYen ?? 0;
      const previousPurchases = existing?.purchasesCount ?? 0;

      db.insert(notePostResults)
        .values({
          id: existing?.id ?? randomUUID(),
          draftId: attribution.draftId,
          title: article.title,
          noteUrl: article.url,
          priceYen: normalized.priceYen,
          campaignId: attribution.campaignId,
          angleId: attribution.angleId,
          ctaId: attribution.ctaId,
          priceVariantId: attribution.priceVariantId,
          canaryGroup: attribution.canaryGroup,
          views: normalized.views,
          likes: normalized.likes,
          commentsCount: normalized.comments,
          purchasesCount: normalized.purchases,
          revenueYen: normalized.revenue,
          conversionRate: normalized.conversionRate,
          trafficSource: normalized.trafficSource,
          publishedAt: normalized.publishedAt,
          createdAt: existing?.createdAt ?? now,
        })
        .onConflictDoUpdate({
          target: notePostResults.id,
          set: {
            title: article.title,
            noteUrl: article.url,
            priceYen: normalized.priceYen,
            campaignId: attribution.campaignId,
            angleId: attribution.angleId,
            ctaId: attribution.ctaId,
            priceVariantId: attribution.priceVariantId,
            canaryGroup: attribution.canaryGroup,
            views: normalized.views,
            likes: normalized.likes,
            commentsCount: normalized.comments,
            purchasesCount: normalized.purchases,
            revenueYen: normalized.revenue,
            conversionRate: normalized.conversionRate,
            trafficSource: normalized.trafficSource,
            publishedAt: normalized.publishedAt,
          },
        })
        .run();

      db.insert(noteMetrics)
        .values({
          id: randomUUID(),
          publicationEventId: attribution.publicationEventId,
          draftId: attribution.draftId,
          campaignId: attribution.campaignId,
          angleId: attribution.angleId,
          ctaId: attribution.ctaId,
          priceVariantId: attribution.priceVariantId,
          canaryGroup: attribution.canaryGroup,
          noteClicks: 0,
          noteViews: normalized.views,
          purchases: normalized.purchases,
          revenue: normalized.revenue,
          conversionRate: normalized.conversionRate,
          capturedAt: now,
          createdAt: now,
        })
        .run();
      metricsSnapshots += 1;

      const revenueDelta = Math.max(0, normalized.revenue - previousRevenue);
      const purchasesDelta = Math.max(
        0,
        normalized.purchases - previousPurchases,
      );
      if (revenueDelta > 0) {
        db.insert(revenueEvents)
          .values({
            id: randomUUID(),
            publicationEventId: attribution.publicationEventId,
            draftId: attribution.draftId,
            campaignId: attribution.campaignId,
            priceVariantId: attribution.priceVariantId,
            amountYen: revenueDelta,
            purchasesCount: Math.max(1, purchasesDelta),
            occurredAt: now,
            createdAt: now,
          })
          .run();
        revenueEventsRecorded += 1;
      }
    }

    return {
      articlesSynced: articles.length,
      metricsSnapshots,
      revenueEventsRecorded,
    };
  }

  private async syncThreadsMetrics(threadsApi: ThreadsApiClient): Promise<{
    postsSynced: number;
    metricsSnapshots: number;
  }> {
    // Pre-flight: verify Threads token health
    if ("verifyTokenHealth" in threadsApi && typeof (threadsApi as Record<string, unknown>).verifyTokenHealth === "function") {
      const health = await (threadsApi as { verifyTokenHealth: () => Promise<{ ok: boolean; detail: string }> }).verifyTokenHealth();
      if (!health.ok) {
        const ledger = createRuntimeLedgerRepository();
        ledger.recordAnomaly({
          category: "threads_token_unhealthy",
          severity: "high",
          message: `Threads APIトークンが無効: ${health.detail}`,
          metadata: { detail: health.detail },
        });
        ledger.updateSessionHealth({
          scope: "threads",
          provider: "graph_api",
          state: "degraded",
          detail: `Token verification failed: ${health.detail}`,
        });
        return { postsSynced: 0, metricsSnapshots: 0 };
      }
    }

    const results = db.select().from(threadPostResults).all();
    const drafts = db.select().from(threadPostDrafts).all();
    const allPublicationEvents = db.select().from(publicationEvents).all();
    const now = nowIso();
    let metricsSnapshots = 0;

    for (const row of results) {
      const insights = await threadsApi.getInsights(row.threadsPostId);
      const publication = allPublicationEvents.find(
        (event) =>
          event.targetPlatform === "threads" &&
          (event.externalId === row.threadsPostId ||
            event.draftId === row.draftId),
      );
      const draft = drafts.find((candidate) => candidate.id === row.draftId);
      const attribution: ThreadAttribution = {
        publicationEventId: publication?.id ?? null,
        draftId: row.draftId,
        campaignId:
          row.campaignId ??
          publication?.campaignId ??
          draft?.campaignId ??
          null,
        angleId: row.angleId ?? publication?.angleId ?? draft?.angleId ?? null,
        ctaId: row.ctaId ?? publication?.ctaId ?? draft?.ctaId ?? null,
        canaryGroup:
          row.canaryGroup ??
          publication?.canaryGroup ??
          draft?.canaryGroup ??
          null,
      };

      db.update(threadPostResults)
        .set({
          campaignId: attribution.campaignId,
          angleId: attribution.angleId,
          ctaId: attribution.ctaId,
          canaryGroup: attribution.canaryGroup,
          impressions: toNumber(insights.impressions),
          likes: toNumber(insights.likes),
          repliesCount: toNumber(insights.replies),
          shares: toNumber(insights.shares),
        })
        .where(eq(threadPostResults.id, row.id))
        .run();

      db.insert(threadsMetrics)
        .values({
          id: randomUUID(),
          publicationEventId: attribution.publicationEventId,
          draftId: attribution.draftId,
          campaignId: attribution.campaignId,
          angleId: attribution.angleId,
          ctaId: attribution.ctaId,
          canaryGroup: attribution.canaryGroup,
          impressions: toNumber(insights.impressions),
          likes: toNumber(insights.likes),
          replies: toNumber(insights.replies),
          shares: toNumber(insights.shares),
          profileTransitions: 0,
          capturedAt: now,
          createdAt: now,
        })
        .run();
      metricsSnapshots += 1;
    }

    return {
      postsSynced: results.length,
      metricsSnapshots,
    };
  }

  private syncFunnelSnapshot(): {
    impressions: number;
    noteViews: number;
    purchases: number;
    revenue: number;
  } {
    const ledger = createRuntimeLedgerRepository();
    const latestThreadsMetrics = db.select().from(threadsMetrics).all();
    const latestNoteMetrics = db.select().from(noteMetrics).all();

    const impressions = latestThreadsMetrics.reduce(
      (sum, row) => sum + row.impressions,
      0,
    );
    const noteViews = latestNoteMetrics.reduce(
      (sum, row) => sum + row.noteViews,
      0,
    );
    const purchases = latestNoteMetrics.reduce(
      (sum, row) => sum + row.purchases,
      0,
    );
    const revenue = latestNoteMetrics.reduce(
      (sum, row) => sum + row.revenue,
      0,
    );

    ledger.upsertFunnelSnapshot({
      periodType: "daily",
      periodKey: formatJstDayKey(new Date()),
      impressions,
      profileTransitions: 0,
      noteClicks: 0,
      noteViews,
      purchases,
      revenue,
      capturedAt: nowIso(),
    });

    return {
      impressions,
      noteViews,
      purchases,
      revenue,
    };
  }

  private writeMetricsSyncState(input: {
    noteSessionState: SessionHealthState;
    noteSessionDetail: string;
    noteArticlesSynced: number;
    threadPostsSynced: number;
    noteMetricsSnapshots: number;
    threadsMetricsSnapshots: number;
    revenueEventsRecorded: number;
    anomaliesRecorded: number;
    allowAggressiveExperiments: boolean;
    funnelSummary: {
      impressions: number;
      noteViews: number;
      purchases: number;
      revenue: number;
    };
  }): void {
    const now = nowIso();
    const key = "metrics:sync-status";
    const reasons = [
      "profileTransitions unavailable",
      "noteClicks unavailable",
    ];
    const state = {
      lastSyncedAt: now,
      noteSessionState: input.noteSessionState,
      noteSessionDetail: input.noteSessionDetail,
      counts: {
        noteArticlesSynced: input.noteArticlesSynced,
        threadPostsSynced: input.threadPostsSynced,
        noteMetricsSnapshots: input.noteMetricsSnapshots,
        threadsMetricsSnapshots: input.threadsMetricsSnapshots,
        revenueEventsRecorded: input.revenueEventsRecorded,
        anomaliesRecorded: input.anomaliesRecorded,
      },
      funnel: input.funnelSummary,
      allowAggressiveExperiments: input.allowAggressiveExperiments,
      reasons,
    };

    db.insert(strategyStates)
      .values({
        key,
        scope: "metrics",
        stateJson: JSON.stringify(state),
        summary: `noteSession=${input.noteSessionState}; aggressiveExperiments=false`,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: strategyStates.key,
        set: {
          scope: "metrics",
          stateJson: JSON.stringify(state),
          summary: `noteSession=${input.noteSessionState}; aggressiveExperiments=false`,
          updatedAt: now,
        },
      })
      .run();
  }

  private recordRunnerHealthSuccess(runner: string): void {
    const now = nowIso();
    const existing = db
      .select()
      .from(runnerHealth)
      .where(eq(runnerHealth.runner, runner))
      .get();

    db.insert(runnerHealth)
      .values({
        runner,
        status: "healthy",
        consecutiveFailures: 0,
        timeoutCount: existing?.timeoutCount ?? 0,
        invalidJsonCount: existing?.invalidJsonCount ?? 0,
        totalCalls: (existing?.totalCalls ?? 0) + 1,
        lastModel: existing?.lastModel ?? null,
        lastError: null,
        lastDurationMs: existing?.lastDurationMs ?? null,
        lastSuccessAt: now,
        lastFailureAt: existing?.lastFailureAt ?? null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: runnerHealth.runner,
        set: {
          status: "healthy",
          consecutiveFailures: 0,
          totalCalls: (existing?.totalCalls ?? 0) + 1,
          lastError: null,
          lastSuccessAt: now,
          updatedAt: now,
        },
      })
      .run();
  }

  private recordRunnerHealthFailure(runner: string, message: string): void {
    const now = nowIso();
    const existing = db
      .select()
      .from(runnerHealth)
      .where(eq(runnerHealth.runner, runner))
      .get();
    const consecutiveFailures = (existing?.consecutiveFailures ?? 0) + 1;

    db.insert(runnerHealth)
      .values({
        runner,
        status: "degraded",
        consecutiveFailures,
        timeoutCount: existing?.timeoutCount ?? 0,
        invalidJsonCount: existing?.invalidJsonCount ?? 0,
        totalCalls: (existing?.totalCalls ?? 0) + 1,
        lastModel: existing?.lastModel ?? null,
        lastError: message,
        lastDurationMs: existing?.lastDurationMs ?? null,
        lastSuccessAt: existing?.lastSuccessAt ?? null,
        lastFailureAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: runnerHealth.runner,
        set: {
          status: "degraded",
          consecutiveFailures,
          totalCalls: (existing?.totalCalls ?? 0) + 1,
          lastError: message,
          lastFailureAt: now,
          updatedAt: now,
        },
      })
      .run();
  }
}
