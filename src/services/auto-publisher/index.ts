import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, lte } from "drizzle-orm";
import type { NoteApiClient } from "../../adapters/note-api/index.js";
import type { ThreadsApiClient } from "../../adapters/threads-api/index.js";
import { logger } from "../../app/logger.js";
import { db } from "../../db/index.js";
import {
  contentSlots,
  noteDrafts,
  noteIdeas,
  notePostResults,
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

export interface AutoPublisherOptions {
  maxPostsPerHour?: number;
  maxRepliesPerHour?: number;
  dryRun?: boolean;
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
}

function determineNotePrice(bodyText: string): NotePricingResult {
  const charCount = bodyText.length;

  if (charCount < 3000) {
    return { isPaid: false, priceYen: 0, freePreviewMarkdown: undefined };
  }

  let priceYen: number;
  if (charCount < 5000) {
    priceYen = 690;
  } else if (charCount < 8000) {
    priceYen = 980;
  } else {
    priceYen = 1480;
  }

  // Free preview: first 30% of the body, capped at 2000 characters
  const previewLength = Math.min(Math.floor(charCount * 0.3), 2000);
  const freePreviewMarkdown = bodyText.slice(0, previewLength);

  return { isPaid: true, priceYen, freePreviewMarkdown };
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

  constructor(options: AutoPublisherOptions = {}) {
    this.maxPostsPerHour =
      options.maxPostsPerHour ?? readEnvInt("MAX_POSTS_PER_HOUR", 3);
    this.maxRepliesPerHour =
      options.maxRepliesPerHour ?? readEnvInt("MAX_REPLIES_PER_HOUR", 10);
    this.dryRun = options.dryRun ?? false;
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
            (draft.publishReadinessScore ?? 0) >= 7,
        ),
      );
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

      await this.reserveSlot(slot.id, draft.id);

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
            impressions: 0,
            likes: 0,
            repliesCount: 0,
            shares: 0,
            publishedAt,
            createdAt: publishedAt,
          })
          .run();

        await this.completeSlot(slot.id);
        results.push({ id: postId, url: permalink, type: "threads" });
        logger.info({ draftId: draft.id, postId }, "Auto-published to Threads");
      } catch (error) {
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
        (draft.publishReadinessScore ?? 0) < 7
      ) {
        logger.warn(
          { slotId: slot.id, draftId: slot.draftId },
          "Skipping slot without publish-ready note draft",
        );
        await this.skipSlot(slot.id);
        continue;
      }

      await this.reserveSlot(slot.id, draft.id);

      try {
        const pricing = determineNotePrice(draft.body);
        logger.info(
          {
            draftId: draft.id,
            charCount: draft.body.length,
            isPaid: pricing.isPaid,
            priceYen: pricing.priceYen,
          },
          "Determined note pricing",
        );

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

        db.update(noteDrafts)
          .set({
            status: "published",
            updatedAt: publishedAt,
          })
          .where(eq(noteDrafts.id, draft.id))
          .run();

        db.insert(notePostResults)
          .values({
            id: randomUUID(),
            draftId: draft.id,
            noteUrl: published.url,
            views: 0,
            likes: 0,
            commentsCount: 0,
            publishedAt,
            createdAt: publishedAt,
          })
          .run();

        db.update(noteIdeas)
          .set({
            status: "published",
          })
          .where(eq(noteIdeas.id, draft.ideaId))
          .run();

        this.createNotePromotionDraft(
          draft.id,
          draft.ideaId,
          draft.title,
          published.url,
          publishedAt,
        );

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
        await this.unreserveSlot(slot.id);
        logger.error(
          { draftId: draft.id, slotId: slot.id, error },
          "Failed to auto-publish note draft",
        );
      }
    }

    return results;
  }

  async sendSafeReplies(api: ThreadsApiClient): Promise<number> {
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

  private async reserveSlot(slotId: string, draftId: string): Promise<void> {
    db.update(contentSlots)
      .set({
        draftId,
        status: "reserved",
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(eq(contentSlots.id, slotId), eq(contentSlots.status, "pending")),
      )
      .run();
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
