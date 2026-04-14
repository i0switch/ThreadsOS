import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { LlmClient } from "../../adapters/llm/index.js";
import { logger } from "../../app/logger.js";
import { db } from "../../db/index.js";
import { humanReviewItems, noteAudits, noteDrafts } from "../../db/schema.js";
import type { NoteAudit } from "../../domain/note/index.js";
import { parseJsonObject } from "../../utils/llm-json.js";

const NOTE_AUDIT_CRITERIA = [
  "タイトルが弱い",
  "導入が弱い",
  "インサイト密度が低い",
  "構成が単調",
  "信頼性シグナルが弱い",
  "根拠のない主張",
  "公開タイミングが弱い",
  "導線強度が弱い",
  "Threads連携性が弱い",
  "CTAが不自然",
  "マネタイズ角度が弱い",
  "ブランド口調からズレてる",
];

function buildReviewReason(
  score: number,
  weakestSection: string,
  guidance: string,
): string {
  const hints = [weakestSection, guidance].filter(Boolean).join(" / ");
  return `Score: ${score}/10. ${hints || "要再監査"}`;
}

export interface NoteAuditService {
  auditDraft(draftId: string, llm: LlmClient): Promise<NoteAudit>;
  getAudit(auditId: string): Promise<NoteAudit | null>;
  getAuditForDraft(draftId: string): Promise<NoteAudit | null>;
}

export class NoteAuditServiceImpl implements NoteAuditService {
  async auditDraft(draftId: string, llm: LlmClient): Promise<NoteAudit> {
    const draft = db
      .select()
      .from(noteDrafts)
      .where(eq(noteDrafts.id, draftId))
      .get();
    if (!draft) throw new Error(`Draft not found: ${draftId}`);

    const prompt = `以下のnote記事ドラフトを監査してください。

## タイトル
${draft.title}

## 本文
${draft.body}

## 監査基準
${NOTE_AUDIT_CRITERIA.map((c, i) => `${i + 1}. ${c}`).join("\n")}

## 重点監査ポイント
- 公開タイミング: 読者が最も反応しやすい時間帯に出せるか
- 導線強度: note から次の行動に自然に進めるか
- Threads連携性: Threads投稿との接続が不自然になっていないか

## 回答形式 (JSONのみ)
{
  "verdict": "pass" | "revise" | "reject" | "human_review",
  "strongestSection": "最も強いセクション",
  "weakestSection": "最も弱いセクション",
  "rewriteGuidance": "具体的な改善指示",
  "score": 0-10
}`;

    const raw = await llm.generate(prompt, {
      label: "note-draft-audit",
      temperature: 0.3,
      tier: "premium",
    });

    let parsed: {
      verdict: string;
      strongestSection: string;
      weakestSection: string;
      rewriteGuidance: string;
      score: number;
    };
    parsed = parseJsonObject<{
      verdict: string;
      strongestSection: string;
      weakestSection: string;
      rewriteGuidance: string;
      score: number;
    }>(raw) ?? {
      // Fix-2 (2026-04-14): パース失敗は revise で自動リトライに (human_reviewに降らない)
      verdict: "revise",
      strongestSection: "",
      weakestSection: "",
      rewriteGuidance: "LLM応答パース失敗。JSON形式で再生成",
      score: 5,
    };

    if (
      !parsed.strongestSection &&
      !parsed.weakestSection &&
      !parsed.rewriteGuidance
    ) {
      // Fix-2 (2026-04-14): 空応答も revise 扱いで再生成ループに回す
      parsed = {
        verdict: "revise",
        strongestSection: "",
        weakestSection: "",
        rewriteGuidance: "監査結果が空。具体的な指摘を出して再生成",
        score: 5,
      };
    }

    const normalizedScore =
      parsed.verdict === "pass" ? Math.max(parsed.score, 7) : parsed.score;
    const now = new Date().toISOString();
    const existingAudit = db
      .select()
      .from(noteAudits)
      .where(eq(noteAudits.draftId, draftId))
      .get();
    const id = existingAudit?.id ?? randomUUID();
    const needsReview =
      parsed.verdict === "human_review" || normalizedScore <= 2;
    const existingReviewItem = db
      .select()
      .from(humanReviewItems)
      .where(
        and(
          eq(humanReviewItems.itemType, "note_draft"),
          eq(humanReviewItems.itemId, draftId),
        ),
      )
      .get();

    if (existingAudit) {
      db.update(noteAudits)
        .set({
          verdict: parsed.verdict,
          strongestSection: parsed.strongestSection,
          weakestSection: parsed.weakestSection,
          rewriteGuidance: parsed.rewriteGuidance,
          score: normalizedScore,
          createdAt: now,
        })
        .where(eq(noteAudits.draftId, draftId))
        .run();
    } else {
      db.insert(noteAudits)
        .values({
          id,
          draftId,
          verdict: parsed.verdict,
          strongestSection: parsed.strongestSection,
          weakestSection: parsed.weakestSection,
          rewriteGuidance: parsed.rewriteGuidance,
          score: normalizedScore,
          createdAt: now,
        })
        .run();
    }

    db.update(noteDrafts)
      .set({
        status:
          parsed.verdict === "pass"
            ? "audited"
            : parsed.verdict === "reject"
              ? "rejected"
              : normalizedScore >= 6
                ? "audited"
                : "draft",
        publishReadinessScore: normalizedScore,
        updatedAt: now,
      })
      .where(eq(noteDrafts.id, draftId))
      .run();

    if (needsReview) {
      const reviewReason = buildReviewReason(
        normalizedScore,
        parsed.weakestSection,
        parsed.rewriteGuidance,
      );
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
            itemType: "note_draft",
            itemId: draftId,
            reason: reviewReason,
            status: "pending",
            createdAt: now,
          })
          .run();
      }
      logger.warn(
        { draftId, score: normalizedScore },
        "Note draft sent to human review",
      );
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

    logger.info(
      { draftId, verdict: parsed.verdict, score: normalizedScore },
      "Note draft audited",
    );

    return {
      id,
      draftId,
      verdict: parsed.verdict as NoteAudit["verdict"],
      strongestSection: parsed.strongestSection,
      weakestSection: parsed.weakestSection,
      rewriteGuidance: parsed.rewriteGuidance,
      score: normalizedScore,
    };
  }

  async getAudit(auditId: string): Promise<NoteAudit | null> {
    const row = db
      .select()
      .from(noteAudits)
      .where(eq(noteAudits.id, auditId))
      .get();
    if (!row) return null;
    return {
      id: row.id,
      draftId: row.draftId,
      verdict: row.verdict as NoteAudit["verdict"],
      strongestSection: row.strongestSection ?? undefined,
      weakestSection: row.weakestSection ?? undefined,
      rewriteGuidance: row.rewriteGuidance ?? undefined,
      score: row.score,
    };
  }

  async getAuditForDraft(draftId: string): Promise<NoteAudit | null> {
    const row = db
      .select()
      .from(noteAudits)
      .where(eq(noteAudits.draftId, draftId))
      .get();
    if (!row) return null;
    return {
      id: row.id,
      draftId: row.draftId,
      verdict: row.verdict as NoteAudit["verdict"],
      strongestSection: row.strongestSection ?? undefined,
      weakestSection: row.weakestSection ?? undefined,
      rewriteGuidance: row.rewriteGuidance ?? undefined,
      score: row.score,
    };
  }
}
