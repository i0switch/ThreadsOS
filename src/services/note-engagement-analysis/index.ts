import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { LlmClient } from "../../adapters/llm/index.js";
import type { NoteApiClient } from "../../adapters/note-api/index.js";
import { logger } from "../../app/logger.js";
import { db } from "../../db/index.js";
import {
  channelPerformanceSnapshots,
  improvementInsights,
  noteDrafts,
  noteIdeas,
  notePostResults,
  threadPostResults,
} from "../../db/schema.js";

export interface NoteEngagementInsight {
  insight: string;
  action: string;
  priority: "high" | "medium" | "low";
}

export interface NoteEngagementAnalysisService {
  fetchAndStoreNoteResults(noteApi: NoteApiClient): Promise<number>;
  analyzeNotePerformance(llm: LlmClient): Promise<NoteEngagementInsight[]>;
  generateNoteImprovements(llm: LlmClient): Promise<string>;
  connectToThreadsInsights(llm: LlmClient): Promise<string>;
}

interface EnrichedNoteRecord {
  resultId: string;
  draftId: string;
  title: string;
  cta: string;
  angle: string;
  publishedAt: string;
  views: number;
  likes: number;
  comments: number;
}

function formatJstDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function formatJstHour(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const lookup = (type: "year" | "month" | "day" | "hour") =>
    String(parts.find((part) => part.type === type)?.value ?? "00").padStart(
      2,
      "0",
    );
  return `${lookup("year")}-${lookup("month")}-${lookup("day")} ${lookup("hour")}`;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function safeDate(value?: string): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseJsonArray(raw: string): NoteEngagementInsight[] {
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) {
    return [];
  }
  const parsed = JSON.parse(match[0]) as Array<Partial<NoteEngagementInsight>>;
  return parsed
    .map((item) => ({
      insight: normalizeText(String(item.insight ?? "")),
      action: normalizeText(String(item.action ?? "")),
      priority: (item.priority === "high" || item.priority === "low"
        ? item.priority
        : "medium") as NoteEngagementInsight["priority"],
    }))
    .filter((item) => item.insight.length > 0 && item.action.length > 0);
}

function buildFallbackInsights(
  records: EnrichedNoteRecord[],
): NoteEngagementInsight[] {
  if (records.length === 0) {
    return [
      {
        insight: "note実績がまだ少ない",
        action:
          "公開後24〜48時間のデータが集まるまで、タイトルと導線だけを変えて観測する",
        priority: "medium",
      },
    ];
  }

  const averageViews =
    records.reduce((sum, row) => sum + row.views, 0) / records.length;
  const averageLikes =
    records.reduce((sum, row) => sum + row.likes, 0) / records.length;
  const averageComments =
    records.reduce((sum, row) => sum + row.comments, 0) / records.length;

  const insights: NoteEngagementInsight[] = [
    {
      insight: `平均閲覧数は ${averageViews.toFixed(1)} で、noteの初速をまず見るべき状態`,
      action: "冒頭3行のフックを強めて、最初の読了率を優先で上げる",
      priority: "high",
    },
  ];

  if (averageLikes < averageViews * 0.05) {
    insights.push({
      insight: "いいね率が弱い",
      action: "共感よりも実用性を前に出し、保存したくなる具体例を増やす",
      priority: "medium",
    });
  }

  if (averageComments < 1) {
    insights.push({
      insight: "コメントがつきにくい",
      action: "締めに一問一答のCTAを置いて、感想が返しやすい設計にする",
      priority: "low",
    });
  }

  return insights;
}

async function saveSnapshot(
  periodType: string,
  periodKey: string,
  metrics: Record<string, unknown>,
): Promise<void> {
  db.delete(channelPerformanceSnapshots)
    .where(
      and(
        eq(channelPerformanceSnapshots.channel, "note"),
        eq(channelPerformanceSnapshots.periodType, periodType),
        eq(channelPerformanceSnapshots.periodKey, periodKey),
      ),
    )
    .run();

  db.insert(channelPerformanceSnapshots)
    .values({
      id: randomUUID(),
      channel: "note",
      periodType,
      periodKey,
      metrics: JSON.stringify(metrics),
      createdAt: new Date().toISOString(),
    })
    .run();
}

