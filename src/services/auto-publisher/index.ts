import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, lte } from "drizzle-orm";
import type { NoteApiClient } from "../../adapters/note-api/index.js";
import type { ThreadsApiClient } from "../../adapters/threads-api/index.js";
import { logger } from "../../app/logger.js";
import { db } from "../../db/index.js";
import { createRuntimeLedgerRepository } from "../../db/repositories/runtime-ledger.js";
import {
  contentSlots,
  executionOutbox,
  noteDrafts,
  noteIdeas,
  notePostResults,
  outboundNotifications,
  replyDecisions,
  threadPostDrafts,
  threadPostResults,
  threadReplies,
} from "../../db/schema.js";

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export interface PublishResult {
  id: string;
  url: string;
  type: "threads" | "note";
  draftId?: string;
}

export interface ChannelWritabilityGuard {
  isChannelWritable(channel: "threads" | "note"): boolean;
}

export interface AutoPublisherOptions {
  maxPostsPerHour?: number;
  maxRepliesPerHour?: number;
  dryRun?: boolean;
  operationsMode?: ChannelWritabilityGuard;
}

export interface AutoPublisherService {
  publishApprovedThreadDrafts(api: ThreadsApiClient): Promise<PublishResult[]>;
  publishApprovedNoteDrafts(noteApi: NoteApiClient): Promise<PublishResult[]>;
  sendSafeReplies(api: ThreadsApiClient): Promise<number>;
}

// ---------------------------------------------------------------------------
// Pricing logic for note articles
// ---------------------------------------------------------------------------

interface NotePricingResult {
  isPaid: boolean;
  priceYen: number;
  freePreviewMarkdown: string | undefined;
  reason: string;
  historySampleCount: number;
  targetConversionRate: number | null;
  historicalPurchases: number;
  historicalRevenueYen: number;
}

type NotePricingHistory = {
  sampleCount: number;
  averageConversionRate: number;
  averagePurchases: number;
  averageRevenueYen: number;
  averageViews: number;
};

type PendingSyncMetadata = {
  noteId: string;
  noteUrl: string;
  reason: string;
};

const NOTE_TRAFFIC_SOURCE = "threads";

import { logger as pricingLogger } from "../../app/logger.js";
import { getCompiledContractStore } from "../contracts/index.js";

interface PricingPolicyThresholds {
  priceTiers: number[];
  freeThresholdChars: number;
  paidTierChars: number[];
  targetConversionRate: number;
  priceUpConversionRate: number;
  priceUpPurchases: number;
  priceUpRevenueYen: number;
  priceDownMinViews: number;
  priceDownMaxPurchases: number;
  priceDownMaxConversionRate: number;
  priceDownFreeChars: number;
}

const FALLBACK_PRICING: PricingPolicyThresholds = {
  priceTiers: [490, 690, 980, 1480, 1980],
  freeThresholdChars: 3000,
  paidTierChars: [5000, 8000],
  targetConversionRate: 0.025,
  priceUpConversionRate: 0.04,
  priceUpPurchases: 3,
  priceUpRevenueYen: 3000,
  priceDownMinViews: 150,
  priceDownMaxPurchases: 1,
  priceDownMaxConversionRate: 0.01,
  priceDownFreeChars: 4500,
};

function loadPricingPolicy(): PricingPolicyThresholds {
  try {
    const store = getCompiledContractStore();
    const policy = store.policies.find((p) => p.id === "pricing");
    const t = policy?.thresholds ?? {};
    return {
      priceTiers: Array.isArray(t.priceTiers)
        ? (t.priceTiers as number[])
        : FALLBACK_PRICING.priceTiers,
      freeThresholdChars:
        Number(t.freeThresholdChars) || FALLBACK_PRICING.freeThresholdChars,
      paidTierChars: Array.isArray(t.paidTierChars)
        ? (t.paidTierChars as number[])
        : FALLBACK_PRICING.paidTierChars,
      targetConversionRate:
        Number(t.targetConversionRate) || FALLBACK_PRICING.targetConversionRate,
      priceUpConversionRate:
        Number(t.priceUpConversionRate) ||
        FALLBACK_PRICING.priceUpConversionRate,
      priceUpPurchases:
        Number(t.priceUpPurchases) || FALLBACK_PRICING.priceUpPurchases,
      priceUpRevenueYen:
        Number(t.priceUpRevenueYen) || FALLBACK_PRICING.priceUpRevenueYen,
      priceDownMinViews:
        Number(t.priceDownMinViews) || FALLBACK_PRICING.priceDownMinViews,
      priceDownMaxPurchases:
        Number(t.priceDownMaxPurchases) ||
        FALLBACK_PRICING.priceDownMaxPurchases,
      priceDownMaxConversionRate:
        Number(t.priceDownMaxConversionRate) ||
        FALLBACK_PRICING.priceDownMaxConversionRate,
      priceDownFreeChars:
        Number(t.priceDownFreeChars) || FALLBACK_PRICING.priceDownFreeChars,
    };
  } catch (error) {
    pricingLogger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "[auto-publisher] Failed to load pricing policy; using fallback",
    );
    return FALLBACK_PRICING;
  }
}

