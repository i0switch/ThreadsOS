import { and, desc, eq, isNull } from "drizzle-orm";
import type { ThreadsApiClient } from "../../adapters/threads-api/index.js";
import { logger } from "../../app/logger.js";
import { db } from "../../db/index.js";
import { replyDecisions, threadReplies } from "../../db/schema.js";

type ReplyQueueItem = {
  decision: typeof replyDecisions.$inferSelect;
  reply: typeof threadReplies.$inferSelect;
};

export interface ReplyExecutionService {
  buildReplyQueue(limit?: number): Promise<ReplyQueueItem[]>;
  executeSafeReplies(api: ThreadsApiClient): Promise<number>;
}

export class ReplyExecutionServiceImpl implements ReplyExecutionService {
  private readonly maxRepliesPerHour: number;

  constructor(maxRepliesPerHour = 10) {
    this.maxRepliesPerHour = maxRepliesPerHour;
  }

  async buildReplyQueue(
    limit = this.maxRepliesPerHour,
  ): Promise<ReplyQueueItem[]> {
    return db
      .select({
        decision: replyDecisions,
        reply: threadReplies,
      })
      .from(replyDecisions)
      .innerJoin(threadReplies, eq(replyDecisions.replyId, threadReplies.id))
      .where(
        and(
          eq(replyDecisions.decision, "safe_auto_reply"),
          isNull(replyDecisions.sentAt),
        ),
      )
      .orderBy(desc(replyDecisions.createdAt))
      .limit(limit)
      .all();
  }

  async executeSafeReplies(api: ThreadsApiClient): Promise<number> {
    const pending = await this.buildReplyQueue(this.maxRepliesPerHour);

    let sent = 0;

    for (const { decision, reply } of pending) {
      if (!decision.autoReplyBody) {
        continue;
      }

      const reservedAt = new Date().toISOString();
      const reserved = db
        .update(replyDecisions)
        .set({ sentAt: reservedAt })
        .where(
          and(
            eq(replyDecisions.id, decision.id),
            isNull(replyDecisions.sentAt),
          ),
        )
        .run();

      if (reserved.changes === 0) {
        continue;
      }

      try {
        await api.replyToPost(reply.threadsReplyId, decision.autoReplyBody);
        sent += 1;
        logger.info(
          { replyDecisionId: decision.id, replyId: reply.id },
          "Auto-replied to thread",
        );
      } catch (error) {
        db.update(replyDecisions)
          .set({ sentAt: null })
          .where(eq(replyDecisions.id, decision.id))
          .run();
        logger.error(
          { replyDecisionId: decision.id, replyId: reply.id, error },
          "Failed to auto-reply",
        );
      }
    }

    return sent;
  }
}