function groupRecords(
  records: EnrichedNoteRecord[],
  keyFn: (record: EnrichedNoteRecord) => string,
): Map<string, EnrichedNoteRecord[]> {
  const grouped = new Map<string, EnrichedNoteRecord[]>();
  for (const record of records) {
    const key = keyFn(record);
    const current = grouped.get(key) ?? [];
    current.push(record);
    grouped.set(key, current);
  }
  return grouped;
}

function summarizeGroup(
  records: EnrichedNoteRecord[],
): Record<string, unknown> {
  const totalViews = records.reduce((sum, row) => sum + row.views, 0);
  const totalLikes = records.reduce((sum, row) => sum + row.likes, 0);
  const totalComments = records.reduce((sum, row) => sum + row.comments, 0);
  return {
    count: records.length,
    totalViews,
    totalLikes,
    totalComments,
    avgViews: records.length > 0 ? totalViews / records.length : 0,
    avgLikes: records.length > 0 ? totalLikes / records.length : 0,
    avgComments: records.length > 0 ? totalComments / records.length : 0,
    topTitle: records[0]?.title ?? "",
  };
}

export class NoteEngagementAnalysisServiceImpl
  implements NoteEngagementAnalysisService
{
  async fetchAndStoreNoteResults(noteApi: NoteApiClient): Promise<number> {
    const articles = await noteApi.getMyArticles();
    const now = new Date().toISOString();
    let stored = 0;

    for (const article of articles) {
      const stats = await noteApi.getArticleStats(article.id);
      const matchedDraft = db
        .select()
        .from(noteDrafts)
        .where(eq(noteDrafts.title, article.title))
        .get();
      const existing = db
        .select()
        .from(notePostResults)
        .where(eq(notePostResults.noteUrl, article.url))
        .get();
      const draftId = matchedDraft?.id ?? article.id;
      const publishedAt = stats.publishedAt ?? article.publishedAt ?? now;

      if (existing) {
        db.update(notePostResults)
          .set({
            draftId,
            views: stats.views,
            likes: stats.likes,
            commentsCount: stats.comments,
            publishedAt,
            createdAt: now,
          })
          .where(eq(notePostResults.id, existing.id))
          .run();
      } else {
        db.insert(notePostResults)
          .values({
            id: randomUUID(),
            draftId,
            noteUrl: article.url,
            views: stats.views,
            likes: stats.likes,
            commentsCount: stats.comments,
            publishedAt,
            createdAt: now,
          })
          .run();
      }

      stored++;
    }

    logger.info({ stored }, "Note results stored");
    return stored;
  }

  async analyzeNotePerformance(
    llm: LlmClient,
  ): Promise<NoteEngagementInsight[]> {
    const rows = db
      .select()
      .from(notePostResults)
      .orderBy(desc(notePostResults.publishedAt))
      .all();
    const enriched: EnrichedNoteRecord[] = [];

    for (const row of rows) {
      const draft = db
        .select()
        .from(noteDrafts)
        .where(eq(noteDrafts.id, row.draftId))
        .get();
      const idea = draft
        ? db
            .select()
            .from(noteIdeas)
            .where(eq(noteIdeas.id, draft.ideaId))
            .get()
        : null;
      const publishedAt = safeDate(row.publishedAt);
      if (!publishedAt) {
        continue;
      }

      enriched.push({
        resultId: row.id,
        draftId: row.draftId,
        title: draft?.title ?? row.noteUrl ?? row.draftId,
        cta: draft?.cta ?? "",
        angle: idea?.angle ?? "",
        publishedAt: row.publishedAt,
        views: row.views,
        likes: row.likes,
        comments: row.commentsCount,
      });
    }

    const hourly = groupRecords(enriched, (record) =>
      formatJstHour(new Date(record.publishedAt)),
    );
    const daily = groupRecords(enriched, (record) =>
      formatJstDate(new Date(record.publishedAt)),
    );
    const theme = groupRecords(enriched, (record) => record.angle || "unknown");
    const cta = groupRecords(enriched, (record) => record.cta || "none");

    await saveSnapshot(
      "hourly",
      "note-hourly",
      Object.fromEntries(
        [...hourly.entries()].map(([key, value]) => [
          key,
          summarizeGroup(value),
        ]),
      ),
    );
    await saveSnapshot(
      "daily",
      "note-daily",
      Object.fromEntries(
        [...daily.entries()].map(([key, value]) => [
          key,
          summarizeGroup(value),
        ]),
      ),
    );
    await saveSnapshot(
      "theme",
      "note-theme",
      Object.fromEntries(
        [...theme.entries()].map(([key, value]) => [
          key,
          summarizeGroup(value),
        ]),
      ),
    );
    await saveSnapshot(
      "cta",
      "note-cta",
      Object.fromEntries(
        [...cta.entries()].map(([key, value]) => [key, summarizeGroup(value)]),
      ),
    );

    const prompt = `以下のnote実績を分析して、次回改善に効くJSON配列を返して。

## 集計
${JSON.stringify(
  {
    noteCount: enriched.length,
    hourly: Object.fromEntries(
      [...hourly.entries()].map(([key, value]) => [key, summarizeGroup(value)]),
    ),
    daily: Object.fromEntries(
      [...daily.entries()].map(([key, value]) => [key, summarizeGroup(value)]),
    ),
    theme: Object.fromEntries(
      [...theme.entries()].map(([key, value]) => [key, summarizeGroup(value)]),
    ),
    cta: Object.fromEntries(
      [...cta.entries()].map(([key, value]) => [key, summarizeGroup(value)]),
    ),
  },
  null,
  2,
)}

## 回答形式
[
  {
    "insight": "気づき",
    "action": "次にやる改善",
    "priority": "high" | "medium" | "low"
  }
]`;

    let insights: NoteEngagementInsight[] = [];
    try {
      const raw = await llm.generate(prompt, { temperature: 0.4 });
      insights = parseJsonArray(raw);
    } catch (error) {
      logger.warn({ error }, "Failed to generate note performance insights");
    }

    if (insights.length === 0) {
      insights = buildFallbackInsights(enriched);
    }

    db.delete(improvementInsights)
      .where(eq(improvementInsights.sourceType, "note"))
      .run();

    const now = new Date().toISOString();
    for (const insight of insights) {
      db.insert(improvementInsights)
        .values({
          id: randomUUID(),
          sourceType: "note",
          sourceId: "note-aggregate",
          insight: insight.insight,
          action: insight.action,
          priority: insight.priority,
          createdAt: now,
        })
        .run();
    }

    return insights;
  }

  async generateNoteImprovements(llm: LlmClient): Promise<string> {
    const insights = await this.analyzeNotePerformance(llm);
    return insights
      .map(
        (insight) =>
          `- [${insight.priority}] ${insight.insight} -> ${insight.action}`,
      )
      .join("\n");
  }

  async connectToThreadsInsights(llm: LlmClient): Promise<string> {
    const threads = db
      .select()
      .from(threadPostResults)
      .orderBy(desc(threadPostResults.publishedAt))
      .limit(10)
      .all();
    const notes = db
      .select()
      .from(notePostResults)
      .orderBy(desc(notePostResults.publishedAt))
      .limit(10)
      .all();

    const prompt = `Threads と note の相関を見て、次の打ち手を1段落で返して。

## Threads
${JSON.stringify(
  threads.map((row) => ({
    publishedAt: row.publishedAt,
    impressions: row.impressions,
    likes: row.likes,
    replies: row.repliesCount,
    shares: row.shares,
  })),
  null,
  2,
)}

## note
${JSON.stringify(
  notes.map((row) => ({
    publishedAt: row.publishedAt,
    views: row.views,
    likes: row.likes,
    comments: row.commentsCount,
  })),
  null,
  2,
)}
`;

    try {
      const raw = await llm.generate(prompt, { temperature: 0.3 });
      return raw.trim();
    } catch (error) {
      logger.warn(
        { error },
        "Failed to generate Threads-note correlation summary",
      );
      const totalThreadLikes = threads.reduce((sum, row) => sum + row.likes, 0);
      const totalNoteViews = notes.reduce((sum, row) => sum + row.views, 0);
      return `Threadsの反応合計は${totalThreadLikes}で、noteの閲覧合計は${totalNoteViews}。勝ちThreadsのテーマを先にnoteへ寄せて、反応の大きい導線をそのまま転用する。`;
    }
  }
}