function buildTrafficSource(
  base: string,
  metadata?: Record<string, string>,
): string {
  if (!metadata || Object.keys(metadata).length === 0) {
    return base;
  }

  return [
    base,
    ...Object.entries(metadata).map(([key, value]) => `${key}=${value}`),
  ].join("|");
}

function parseTrafficSource(raw: string | null | undefined): {
  source: string;
  metadata: Record<string, string>;
} {
  if (!raw) {
    return { source: NOTE_TRAFFIC_SOURCE, metadata: {} };
  }

  const [source, ...parts] = raw.split("|");
  const metadata: Record<string, string> = {};

  for (const part of parts) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    metadata[part.slice(0, separatorIndex)] = part.slice(separatorIndex + 1);
  }

  return { source, metadata };
}

function normalizePriceToTier(priceYen: number, tiers: number[]): number {
  if (tiers.length === 0) return priceYen;
  return tiers.reduce((closest, tier) => {
    const currentDistance = Math.abs(priceYen - tier);
    const closestDistance = Math.abs(priceYen - closest);
    return currentDistance < closestDistance ? tier : closest;
  }, tiers[0]);
}

function determineNotePrice(
  bodyText: string,
  history: NotePricingHistory,
): NotePricingResult {
  const pp = loadPricingPolicy();
  const charCount = bodyText.length;

  if (charCount < pp.freeThresholdChars) {
    return {
      isPaid: false,
      priceYen: 0,
      freePreviewMarkdown: undefined,
      reason: "本文が短いため無料公開",
      historySampleCount: history.sampleCount,
      targetConversionRate:
        history.sampleCount > 0 ? history.averageConversionRate : null,
      historicalPurchases: Math.round(
        history.averagePurchases * history.sampleCount,
      ),
      historicalRevenueYen: Math.round(
        history.averageRevenueYen * history.sampleCount,
      ),
    };
  }

  let priceYen: number;
  let reason = "本文長ベースの初期価格";
  const [midChar, highChar] =
    pp.paidTierChars.length >= 2 ? pp.paidTierChars : [5000, 8000];
  if (charCount < midChar) {
    priceYen = pp.priceTiers[1] ?? 690;
  } else if (charCount < highChar) {
    priceYen = pp.priceTiers[2] ?? 980;
  } else {
    priceYen = pp.priceTiers[3] ?? 1480;
  }

  // Free preview: first 30% of the body, capped at 2000 characters
  const previewLength = Math.min(Math.floor(charCount * 0.3), 2000);
  const freePreviewMarkdown = bodyText.slice(0, previewLength);

  if (history.sampleCount > 0) {
    if (
      history.averageConversionRate >= pp.priceUpConversionRate ||
      history.averagePurchases >= pp.priceUpPurchases ||
      history.averageRevenueYen >= pp.priceUpRevenueYen
    ) {
      priceYen = normalizePriceToTier(priceYen + 300, pp.priceTiers);
      reason = "既存記事のCV/売上が強いため価格を引き上げ";
    } else if (
      history.averageViews >= pp.priceDownMinViews &&
      history.averagePurchases < pp.priceDownMaxPurchases &&
      history.averageConversionRate <= pp.priceDownMaxConversionRate
    ) {
      if (charCount < pp.priceDownFreeChars) {
        return {
          isPaid: false,
          priceYen: 0,
          freePreviewMarkdown: undefined,
          reason: "既存記事のCVが弱く短文のため無料化",
          historySampleCount: history.sampleCount,
          targetConversionRate: history.averageConversionRate,
          historicalPurchases: Math.round(
            history.averagePurchases * history.sampleCount,
          ),
          historicalRevenueYen: Math.round(
            history.averageRevenueYen * history.sampleCount,
          ),
        };
      }

      priceYen = normalizePriceToTier(
        Math.max(pp.priceTiers[0] ?? 490, priceYen - 200),
        pp.priceTiers,
      );
      reason = "既存記事の購入率が弱いため価格を引き下げ";
    } else if (
      history.averageConversionRate >= pp.targetConversionRate &&
      history.averageRevenueYen >= 1500
    ) {
      reason = "既存記事のCVが基準内のため基準価格を維持";
    } else {
      reason = "既存記事の成績が混在しているため基準価格を維持";
    }
  }

  return {
    isPaid: true,
    priceYen,
    freePreviewMarkdown,
    reason,
    historySampleCount: history.sampleCount,
    targetConversionRate:
      history.sampleCount > 0 ? history.averageConversionRate : null,
    historicalPurchases: Math.round(
      history.averagePurchases * history.sampleCount,
    ),
    historicalRevenueYen: Math.round(
      history.averageRevenueYen * history.sampleCount,
    ),
  };
}

