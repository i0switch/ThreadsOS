import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { LlmClient } from "../../adapters/llm/index.js";
import { logger } from "../../app/logger.js";
import { db } from "../../db/index.js";
import {
  humanReviewItems,
  threadPostAudits,
  threadPostDrafts,
} from "../../db/schema.js";
import type { ThreadPostAudit } from "../../domain/threads/index.js";
import { ProfileContextServiceImpl } from "../profile-context/index.js";

const BASE_AUDIT_CRITERIA = [
  "誇張しすぎ",
  "具体性不足",
  "フック弱い",
  "CTA弱い",
  "炎上 / 規約 / 誤情報リスク",
  "根拠不足",
  "note導線が不自然",
  "同一テーマ擦りすぎ",
  "ブランド口調からズレてる",
];

export interface PostAuditService {
  auditDraft(draftId: string, llm: LlmClient): Promise<ThreadPostAudit>;
  getAudit(auditId: string): Promise<ThreadPostAudit | null>;
  getAuditForDraft(draftId: string): Promise<ThreadPostAudit | null>;
}

export class PostAuditServiceImpl implements PostAuditService {
  private profileService = new ProfileContextServiceImpl();

  async auditDraft(draftId: string, llm: LlmClient): Promise<ThreadPostAudit> {
    const draft = db
      .select()
      .from(threadPostDrafts)
      .where(eq(threadPostDrafts.id, draftId))
      .get();

    if (!draft) throw new Error(`Draft not found: ${draftId}`);

    const profile = this.profileService.getProfileContext();
    const criteria = [...BASE_AUDIT_CRITERIA];

    if (profile) {
      if (profile.forbiddenTopics.length > 0) {
        criteria.push(
          `禁止トピックを含んでいる (${profile.forbiddenTopics.join(", ")})`,
        );
      }
      if (profile.tone) {
        criteria.push(`指定トーンからズレている (${profile.tone})`);
      }
    }

    const auditResult = await llm.audit(draft.body, criteria);

    const now = new Date().toISOString();
    const verdict = auditResult.verdict as ThreadPostAudit["verdict"];
    const severity = auditResult.severity as ThreadPostAudit["severity"];
    const existingAudit = db
      .select()
      .from(threadPostAudits)
      .where(eq(threadPostAudits.draftId, draftId))
      .get();
    const id = existingAudit?.id ?? randomUUID();
    const needsReview =
      severity === "high" || (verdict as string) === "human_review";
    const reviewReason = auditResult.reasons.join("; ");
    const existingReviewItem = db
      .select()
      .from(humanReviewItems)
      .where(
        and(
          eq(humanReviewItems.itemType, "thread_draft"),
          eq(humanReviewItems.itemId, draftId),
        ),
      )
      .get();

    if (existingAudit) {
      db.update(threadPostAudits)
        .set({
          verdict,
          severity,
          reasons: JSON.stringify(auditResult.reasons),
          suggestions: JSON.stringify(auditResult.suggestions),
          createdAt: now,
        })
        .where(eq(threadPostAudits.draftId, draftId))
        .run();
    } else {
      db.insert(threadPostAudits)
        .values({
          id,
          draftId,
          verdict,
          severity,
          reasons: JSON.stringify(auditResult.reasons),
          suggestions: JSON.stringify(auditResult.suggestions),
          createdAt: now,
        })
        .run();
    }

    db.update(threadPostDrafts)
      .set({
        status:
          verdict === "pass"
            ? "audited"
            : verdict === "reject"
              ? "rejected"
              : "draft",
        updatedAt: now,
      })
      .where(eq(threadPostDrafts.id, draftId))
      .run();

    if (needsReview) {
      if (existingReviewItem) {
        db.update(humanReviewItems)
          .set({
            reason: reviewReason,
            status: "pending",
            reviewedAt: null,
            reviewerNote: null,
          })
          .where(eq(humanReviewItems.id, existingReviewItem.id))
          .run();
      } else {
        db.insert(humanReviewItems)
          .values({
            id: randomUUID(),
            itemType: "thread_draft",
            itemId: draftId,
            reason: reviewReason,
            status: "pending",
            createdAt: now,
          })
          .run();
      }
      logger.warn({ draftId, severity }, "Draft sent to human review");
    } else if (existingReviewItem && existingReviewItem.status === "pending") {
      db.update(humanReviewItems)
        .set({
          status: "approved",
          reviewedAt: now,
          reviewerNote: "Auto-cleared after re-audit",
        })
        .where(eq(humanReviewItems.id, existingReviewItem.id))
        .run();
    }

    logger.info({ draftId, verdict, severity }, "Draft audited");

    return {
      id,
      draftId,
      verdict,
      severity,
      reasons: auditResult.reasons,
      suggestions: auditResult.suggestions,
    };
  }

  async getAudit(auditId: string): Promise<ThreadPostAudit | null> {
    const row = db
      .select()
      .from(threadPostAudits)
      .where(eq(threadPostAudits.id, auditId))
      .get();
    if (!row) return null;
    return {
      id: row.id,
      draftId: row.draftId,
      verdict: row.verdict as ThreadPostAudit["verdict"],
      severity: row.severity as ThreadPostAudit["severity"],
      reasons: JSON.parse(row.reasons),
      suggestions: JSON.parse(row.suggestions),
    };
  }

  async getAuditForDraft(draftId: string): Promise<ThreadPostAudit | null> {
    const row = db
      .select()
      .from(threadPostAudits)
      .where(eq(threadPostAudits.draftId, draftId))
      .get();
    if (!row) return null;
    return {
      id: row.id,
      draftId: row.draftId,
      verdict: row.verdict as ThreadPostAudit["verdict"],
      severity: row.severity as ThreadPostAudit["severity"],
      reasons: JSON.parse(row.reasons),
      suggestions: JSON.parse(row.suggestions),
    };
  }
}
