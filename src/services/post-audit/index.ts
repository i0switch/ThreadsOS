import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { LlmClient } from "../../adapters/llm/index.js";
import { logger } from "../../app/logger.js";
import { db } from "../../db/index.js";
import { createRuntimeLedgerRepository } from "../../db/repositories/runtime-ledger.js";
import { threadPostAudits, threadPostDrafts } from "../../db/schema.js";
import type { ThreadPostAudit } from "../../domain/threads/index.js";
import { parseJsonArray } from "../../utils/llm-json.js";
import { normalizeAuditorAction } from "../auditor/index.js";
import { ProfileContextServiceImpl } from "../profile-context/index.js";

const AUDIT_BATCH_SIZE = 5;

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
  auditDraftsBatch(
    draftIds: string[],
    llm: LlmClient,
  ): Promise<Map<string, ThreadPostAudit>>;
  getAudit(auditId: string): Promise<ThreadPostAudit | null>;
  getAuditForDraft(draftId: string): Promise<ThreadPostAudit | null>;
}

export class PostAuditServiceImpl implements PostAuditService {
  private profileService = new ProfileContextServiceImpl();
  private ledger = createRuntimeLedgerRepository();

  private buildCriteria(): string[] {
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

    return criteria;
  }

  private saveAuditResult(
    draftId: string,
    auditResult: {
      verdict: "pass" | "revise" | "reject";
      severity: "low" | "medium" | "high";
      reasons: string[];
      suggestions: string[];
      score: number;
    },
  ): ThreadPostAudit {
    const now = new Date().toISOString();
    const verdict = auditResult.verdict as ThreadPostAudit["verdict"];
    const severity = auditResult.severity as ThreadPostAudit["severity"];
    const auditorAction = normalizeAuditorAction({
      verdict,
      severity,
      score: auditResult.score,
    });
    const existingAudit = db
      .select()
      .from(threadPostAudits)
      .where(eq(threadPostAudits.draftId, draftId))
      .get();
    const id = existingAudit?.id ?? randomUUID();

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
          auditorAction === "pass"
            ? "audited"
            : auditorAction === "skip"
              ? "rejected"
              : "draft",
        updatedAt: now,
      })
      .where(eq(threadPostDrafts.id, draftId))
      .run();

    this.ledger.recordDecisionEvidence({
      entityType: "thread_draft",
      entityId: draftId,
      decisionType: `auditor_${auditorAction}`,
      evidence: {
        verdict,
        severity,
        score: auditResult.score,
        reasons: auditResult.reasons,
        suggestions: auditResult.suggestions,
      },
    });

    if (auditorAction === "quarantine") {
      this.ledger.recordAnomaly({
        category: "auditor_quarantine",
        severity: "high",
        message: `Thread draft ${draftId} quarantined by auditor`,
        metadata: {
          draftId,
          reasons: auditResult.reasons,
          severity,
        },
      });
      logger.warn({ draftId, severity }, "Draft quarantined by auditor");
    }

    logger.info({ draftId, verdict, severity, auditorAction }, "Draft audited");

    return {
      id,
      draftId,
      verdict,
      severity,
      reasons: auditResult.reasons,
      suggestions: auditResult.suggestions,
    };
  }

  async auditDraft(draftId: string, llm: LlmClient): Promise<ThreadPostAudit> {
    const draft = db
      .select()
      .from(threadPostDrafts)
      .where(eq(threadPostDrafts.id, draftId))
      .get();

    if (!draft) throw new Error(`Draft not found: ${draftId}`);

    const criteria = this.buildCriteria();

    const auditResult = await llm.audit(draft.body, criteria, {
      label: "thread-post-audit",
    });
    return this.saveAuditResult(draftId, {
      verdict: auditResult.verdict,
      severity: auditResult.severity,
      reasons: auditResult.reasons ?? [],
      suggestions: auditResult.suggestions ?? [],
      score: auditResult.score ?? 5,
    });
  }

  async auditDraftsBatch(
    draftIds: string[],
    llm: LlmClient,
  ): Promise<Map<string, ThreadPostAudit>> {
    const uniqueDraftIds = [...new Set(draftIds)];
    const results = new Map<string, ThreadPostAudit>();

    if (uniqueDraftIds.length === 0) {
      return results;
    }

    const criteria = this.buildCriteria();

    for (let i = 0; i < uniqueDraftIds.length; i += AUDIT_BATCH_SIZE) {
      const chunkIds = uniqueDraftIds.slice(i, i + AUDIT_BATCH_SIZE);
      const chunkResults = await this.auditDraftsChunk(chunkIds, criteria, llm);
      for (const [draftId, audit] of chunkResults) {
        results.set(draftId, audit);
      }
    }

    return results;
  }

  private async auditDraftsChunk(
    chunkIds: string[],
    criteria: string[],
    llm: LlmClient,
  ): Promise<Map<string, ThreadPostAudit>> {
    const results = new Map<string, ThreadPostAudit>();

    const drafts = chunkIds.map((draftId) => {
      const draft = db
        .select()
        .from(threadPostDrafts)
        .where(eq(threadPostDrafts.id, draftId))
        .get();
      if (!draft) {
        throw new Error(`Draft not found: ${draftId}`);
      }
      return draft;
    });

    const prompt = `以下のThreads投稿ドラフトをまとめて監査してください。

## 監査基準
${criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}

## 対象ドラフト
${drafts
  .map(
    (draft, index) =>
      `### Draft ${index + 1}\ndraftId: ${draft.id}\nbody:\n${draft.body}`,
  )
  .join("\n\n")}

## 回答形式 (JSON配列のみ)
[
  {
    "draftId": "draft-id",
    "verdict": "pass" | "revise" | "reject",
    "severity": "low" | "medium" | "high",
    "reasons": ["理由1", "理由2"],
    "suggestions": ["改善案1", "改善案2"],
    "score": 0-10
  }
]`;

    const raw = await llm.generate(prompt, {
      label: "thread-post-audit-batch",
      temperature: 0.3,
      systemPrompt:
        "You are a content auditor. Return ONLY a valid JSON array.",
      tier: "premium",
    });

    const parsed =
      parseJsonArray<{
        draftId: string;
        verdict: "pass" | "revise" | "reject";
        severity: "low" | "medium" | "high";
        reasons: string[];
        suggestions: string[];
        score: number;
      }>(raw) ?? [];

    const parsedMap = new Map(parsed.map((entry) => [entry.draftId, entry]));

    for (const draft of drafts) {
      const batchResult = parsedMap.get(draft.id);
      if (!batchResult) {
        logger.warn(
          { draftId: draft.id, rawPreview: raw.slice(0, 200) },
          "Batch audit missing draft result, falling back to single audit",
        );
        results.set(draft.id, await this.auditDraft(draft.id, llm));
        continue;
      }

      results.set(
        draft.id,
        this.saveAuditResult(draft.id, {
          verdict: batchResult.verdict,
          severity: batchResult.severity,
          reasons: batchResult.reasons ?? [],
          suggestions: batchResult.suggestions ?? [],
          score: batchResult.score ?? 5,
        }),
      );
    }

    return results;
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