function buildNotePromotionBody(title: string, noteUrl: string): string {
  const segments = [
    `noteを公開しました。`,
    `テーマ: ${title}`,
    "実務でそのまま使える形まで整理しています。",
    `続きはこちら ${noteUrl}`,
  ];

  let body = segments.join("\n\n");
  if (body.length <= 500) {
    return body;
  }

  body = [segments[0], segments[1], `続きはこちら ${noteUrl}`].join("\n\n");
  return body.slice(0, 500);
}

export class AutoPublisherServiceImpl implements AutoPublisherService {
  private readonly maxPostsPerHour: number;
  private readonly maxRepliesPerHour: number;
  private readonly dryRun: boolean;
  private readonly operationsMode?: ChannelWritabilityGuard;
  private readonly ledger = createRuntimeLedgerRepository();

  constructor(options: AutoPublisherOptions = {}) {
    this.maxPostsPerHour =
      options.maxPostsPerHour ?? readEnvInt("MAX_POSTS_PER_HOUR", 3);
    this.maxRepliesPerHour =
      options.maxRepliesPerHour ?? readEnvInt("MAX_REPLIES_PER_HOUR", 10);
    this.dryRun = options.dryRun ?? false;
    this.operationsMode = options.operationsMode;
  }

  private isChannelWritable(channel: "threads" | "note"): boolean {
    if (!this.operationsMode) return true;
    const writable = this.operationsMode.isChannelWritable(channel);
    if (!writable) {
      logger.warn(
        { channel },
        "[auto-publisher] channel blocked by operations-mode guard",
      );
    }
    return writable;
  }

  private enqueuePublishOutbox(input: {
    targetPlatform: "threads" | "note";
    slotId: string;
    draftId: string;
    payload: Record<string, unknown>;
  }) {
    const idempotencyKey = `publish:${input.targetPlatform}:${input.slotId}:${input.draftId}`;
    const outbox = this.ledger.enqueueOutbox({
      idempotencyKey,
      targetPlatform: input.targetPlatform,
      operationType: "publish",
      payload: input.payload,
    });
    this.ledger.recordDecisionEvidence({
      entityType: "execution_outbox",
      entityId: outbox.id,
      decisionType: "enqueue_publish",
      evidence: {
        slotId: input.slotId,
        draftId: input.draftId,
        targetPlatform: input.targetPlatform,
        idempotencyKey,
      },
    });
    return outbox;
  }

  private getEligibleThreadSlots(now: string) {
    const dueSlots = db
      .select()
      .from(contentSlots)
      .where(
        and(
          eq(contentSlots.channel, "threads"),
          eq(contentSlots.status, "pending"),
          lte(contentSlots.scheduledAt, now),
        ),
      )
      .orderBy(desc(contentSlots.priority), contentSlots.scheduledAt)
      .limit(this.maxPostsPerHour)
      .all();

    return dueSlots
      .map((slot) => {
        const draft = slot.draftId
          ? db
              .select()
              .from(threadPostDrafts)
              .where(eq(threadPostDrafts.id, slot.draftId))
              .get()
          : null;
        return { slot, draft };
      })
      .filter(({ slot, draft }) =>
        Boolean(slot.draftId && draft?.status === "audited"),
      );
  }

