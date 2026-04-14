import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { LlmClient } from "../../adapters/llm/index.js";
import { logger } from "../../app/logger.js";
import { db } from "../../db/index.js";
import {
  competitorSnapshots,
  noteDrafts,
  noteIdeas,
  thumbnailTasks,
} from "../../db/schema.js";
import type { NoteDraft, NoteIdea } from "../../domain/note/index.js";
import { parseJsonArray } from "../../utils/llm-json.js";

export interface ThumbnailTask {
  id: string;
  noteDraftId: string;
  status: "pending" | "completed";
  instruction?: string;
  completedAt?: string;
}

export interface NoteGenerationService {
  createIdea(
    angle: string,
    targetReader: string,
    sourceTopicId?: string,
    priorityScore?: number,
  ): Promise<NoteIdea>;
  listIdeas(status?: string): Promise<NoteIdea[]>;
  generateTitleCandidates(ideaId: string, llm: LlmClient): Promise<string[]>;
  generateOutline(
    ideaId: string,
    title: string,
    retrievalContext: string,
    llm: LlmClient,
  ): Promise<string>;
  generateDraft(
    ideaId: string,
    title: string,
    outline: string,
    retrievalContext: string,
    llm: LlmClient,
  ): Promise<NoteDraft>;
  getDraft(draftId: string): Promise<NoteDraft | null>;
  regenerateDraft(
    draftId: string,
    feedback: string,
    llm: LlmClient,
  ): Promise<NoteDraft>;
  generateChecklist(draftId: string): Promise<string>;
  getRecentCompetitorSnapshots(limit?: number): Promise<string>;
  createThumbnailTask(
    noteDraftId: string,
    instruction?: string,
  ): Promise<string>;
  listThumbnailTasks(
    status?: "pending" | "completed",
  ): Promise<ThumbnailTask[]>;
  completeThumbnailTask(taskId: string): Promise<void>;
}

function summarizeCompetitorData(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .slice(0, 3)
        .map((item) => {
          if (typeof item === "string") return item;
          if (!item || typeof item !== "object") return String(item);
          const record = item as Record<string, unknown>;
          return String(
            record.title ??
              record.snippet ??
              record.body ??
              JSON.stringify(record).slice(0, 120),
          );
        })
        .join(" / ");
    }

    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      return Object.entries(record)
        .slice(0, 4)
        .map(
          ([key, value]) =>
            `${key}:${typeof value === "string" ? value : JSON.stringify(value).slice(0, 60)}`,
        )
        .join(" / ");
    }
  } catch {
    // fall through to truncation
  }

  return raw.slice(0, 240);
}

export class NoteGenerationServiceImpl implements NoteGenerationService {
  async getRecentCompetitorSnapshots(limit = 5): Promise<string> {
    const snapshots = db
      .select()
      .from(competitorSnapshots)
      .orderBy(desc(competitorSnapshots.createdAt))
      .limit(limit)
      .all();

    if (snapshots.length === 0) {
      return "";
    }

    return snapshots
      .map(
        (snapshot) =>
          `- ${snapshot.source}: ${summarizeCompetitorData(snapshot.data)}`,
      )
      .join("\n");
  }

  async createIdea(
    angle: string,
    targetReader: string,
    sourceTopicId?: string,
    priorityScore = 50,
  ): Promise<NoteIdea> {
    const id = randomUUID();
    const now = new Date().toISOString();

    db.insert(noteIdeas)
      .values({
        id,
        sourceTopicId: sourceTopicId ?? null,
        angle,
        targetReader,
        priorityScore,
        status: "idea",
        createdAt: now,
      })
      .run();

    logger.info({ id, angle }, "Note idea created");

    return {
      id,
      sourceTopicId,
      angle,
      targetReader,
      priorityScore,
      status: "idea",
    };
  }

  async listIdeas(status?: string): Promise<NoteIdea[]> {
    const query = status
      ? db.select().from(noteIdeas).where(eq(noteIdeas.status, status))
      : db.select().from(noteIdeas);

    return query.all().map((row) => ({
      id: row.id,
      sourceTopicId: row.sourceTopicId ?? undefined,
      angle: row.angle,
      targetReader: row.targetReader,
      priorityScore: row.priorityScore,
      status: row.status as NoteIdea["status"],
    }));
  }

