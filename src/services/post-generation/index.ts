import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { LlmClient } from "../../adapters/llm/index.js";
import { logger } from "../../app/logger.js";
import { db } from "../../db/index.js";
import { threadPostDrafts } from "../../db/schema.js";
import type { ThreadPostDraft } from "../../domain/threads/index.js";
import { parseJsonArray, parseJsonObject } from "../../utils/llm-json.js";
import { ProfileContextServiceImpl } from "../profile-context/index.js";

export interface PostGenerationService {
  generateDrafts(
    topicId: string,
    topicName: string,
    researchSummary: string,
    count: number,
    llm: LlmClient,
    improvementInsights?: string,
  ): Promise<ThreadPostDraft[]>;
  getDraft(draftId: string): Promise<ThreadPostDraft | null>;
  regenerateDraft(
    draftId: string,
    feedback: string,
    llm: LlmClient,
  ): Promise<ThreadPostDraft>;
}

export class PostGenerationServiceImpl implements PostGenerationService {
  private profileService = new ProfileContextServiceImpl();

  async generateDrafts(
    topicId: string,
    topicName: string,
    researchSummary: string,
    count: number,
    llm: LlmClient,
    improvementInsights?: string,
  ): Promise<ThreadPostDraft[]> {
    const profileText = this.profileService.formatForPrompt();
    const profileSection = profileText
      ? `\n## 運用者プロフィール\n${profileText}\n`
      : "";
    const insightsSection = improvementInsights
      ? `\n## 過去の分析から得た改善指示\n${improvementInsights}\n`
      : "";

    const prompt = `あなたはThreads投稿のドラフトを作成するコピーライターです。
${profileSection}
## トピック
${topicName}

## リサーチ
${researchSummary}
${insightsSection}
## 要件
- ${count}本の投稿候補を作成
- 1投稿1メッセージ原則
- 強いフック（最初の1行が勝負）
- 具体性優先（抽象論NG）
- noteへの自然な導線
- 各候補は構造が異なること

## 回答形式 (JSON配列)
[
  {
    "body": "投稿本文",
    "hookType": "curiosity" | "benefit" | "contrarian" | "story" | "question",
    "ctaType": "save" | "share" | "comment" | "link" | "none",
    "noteTransition": "noteへの展開仮説"
  }
]`;

    const raw = await llm.generate(prompt, {
      temperature: 0.8,
      systemPrompt:
        "Return ONLY a valid JSON array as requested. No explanation, no preamble, no markdown code blocks.",
    });

    const parsed =
      parseJsonArray<{
        body: string;
        hookType: string;
        ctaType: string;
        noteTransition: string;
      }>(raw) ?? [];

    if (parsed.length === 0) {
      logger.warn(
        { rawPreview: raw.slice(0, 200) },
        "Failed to parse generated drafts",
      );
    }

    const drafts: ThreadPostDraft[] = [];
    const now = new Date().toISOString();

    for (const item of parsed) {
      if (!item.body) {
        logger.warn("Draft missing body field – skipping");
        continue;
      }

      if (item.body.length > 500) {
        logger.warn(
          { bodyLength: item.body.length },
          "Draft exceeds 500 chars – marking as rejected",
        );
        const id = randomUUID();
        db.insert(threadPostDrafts)
          .values({
            id,
            topicId,
            body: item.body,
            hookType: item.hookType,
            ctaType: item.ctaType,
            noteTransition: item.noteTransition,
            status: "rejected",
            createdAt: now,
            updatedAt: now,
          })
          .run();
        continue;
      }

      const id = randomUUID();
      db.insert(threadPostDrafts)
        .values({
          id,
          topicId,
          body: item.body,
          hookType: item.hookType,
          ctaType: item.ctaType,
          noteTransition: item.noteTransition,
          status: "draft",
          createdAt: now,
          updatedAt: now,
        })
        .run();

      drafts.push({
        id,
        topicId,
        body: item.body,
        hookType: item.hookType,
        ctaType: item.ctaType,
        noteTransition: item.noteTransition,
        status: "draft",
      });
    }

    logger.info({ topicId, count: drafts.length }, "Drafts generated");
    return drafts;
  }

  async getDraft(draftId: string): Promise<ThreadPostDraft | null> {
    const row = db
      .select()
      .from(threadPostDrafts)
      .where(eq(threadPostDrafts.id, draftId))
      .get();
    if (!row) return null;
    return {
      id: row.id,
      topicId: row.topicId,
      body: row.body,
      hookType: row.hookType,
      ctaType: row.ctaType,
      noteTransition: row.noteTransition ?? undefined,
      status: row.status as ThreadPostDraft["status"],
    };
  }

  async regenerateDraft(
    draftId: string,
    feedback: string,
    llm: LlmClient,
  ): Promise<ThreadPostDraft> {
    const existing = await this.getDraft(draftId);
    if (!existing) throw new Error(`Draft not found: ${draftId}`);

    const profileText = this.profileService.formatForPrompt();
    const profileSection = profileText
      ? `\n## 運用者プロフィール\n${profileText}\n`
      : "";

    const prompt = `以下の投稿を改善してください。
${profileSection}
## 元の投稿
${existing.body}

## フィードバック
${feedback}

## 回答形式 (JSON)
{
  "body": "改善版の投稿本文",
  "hookType": "curiosity" | "benefit" | "contrarian" | "story" | "question",
  "ctaType": "save" | "share" | "comment" | "link" | "none",
  "noteTransition": "noteへの展開仮説"
}`;

    const raw = await llm.generate(prompt, { temperature: 0.7 });
    const parsed = parseJsonObject<{
      body: string;
      hookType: string;
      ctaType: string;
      noteTransition?: string;
    }>(raw) ?? {
      body: existing.body,
      hookType: existing.hookType,
      ctaType: existing.ctaType,
      noteTransition: existing.noteTransition,
    };

    const now = new Date().toISOString();
    const newId = randomUUID();

    db.insert(threadPostDrafts)
      .values({
        id: newId,
        topicId: existing.topicId,
        body: parsed.body,
        hookType: parsed.hookType,
        ctaType: parsed.ctaType,
        noteTransition: parsed.noteTransition,
        status: "draft",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    return {
      id: newId,
      topicId: existing.topicId,
      body: parsed.body,
      hookType: parsed.hookType,
      ctaType: parsed.ctaType,
      noteTransition: parsed.noteTransition,
      status: "draft",
    };
  }
}