  private getEligibleNoteSlots(now: string) {
    const dueSlots = db
      .select()
      .from(contentSlots)
      .where(
        and(
          eq(contentSlots.channel, "note"),
          eq(contentSlots.status, "pending"),
          lte(contentSlots.scheduledAt, now),
        ),
      )
      .orderBy(desc(contentSlots.priority), contentSlots.scheduledAt)
      .limit(1)
      .all();

    return dueSlots
      .map((slot) => {
        const draft = slot.draftId
          ? db
              .select()
              .from(noteDrafts)
              .where(eq(noteDrafts.id, slot.draftId))
              .get()
          : null;
        return { slot, draft };
      })
      .filter(({ slot, draft }) =>
        Boolean(
          slot.draftId &&
            draft?.status === "audited" &&
            (draft.publishReadinessScore ?? 0) >= 5,
        ),
      );
  }

  private collectNotePricingHistory(
    draft: typeof noteDrafts.$inferSelect,
  ): NotePricingHistory {
    const currentIdea = db
      .select()
      .from(noteIdeas)
      .where(eq(noteIdeas.id, draft.ideaId))
      .get();
    const allDrafts = db.select().from(noteDrafts).all();
    const allIdeas = db.select().from(noteIdeas).all();
    const allResults = db.select().from(notePostResults).all();
    const ideaById = new Map(allIdeas.map((idea) => [idea.id, idea] as const));
    const draftById = new Map(allDrafts.map((row) => [row.id, row] as const));

    const relatedResults = allResults.filter((result) => {
      const historicalDraft = draftById.get(result.draftId);
      if (!historicalDraft || historicalDraft.id === draft.id) {
        return false;
      }

      const historicalIdea = ideaById.get(historicalDraft.ideaId);
      if (!historicalIdea) {
        return false;
      }

      if (
        currentIdea?.sourceTopicId &&
        historicalIdea.sourceTopicId === currentIdea.sourceTopicId
      ) {
        return true;
      }

      return historicalIdea.angle === currentIdea?.angle;
    });

    const fallbackResults =
      relatedResults.length > 0
        ? relatedResults
        : allResults.filter((result) => result.priceYen !== null);
    if (fallbackResults.length === 0) {
      return {
        sampleCount: 0,
        averageConversionRate: 0,
        averagePurchases: 0,
        averageRevenueYen: 0,
        averageViews: 0,
      };
    }

    const sampleCount = fallbackResults.length;
    return {
      sampleCount,
      averageConversionRate:
        fallbackResults.reduce((sum, row) => sum + row.conversionRate, 0) /
        sampleCount,
      averagePurchases:
        fallbackResults.reduce((sum, row) => sum + row.purchasesCount, 0) /
        sampleCount,
      averageRevenueYen:
        fallbackResults.reduce((sum, row) => sum + row.revenueYen, 0) /
        sampleCount,
      averageViews:
        fallbackResults.reduce((sum, row) => sum + row.views, 0) / sampleCount,
    };
  }

  private persistPendingNoteSync(
    draft: typeof noteDrafts.$inferSelect,
    publishedAt: string,
    pricing: NotePricingResult,
    metadata: PendingSyncMetadata,
  ): void {
    const existing = db
      .select()
      .from(notePostResults)
      .where(eq(notePostResults.noteUrl, metadata.noteUrl))
      .get();
    const trafficSource = buildTrafficSource(NOTE_TRAFFIC_SOURCE, {
      status: "sync_pending",
      noteId: metadata.noteId,
      reason: metadata.reason,
    });

    if (existing) {
      db.update(notePostResults)
        .set({
          draftId: draft.id,
          title: draft.title,
          priceYen: pricing.isPaid ? pricing.priceYen : 0,
          campaignId: draft.campaignId,
          angleId: draft.angleId,
          ctaId: draft.ctaId,
          priceVariantId: draft.priceVariantId,
          canaryGroup: draft.canaryGroup,
          trafficSource,
          publishedAt,
          createdAt: publishedAt,
        })
        .where(eq(notePostResults.id, existing.id))
        .run();
      return;
    }

    db.insert(notePostResults)
      .values({
        id: randomUUID(),
        draftId: draft.id,
        title: draft.title,
        noteUrl: metadata.noteUrl,
        priceYen: pricing.isPaid ? pricing.priceYen : 0,
        campaignId: draft.campaignId,
        angleId: draft.angleId,
        ctaId: draft.ctaId,
        priceVariantId: draft.priceVariantId,
        canaryGroup: draft.canaryGroup,
        views: 0,
        likes: 0,
        commentsCount: 0,
        purchasesCount: 0,
        revenueYen: 0,
        conversionRate: 0,
        trafficSource,
        publishedAt,
        createdAt: publishedAt,
      })
      .run();
  }