  async generateTitleCandidates(
    ideaId: string,
    llm: LlmClient,
  ): Promise<string[]> {
    const idea = db
      .select()
      .from(noteIdeas)
      .where(eq(noteIdeas.id, ideaId))
      .get();
    if (!idea) throw new Error(`Idea not found: ${ideaId}`);

    const competitorContext = await this.getRecentCompetitorSnapshots();
    const prompt = `以下のnote記事のアイデアに対して、タイトル候補を5つ作成してください。

## アイデア
- 切り口: ${idea.angle}
- 想定読者: ${idea.targetReader}

${competitorContext ? `## 競合メモ\n${competitorContext}\n` : ""}
## 要件
- 具体的で興味を引く
- クリックしたくなる
- 誇張しすぎない
- 5つとも異なるアプローチ

## 回答形式 (JSON配列)
["タイトル1", "タイトル2", "タイトル3", "タイトル4", "タイトル5"]`;

    const raw = await llm.generate(prompt, {
      label: "note-title-generation",
      temperature: 0.8,
      tier: "fast",
    });
    return parseJsonArray<string>(raw) ?? [];
  }

  async generateOutline(
    ideaId: string,
    title: string,
    retrievalContext: string,
    llm: LlmClient,
  ): Promise<string> {
    const idea = db
      .select()
      .from(noteIdeas)
      .where(eq(noteIdeas.id, ideaId))
      .get();
    if (!idea) throw new Error(`Idea not found: ${ideaId}`);

    const competitorContext = await this.getRecentCompetitorSnapshots();
    const prompt = `以下の情報からnote記事のアウトラインを作成してください。

## タイトル
${title}

## 切り口
${idea.angle}

## 想定読者
${idea.targetReader}

${competitorContext ? `## 競合メモ\n${competitorContext}\n` : ""}${retrievalContext ? `## 関連メモリ/RAG参照\n${retrievalContext}\n` : ""}
## 要件
- H2/H3レベルの見出し構成
- 各セクションの概要を1〜2行で
- 導入→問題提起→本論→具体例→まとめ→CTAの流れ
- 読者が「続きを読みたい」と思う構成

マークダウン形式で返してください。`;

    return llm.generate(prompt, { temperature: 0.6, tier: "standard", label: "note-outline-generation" });
  }

  async generateDraft(
    ideaId: string,
    title: string,
    outline: string,
    retrievalContext: string,
    llm: LlmClient,
  ): Promise<NoteDraft> {
    const idea = db
      .select()
      .from(noteIdeas)
      .where(eq(noteIdeas.id, ideaId))
      .get();
    if (!idea) throw new Error(`Idea not found: ${ideaId}`);

    db.update(noteIdeas)
      .set({ status: "drafting" })
      .where(eq(noteIdeas.id, ideaId))
      .run();

    const competitorContext = await this.getRecentCompetitorSnapshots();
    const prompt = `以下のアウトラインに基づいてnote記事の本文を作成してください。

## タイトル
${title}

## アウトライン
${outline}

## 切り口
${idea.angle}

## 想定読者
${idea.targetReader}

${competitorContext ? `## 競合メモ\n${competitorContext}\n` : ""}${retrievalContext ? `## 関連メモリ/RAG参照\n${retrievalContext}\n` : ""}
## 要件
- 具体的な事例・数字を含める
- 読者に「自分ごと」として感じさせる
- 権威的にならず、共感ベースで書く
- 有料部分にするなら、最も価値のある部分を後半に置く
- CTAは自然に

## 重要な禁止事項
- [要入力]や[ここに入力]などのプレースホルダーは絶対に使わないこと
- 具体的なデータがない場合は、一般的な表現で代替すること
- 例: 「[著者名]」→ 削除して一般的な表現を使う
- 例: 「[URL]」→ 削除してCTAの文言だけにする
- 例: 「[数字]」→ 「多くの」「数十件の」など一般的な表現に置き換える

本文のみをマークダウンで返してください。`;

    const ctaPrompt = `以下のnote記事に適したCTAを1つ作成してください。自然で押し付けがましくないもの。

記事タイトル: ${title}
想定読者: ${idea.targetReader}

CTAのテキストのみ返してください。`;
    const [body, cta] = await Promise.all([
      llm.generate(prompt, { temperature: 0.7, tier: "standard", label: "note-body-generation" }),
      llm.generate(ctaPrompt, { temperature: 0.5, tier: "fast", label: "note-cta-generation" }),
    ]);

    const id = randomUUID();
    const now = new Date().toISOString();

    db.insert(noteDrafts)
      .values({
        id,
        ideaId,
        title,
        body,
        outline,
        cta,
        status: "draft",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    db.update(noteIdeas)
      .set({ status: "drafted" })
      .where(eq(noteIdeas.id, ideaId))
      .run();

    logger.info({ id, title }, "Note draft generated");

    return { id, ideaId, title, body, outline, cta, status: "draft" };
  }

  async getDraft(draftId: string): Promise<NoteDraft | null> {
    const row = db
      .select()
      .from(noteDrafts)
      .where(eq(noteDrafts.id, draftId))
      .get();
    if (!row) return null;
    return {
      id: row.id,
      ideaId: row.ideaId,
      title: row.title,
      body: row.body,
      outline: row.outline ?? undefined,
      cta: row.cta ?? undefined,
      publishReadinessScore: row.publishReadinessScore ?? undefined,
      status: row.status as NoteDraft["status"],
    };
  }

  async regenerateDraft(
    draftId: string,
    feedback: string,
    llm: LlmClient,
  ): Promise<NoteDraft> {
    const existing = await this.getDraft(draftId);
    if (!existing) throw new Error(`Draft not found: ${draftId}`);

    const prompt = `以下のnote記事を改善してください。

## 現在の記事
タイトル: ${existing.title}
本文:
${existing.body}

## フィードバック
${feedback}

## 重要な禁止事項
- [要入力]や[ここに入力]などのプレースホルダーは絶対に使わないこと
- 具体的なデータがない場合は、一般的な表現で代替すること
- 例: 「[著者名]」→ 削除して一般的な表現を使う
- 例: 「[URL]」→ 削除してCTAの文言だけにする
- 例: 「[数字]」→ 「多くの」「数十件の」など一般的な表現に置き換える

改善版の本文のみをマークダウンで返してください。`;

    const body = await llm.generate(prompt, {
      label: "note-regenerate-draft",
      temperature: 0.6,
      tier: "standard",
    });

    const id = randomUUID();
    const now = new Date().toISOString();

    db.insert(noteDrafts)
      .values({
        id,
        ideaId: existing.ideaId,
        title: existing.title,
        body,
        outline: existing.outline ?? null,
        cta: existing.cta ?? null,
        status: "draft",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    return {
      id,
      ideaId: existing.ideaId,
      title: existing.title,
      body,
      outline: existing.outline,
      cta: existing.cta,
      status: "draft",
    };
  }

  async generateChecklist(draftId: string): Promise<string> {
    const draft = await this.getDraft(draftId);
    if (!draft) throw new Error(`Draft not found: ${draftId}`);

    return `# 手動公開チェックリスト: ${draft.title}

## 公開前確認
- [ ] タイトルは魅力的か
- [ ] サムネイル画像は設定したか
- [ ] 誤字脱字チェック済み
- [ ] 事実関係の確認済み
- [ ] CTA は自然か
- [ ] 有料/無料の境界は適切か
- [ ] タグは設定したか
- [ ] 公開日時は適切か

## 品質確認
- [ ] 導入で読者の興味を引けているか
- [ ] 具体例が十分か
- [ ] 根拠のない断定がないか
- [ ] 読者が行動できる形で終わっているか
- [ ] ブランド口調と一致しているか

## 公開後
- [ ] Threadsで告知投稿を作成
- [ ] 反応を24時間後に確認
- [ ] エンゲージメントデータを記録
- [ ] サムネタスクを作成しているか
`;
  }

  async createThumbnailTask(
    noteDraftId: string,
    instruction?: string,
  ): Promise<string> {
    const id = randomUUID();
    const now = new Date().toISOString();

    db.insert(thumbnailTasks)
      .values({
        id,
        noteDraftId,
        status: "pending",
        instruction:
          instruction ??
          `noteドラフト ${noteDraftId} のサムネを作成してください`,
        createdAt: now,
        completedAt: null,
      })
      .run();

    return id;
  }

  async listThumbnailTasks(
    status?: "pending" | "completed",
  ): Promise<ThumbnailTask[]> {
    const query = status
      ? db
          .select()
          .from(thumbnailTasks)
          .where(eq(thumbnailTasks.status, status))
      : db.select().from(thumbnailTasks);

    return query
      .orderBy(desc(thumbnailTasks.createdAt))
      .all()
      .map((row) => ({
        id: row.id,
        noteDraftId: row.noteDraftId,
        status: row.status as ThumbnailTask["status"],
        instruction: row.instruction ?? undefined,
        completedAt: row.completedAt ?? undefined,
      }));
  }

  async completeThumbnailTask(taskId: string): Promise<void> {
    db.update(thumbnailTasks)
      .set({
        status: "completed",
        completedAt: new Date().toISOString(),
      })
      .where(eq(thumbnailTasks.id, taskId))
      .run();
  }
}