  private createNotePromotionDraft(
    noteDraftId: string,
    noteIdeaId: string,
    title: string,
    noteUrl: string,
    createdAt: string,
  ): void {
    const idea = db
      .select()
      .from(noteIdeas)
      .where(eq(noteIdeas.id, noteIdeaId))
      .get();
    const topicId = idea?.sourceTopicId;

    if (!topicId) {
      logger.warn(
        { noteDraftId, noteIdeaId },
        "Skipping note promotion draft because source topic is missing",
      );
      return;
    }

    db.insert(threadPostDrafts)
      .values({
        id: randomUUID(),
        topicId,
        body: buildNotePromotionBody(title, noteUrl),
        hookType: "benefit",
        ctaType: "link",
        noteTransition: noteUrl,
        status: "audited",
        createdAt,
        updatedAt: createdAt,
      })
      .run();

    logger.info(
      { noteDraftId, topicId, noteUrl },
      "Created note promotion Threads draft",
    );
  }

  async publishApprovedThreadDrafts(
    api: ThreadsApiClient,
  ): Promise<PublishResult[]> {
    if (!this.isChannelWritable("threads")) {
      return [];
    }
    const now = new Date().toISOString();
    const eligibleSlots = this.getEligibleThreadSlots(now);

    if (this.dryRun) {
      return eligibleSlots.map(({ slot }) => ({
        id: slot.draftId ?? slot.id,
        url: `dry-run://threads/${slot.id}`,
        type: "threads",
      }));
    }

    const results: PublishResult[] = [];

    for (const { slot, draft } of eligibleSlots) {
      if (!slot.draftId) {
        logger.warn({ slotId: slot.id }, "Thread slot is missing a draft id");
        await this.skipSlot(slot.id);
        continue;
      }

      if (!draft || draft.status !== "audited") {
        logger.warn(
          { slotId: slot.id, draftId: slot.draftId },
          "Skipping slot without audited draft",
        );
        await this.skipSlot(slot.id);
        continue;
      }

      const reserved = await this.reserveSlot(slot.id, draft.id);
      if (!reserved) {
        logger.warn(
          { slotId: slot.id, draftId: draft.id },
          "Thread slot was already claimed by another worker",
        );
        continue;
      }

      let outboxId: string | null = null;
      const outbox = this.enqueuePublishOutbox({
        targetPlatform: "threads",
        slotId: slot.id,
        draftId: draft.id,
        payload: {
          slotId: slot.id,
          draftId: draft.id,
          body: draft.body,
          campaignId: draft.campaignId,
          angleId: draft.angleId,
          ctaId: draft.ctaId,
          canaryGroup: draft.canaryGroup,
        },
      });
      const claimed = this.ledger.claimOutbox(outbox.id, `threads:${slot.id}`);
      outboxId = outbox.id;
      if (!claimed) {
        logger.warn(
          { slotId: slot.id, draftId: draft.id, outboxId: outbox.id },
          "Thread outbox was already claimed",
        );
        continue;
      }

      try {
        const { id: postId, permalink } = await api.publishPost(draft.body);
        const publishedAt = new Date().toISOString();

        db.update(threadPostDrafts)
          .set({
            status: "published",
            updatedAt: publishedAt,
          })
          .where(eq(threadPostDrafts.id, draft.id))
          .run();

        db.insert(threadPostResults)
          .values({
            id: randomUUID(),
            draftId: draft.id,
            threadsPostId: postId,
            campaignId: draft.campaignId,
            angleId: draft.angleId,
            ctaId: draft.ctaId,
            canaryGroup: draft.canaryGroup,
            impressions: 0,
            likes: 0,
            repliesCount: 0,
            shares: 0,
            publishedAt,
            createdAt: publishedAt,
          })
          .run();

        this.ledger.insertPublicationEvent({
          targetPlatform: "threads",
          outboxId: outbox.id,
          draftId: draft.id,
          slotId: slot.id,
          campaignId: draft.campaignId ?? undefined,
          angleId: draft.angleId ?? undefined,
          ctaId: draft.ctaId ?? undefined,
          canaryGroup: draft.canaryGroup ?? undefined,
          externalId: postId,
          externalUrl: permalink,
          externalFingerprint: `threads:${postId}`,
          publishedAt,
        });
        this.ledger.completeOutbox(outbox.id);
        await this.completeSlot(slot.id);
        results.push({ id: postId, url: permalink, type: "threads" });
        logger.info({ draftId: draft.id, postId }, "Auto-published to Threads");
      } catch (error) {
        if (outboxId) {
          this.ledger.failOutbox(
            outboxId,
            error instanceof Error ? error.message : String(error),
          );
        }
        await this.unreserveSlot(slot.id);
        logger.error(
          { draftId: draft.id, slotId: slot.id, error },
          "Failed to auto-publish Threads draft",
        );
      }
    }

    return results;
  }

  async publishApprovedNoteDrafts(
    noteApi: NoteApiClient,
  ): Promise<PublishResult[]> {
    if (!this.isChannelWritable("note")) {
      return [];
    }
    const now = new Date().toISOString();
    const eligibleSlots = this.getEligibleNoteSlots(now);

    if (this.dryRun) {
      return eligibleSlots.map(({ slot }) => ({
        id: slot.draftId ?? slot.id,
        url: `dry-run://note/${slot.id}`,
        type: "note",
        draftId: slot.draftId ?? undefined,
      }));
    }

    const results: PublishResult[] = [];
    for (const { slot, draft } of eligibleSlots) {
      if (!slot.draftId) {
        logger.warn({ slotId: slot.id }, "Note slot is missing a draft id");
        await this.skipSlot(slot.id);
        continue;
      }

      if (
        !draft ||
        draft.status !== "audited" ||
        (draft.publishReadinessScore ?? 0) < 5
      ) {
        logger.warn(
          { slotId: slot.id, draftId: slot.draftId },
          "Skipping slot without publish-ready note draft",
        );
        await this.skipSlot(slot.id);
        continue;
      }

      const reserved = await this.reserveSlot(slot.id, draft.id);
      if (!reserved) {
        logger.warn(
          { slotId: slot.id, draftId: draft.id },
          "Note slot was already claimed by another worker",
        );
        continue;
      }

      let outboxId: string | null = null;
      try {
        const pricingHistory = this.collectNotePricingHistory(draft);
        const pricing = determineNotePrice(draft.body, pricingHistory);
        logger.info(
          {
            draftId: draft.id,
            charCount: draft.body.length,
            isPaid: pricing.isPaid,
            priceYen: pricing.priceYen,
            pricingReason: pricing.reason,
            historySampleCount: pricing.historySampleCount,
            targetConversionRate: pricing.targetConversionRate,
          },
          "Determined note pricing",
        );

        const outbox = this.enqueuePublishOutbox({
          targetPlatform: "note",
          slotId: slot.id,
          draftId: draft.id,
          payload: {
            slotId: slot.id,
            draftId: draft.id,
            title: draft.title,
            body: draft.body,
            campaignId: draft.campaignId,
            angleId: draft.angleId,
            ctaId: draft.ctaId,
            priceVariantId: draft.priceVariantId,
            canaryGroup: draft.canaryGroup,
            pricing,
          },
        });
        const claimed = this.ledger.claimOutbox(outbox.id, `note:${slot.id}`);
        outboxId = outbox.id;
        if (!claimed) {
          logger.warn(
            { slotId: slot.id, draftId: draft.id, outboxId: outbox.id },
            "Note outbox was already claimed",
          );
          continue;
        }

        const published = await noteApi.publishArticle(
          draft.title,
          draft.body,
          {
            tags: [],
            isPaid: pricing.isPaid,
            priceYen: pricing.priceYen,
            freePreviewMarkdown: pricing.freePreviewMarkdown,
          },
        );
        const publishedAt = new Date().toISOString();
        try {
          db.transaction((tx) => {
            tx.update(noteDrafts)
              .set({
                status: "published",
                updatedAt: publishedAt,
              })
              .where(eq(noteDrafts.id, draft.id))
              .run();

            tx.insert(notePostResults)
              .values({
                id: randomUUID(),
                draftId: draft.id,
                title: draft.title,
                noteUrl: published.url,
                priceYen: pricing.isPaid ? pricing.priceYen : 0,
                campaignId: draft.campaignId,
                angleId: draft.angleId,
                ctaId: draft.ctaId,
                priceVariantId: draft.priceVariantId,
                canaryGroup: draft.canaryGroup,
                views: 0,
                likes: 0,
                commentsCount: 0,
                purchasesCount: 0,
                revenueYen: 0,
                conversionRate: 0,
                trafficSource: buildTrafficSource(NOTE_TRAFFIC_SOURCE, {
                  strategy: "optimized",
                }),
                publishedAt,
                createdAt: publishedAt,
              })
              .run();

            tx.update(noteIdeas)
              .set({
                status: "published",
              })
              .where(eq(noteIdeas.id, draft.ideaId))
              .run();
          });

          this.createNotePromotionDraft(
            draft.id,
            draft.ideaId,
            draft.title,
            published.url,
            publishedAt,
          );
        } catch (syncError) {
          logger.error(
            {
              draftId: draft.id,
              noteId: published.noteId,
              noteUrl: published.url,
              error:
                syncError instanceof Error
                  ? syncError.message
                  : String(syncError),
            },
            "Note publish succeeded remotely but local sync failed; storing compensation record",
          );

          this.persistPendingNoteSync(draft, publishedAt, pricing, {
            noteId: published.noteId,
            noteUrl: published.url,
            reason: "local_sync_failed_after_remote_publish",
          });
        }

        this.ledger.insertPublicationEvent({
          targetPlatform: "note",
          outboxId: outbox.id,
          draftId: draft.id,
          slotId: slot.id,
          campaignId: draft.campaignId ?? undefined,
          angleId: draft.angleId ?? undefined,
          ctaId: draft.ctaId ?? undefined,
          priceVariantId: draft.priceVariantId ?? undefined,
          canaryGroup: draft.canaryGroup ?? undefined,
          externalId: published.noteId,
          externalUrl: published.url,
          externalFingerprint: `note:${published.noteId}`,
          publishedAt,
        });
        this.ledger.completeOutbox(outbox.id);
        await this.completeSlot(slot.id);

        results.push({
          id: published.noteId,
          url: published.url,
          type: "note",
          draftId: draft.id,
        });
        logger.info(
          { draftId: draft.id, noteId: published.noteId },
          "Auto-published note draft",
        );
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        const isSessionExpired =
          /NOTE_SESSION_EXPIRED|セッション|ログイン|storageState/i.test(
            errorMsg,
          );

        logger.error(
          {
            draftId: draft.id,
            slotId: slot.id,
            error: errorMsg,
            sessionExpired: isSessionExpired,
          },
          "Failed to auto-publish note draft",
        );

        if (isSessionExpired) {
          // Spec §21 (note session ルール): 運用中の手動再ログインを要求しない。
          // session 失効時は sessionHealth を quarantined に降格し、operations-mode が
          // 自動的に threads_only モードへ移行する。次のheartbeatで自動復帰判定。
          this.ledger.updateSessionHealth({
            scope: "note",
            provider: "playwright",
            state: "quarantined",
            detail: `note publish session expired (draftId=${draft.id})`,
            metadata: { draftId: draft.id, errorMsg: errorMsg.slice(0, 500) },
          });
          this.ledger.recordAnomaly({
            category: "note_session_quarantined",
            severity: "high",
            message:
              "note session が失効したため quarantine に降格。operations-mode が threads_only に降格します",
            metadata: { draftId: draft.id, slotId: slot.id },
          });
        }

        try {
          db.insert(outboundNotifications)
            .values({
              id: randomUUID(),
              type: isSessionExpired
                ? "note_session_quarantined"
                : "note_publish_failed",
              channel: "ops",
              content: isSessionExpired
                ? `note運用を一時停止し、Threads-only モードに切替えました (draftId=${draft.id})`
                : `note自動公開失敗: ${errorMsg.slice(0, 200)} (draftId=${draft.id})`,
              sentAt: new Date().toISOString(),
            })
            .run();
        } catch (notifyErr) {
          logger.warn(
            { notifyErr },
            "Failed to record note publish failure notification",
          );
        }

        if (outboxId) {
          this.ledger.failOutbox(outboxId, errorMsg);
        } else {
          const outboxIdempotencyKey = `publish:note:${slot.id}:${draft.id}`;
          const outbox = db
            .select()
            .from(executionOutbox)
            .where(eq(executionOutbox.idempotencyKey, outboxIdempotencyKey))
            .get();
          if (outbox) {
            this.ledger.failOutbox(outbox.id, errorMsg);
          }
        }

        if (isSessionExpired) {
          await this.skipSlot(slot.id);
        } else {
          await this.unreserveSlot(slot.id);
        }
      }
    }

    return results;
  }

  async sendSafeReplies(api: ThreadsApiClient): Promise<number> {
    if (!this.isChannelWritable("threads")) {
      return 0;
    }
    const pending = db
      .select({
        decisionId: replyDecisions.id,
        replyId: replyDecisions.replyId,
        autoReplyBody: replyDecisions.autoReplyBody,
        sentAt: replyDecisions.sentAt,
        threadReplyId: threadReplies.id,
        postResultId: threadReplies.postResultId,
        originalPostId: threadPostResults.threadsPostId,
      })
      .from(replyDecisions)
      .innerJoin(threadReplies, eq(replyDecisions.replyId, threadReplies.id))
      .innerJoin(
        threadPostResults,
        eq(threadReplies.postResultId, threadPostResults.id),
      )
      .where(
        and(
          eq(replyDecisions.decision, "safe_auto_reply"),
          isNull(replyDecisions.sentAt),
        ),
      )
      .orderBy(desc(replyDecisions.createdAt))
      .limit(this.maxRepliesPerHour)
      .all();

    let sent = 0;

    if (this.dryRun) {
      return pending.filter((item) => Boolean(item.autoReplyBody)).length;
    }

    for (const pendingReply of pending) {
      if (!pendingReply.autoReplyBody) {
        continue;
      }

      const claimAt = new Date().toISOString();
      db.update(replyDecisions)
        .set({ sentAt: claimAt })
        .where(
          and(
            eq(replyDecisions.id, pendingReply.decisionId),
            isNull(replyDecisions.sentAt),
          ),
        )
        .run();

      const targetPost = db
        .select()
        .from(threadPostResults)
        .where(eq(threadPostResults.id, pendingReply.postResultId))
        .get();

      if (!targetPost) {
        db.update(replyDecisions)
          .set({ sentAt: null })
          .where(eq(replyDecisions.id, pendingReply.decisionId))
          .run();
        continue;
      }

      try {
        await api.replyToPost(
          pendingReply.threadReplyId,
          pendingReply.autoReplyBody,
        );
        sent++;
        logger.info(
          {
            replyId: pendingReply.threadReplyId,
            postId: targetPost.threadsPostId,
          },
          "Auto-replied to Threads post",
        );
      } catch (error) {
        db.update(replyDecisions)
          .set({ sentAt: null })
          .where(eq(replyDecisions.id, pendingReply.decisionId))
          .run();
        logger.error(
          { replyId: pendingReply.threadReplyId, error },
          "Failed to auto-reply",
        );
      }
    }

    return sent;
  }

  private async reserveSlot(slotId: string, draftId: string): Promise<boolean> {
    const result = db
      .update(contentSlots)
      .set({
        draftId,
        status: "reserved",
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(eq(contentSlots.id, slotId), eq(contentSlots.status, "pending")),
      )
      .run();
    return result.changes > 0;
  }

  private async unreserveSlot(slotId: string): Promise<void> {
    db.update(contentSlots)
      .set({
        status: "pending",
        updatedAt: new Date().toISOString(),
      })
      .where(eq(contentSlots.id, slotId))
      .run();
  }

  private async completeSlot(slotId: string): Promise<void> {
    db.update(contentSlots)
      .set({
        status: "published",
        updatedAt: new Date().toISOString(),
      })
      .where(eq(contentSlots.id, slotId))
      .run();
  }

  private async skipSlot(slotId: string): Promise<void> {
    db.update(contentSlots)
      .set({
        status: "skipped",
        updatedAt: new Date().toISOString(),
      })
      .where(eq(contentSlots.id, slotId))
      .run();
  }
}

export {
  buildTrafficSource,
  determineNotePrice,
  type NotePricingHistory,
  parseTrafficSource,
};
