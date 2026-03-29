import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { LlmClient } from "../../adapters/llm/index.js";
import type { ThreadsApiClient } from "../../adapters/threads-api/index.js";
import { logger } from "../../app/logger.js";
import { db } from "../../db/index.js";
import {
  channelPerformanceSnapshots,
  humanReviewItems,
  improvementInsights,
  replyDecisions,
  threadPostDrafts,
  threadPostResults,
  threadReplies,
  topics,
} from "../../db/schema.js";
import type { ImprovementInsight } from "../../domain/analytics/index.js";

type PerformanceBucket = {
  posts: number;
  impressions: number;
  likes: number;
  replies: number;
  shares: number;
};

type PerformanceRow = {
  periodType: "hour" | "weekday" | "theme" | "hook" | "cta";
  periodKey: string;
  metrics: string;
};

type PerformanceSnapshotSummary = {
  rows: PerformanceRow[];
  scheduleInsights: ImprovementInsight[];
  summaryLines: string[];
};

export interface EngagementAnalysisService {
  fetchAndStoreResults(
    draftId: string,
    threadsPostId: string,
    api: ThreadsApiClient,
  ): Promise<void>;
  fetchAndClassifyReplies(
    postResultId: string,
    api: ThreadsApiClient,
    llm: LlmClient,
  ): Promise<void>;
  analyzePostPerformance(
    postResultId: string,
    llm: LlmClient,
  ): Promise<ImprovementInsight[]>;
  generateWeeklyReport(llm: LlmClient): Promise<string>;
}

function createBucket(): PerformanceBucket {
  return {
    posts: 0,
    impressions: 0,
    likes: 0,
    replies: 0,
    shares: 0,
  };
}

function accumulate(
  bucket: PerformanceBucket,
  post: {
    impressions: number;
    likes: number;
    repliesCount: number;
    shares: number;
  },
): void {
  bucket.posts += 1;
  bucket.impressions += post.impressions;
  bucket.likes += post.likes;
  bucket.replies += post.repliesCount;
  bucket.shares += post.shares;
}

function engagementRate(bucket: PerformanceBucket): number {
  if (bucket.impressions <= 0) {
    return 0;
  }

  return (bucket.likes + bucket.replies + bucket.shares) / bucket.impressions;
}

function formatWeekdayLabel(date: Date): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    weekday: "short",
  }).format(date);
}

function formatHourLabel(date: Date): string {
  return `${new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    hour12: false,
  }).format(date)}時`;
}

function summarizeTopBottom(
  label: string,
  ordered: Array<{ key: string; score: number }>,
): string | null {
  const best = ordered[0];
  const worst = ordered.at(-1);
  if (!best || !worst) {
    return null;
  }

  return `${label}: best=${best.key} (${best.score.toFixed(3)}), worst=${worst.key} (${worst.score.toFixed(3)})`;
}

export class EngagementAnalysisServiceImpl
  implements EngagementAnalysisService
{
  private buildScheduleInsights(
    summaryRows: PerformanceSnapshotSummary["rows"],
  ): ImprovementInsight[] {
    const parsedRows = summaryRows.map((row) => ({
      periodType: row.periodType,
      periodKey: row.periodKey,
      metrics: JSON.parse(row.metrics) as PerformanceBucket & {
        engagementRate: number;
      },
    }));

    const pickBestWorst = (periodType: PerformanceRow["periodType"]) => {
      const rows = parsedRows
        .filter((row) => row.periodType === periodType)
        .sort(
          (left, right) =>
            right.metrics.engagementRate - left.metrics.engagementRate,
        );
      const best = rows[0];
      const worst = rows.at(-1);
      return { best, worst };
    };

    const insights: ImprovementInsight[] = [];

    const hourly = pickBestWorst("hour");
    if (
      hourly.best &&
      hourly.worst &&
      hourly.best.periodKey !== hourly.worst.periodKey
    ) {
      insights.push({
        id: randomUUID(),
        sourceType: "retro",
        sourceId: "threads:schedule",
        insight: `時間帯は${hourly.best.periodKey}が強い`,
        action: `${hourly.best.periodKey}にThreads投稿を寄せて、${hourly.worst.periodKey}は実験枠に回す`,
        priority: "high",
      });
    }

    const weekday = pickBestWorst("weekday");
    if (
      weekday.best &&
      weekday.worst &&
      weekday.best.periodKey !== weekday.worst.periodKey
    ) {
      insights.push({
        id: randomUUID(),
        sourceType: "retro",
        sourceId: "threads:schedule",
        insight: `曜日は${weekday.best.periodKey}が強い`,
        action: `${weekday.best.periodKey}の投稿枠を増やし、${weekday.worst.periodKey}は比較検証に使う`,
        priority: "medium",
      });
    }

    const theme = pickBestWorst("theme");
    if (theme.best) {
      insights.push({
        id: randomUUID(),
        sourceType: "retro",
        sourceId: "threads:schedule",
        insight: `テーマは${theme.best.periodKey}が最も反応を取りやすい`,
        action: `次回のThreadsとnoteは${theme.best.periodKey}を優先し、派生テーマを連続で出す`,
        priority: "medium",
      });
    }

    const hook = pickBestWorst("hook");
    if (hook.best) {
      insights.push({
        id: randomUUID(),
        sourceType: "retro",
        sourceId: "threads:schedule",
        insight: `フックは${hook.best.periodKey}が強い`,
        action: `${hook.best.periodKey}系の冒頭をテンプレ化して、弱いフック型は止める`,
        priority: "medium",
      });
    }

    const cta = pickBestWorst("cta");
    if (cta.best) {
      insights.push({
        id: randomUUID(),
        sourceType: "retro",
        sourceId: "threads:schedule",
        insight: `CTAは${cta.best.periodKey}が強い`,
        action: `${cta.best.periodKey}系CTAを標準にして、弱いCTAは次回改善へ回す`,
        priority: "low",
      });
    }

    return insights;
  }

  private refreshThreadSnapshots(): PerformanceSnapshotSummary {
    const posts = db.select().from(threadPostResults).all();
    const drafts = db.select().from(threadPostDrafts).all();
    const topicRows = db.select().from(topics).all();

    const draftMap = new Map(drafts.map((draft) => [draft.id, draft] as const));
    const topicMap = new Map(
      topicRows.map((topic) => [topic.id, topic.name] as const),
    );

    const buckets = {
      hour: new Map<string, PerformanceBucket>(),
      weekday: new Map<string, PerformanceBucket>(),
      theme: new Map<string, PerformanceBucket>(),
      hook: new Map<string, PerformanceBucket>(),
      cta: new Map<string, PerformanceBucket>(),
    };

    for (const post of posts) {
      const publishedAt = new Date(post.publishedAt);
      if (Number.isNaN(publishedAt.getTime())) {
        continue;
      }

      const draft = draftMap.get(post.draftId);
      const themeKey = draft
        ? (topicMap.get(draft.topicId) ?? draft.topicId ?? "unknown")
        : "unknown";
      const hookKey = draft?.hookType ?? "unknown";
      const ctaKey = draft?.ctaType ?? "unknown";

      const labels = [
        {
          map: buckets.hour,
          key: formatHourLabel(publishedAt),
          type: "hour" as const,
        },
        {
          map: buckets.weekday,
          key: formatWeekdayLabel(publishedAt),
          type: "weekday" as const,
        },
        { map: buckets.theme, key: themeKey, type: "theme" as const },
        { map: buckets.hook, key: hookKey, type: "hook" as const },
        { map: buckets.cta, key: ctaKey, type: "cta" as const },
      ];

      for (const item of labels) {
        const bucket = item.map.get(item.key) ?? createBucket();
        accumulate(bucket, post);
        item.map.set(item.key, bucket);
      }
    }

    const snapshotRows: PerformanceRow[] = [];
    const summaryLines: string[] = [];

    const orderedRows = Object.entries(buckets).flatMap(([periodType, map]) => {
      const sorted = Array.from(map.entries())
        .map(([periodKey, bucket]) => ({
          periodType: periodType as PerformanceRow["periodType"],
          periodKey,
          bucket,
          score: engagementRate(bucket),
        }))
        .sort((left, right) => right.score - left.score);

      const summary = summarizeTopBottom(
        periodType,
        sorted.map((row) => ({ key: row.periodKey, score: row.score })),
      );
      if (summary) {
        summaryLines.push(summary);
      }

      return sorted.map(({ periodType: type, periodKey, bucket, score }) => ({
        periodType: type,
        periodKey,
        metrics: JSON.stringify({
          posts: bucket.posts,
          impressions: bucket.impressions,
          likes: bucket.likes,
          replies: bucket.replies,
          shares: bucket.shares,
          engagementRate: score,
        }),
      }));
    });

    db.delete(channelPerformanceSnapshots)
      .where(eq(channelPerformanceSnapshots.channel, "threads"))
      .run();

    for (const row of orderedRows) {
      db.insert(channelPerformanceSnapshots)
        .values({
          id: randomUUID(),
          channel: "threads",
          periodType: row.periodType,
          periodKey: row.periodKey,
          metrics: row.metrics,
          createdAt: new Date().toISOString(),
        })
        .run();
      snapshotRows.push(row);
    }

    db.delete(improvementInsights)
      .where(
        and(
          eq(improvementInsights.sourceType, "retro"),
          eq(improvementInsights.sourceId, "threads:schedule"),
        ),
      )
      .run();

    const scheduleInsights = this.buildScheduleInsights(snapshotRows);
    for (const insight of scheduleInsights) {
      db.insert(improvementInsights)
        .values({
          id: insight.id,
          sourceType: insight.sourceType,
          sourceId: insight.sourceId,
          insight: insight.insight,
          action: insight.action,
          priority: insight.priority,
          createdAt: new Date().toISOString(),
        })
        .run();
    }

    return {
      rows: snapshotRows,
      scheduleInsights,
      summaryLines,
    };
  }

  async fetchAndStoreResults(
    draftId: string,
    threadsPostId: string,
    api: ThreadsApiClient,
  ): Promise<void> {
    const insights = await api.getInsights(threadsPostId);
    const id = randomUUID();
    const now = new Date().toISOString();

    db.insert(threadPostResults)
      .values({
        id,
        draftId,
        threadsPostId,
        impressions: insights.impressions,
        likes: insights.likes,
        repliesCount: insights.replies,
        shares: insights.shares,
        publishedAt: now,
        createdAt: now,
      })
      .run();

    logger.info({ draftId, threadsPostId }, "Post results stored");
  }

  async fetchAndClassifyReplies(
    postResultId: string,
    api: ThreadsApiClient,
    llm: LlmClient,
  ): Promise<void> {
    const postResult = db
      .select()
      .from(threadPostResults)
      .where(eq(threadPostResults.id, postResultId))
      .get();
    if (!postResult) throw new Error(`Post result not found: ${postResultId}`);

    const replies = await api.getReplies(postResult.threadsPostId);
    const now = new Date().toISOString();

    for (const reply of replies) {
      const existingReply = db
        .select()
        .from(threadReplies)
        .where(eq(threadReplies.threadsReplyId, reply.id))
        .get();
      if (existingReply) {
        continue;
      }

      const replyId = randomUUID();

      db.insert(threadReplies)
        .values({
          id: replyId,
          postResultId,
          threadsReplyId: reply.id,
          author: reply.author,
          body: reply.body,
          createdAt: now,
        })
        .run();

      const classificationPrompt = `以下の返信の危険度を判定してください。

返信: "${reply.body}"
投稿者: ${reply.author}

以下のJSON形式で回答:
{
  "decision": "safe_auto_reply" | "human_review" | "ignore",
  "sentiment": "positive" | "negative" | "neutral" | "question",
  "autoReplyBody": "返信文(safe_auto_replyの場合のみ)",
  "reason": "判定理由"
}

判定基準:
- 攻撃的・挑発的 → human_review
- 医療・法律・投資の質問 → human_review
- 好意的な感想 → safe_auto_reply
- 質問 → safe_auto_reply (安全な範囲で)
- スパム → ignore`;

      const raw = await llm.generate(classificationPrompt, {
        temperature: 0.3,
      });
      let classification: {
        decision: string;
        sentiment: string;
        autoReplyBody?: string;
        reason?: string;
      };
      try {
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        classification = jsonMatch
          ? JSON.parse(jsonMatch[0])
          : { decision: "human_review", sentiment: "neutral" };
      } catch {
        classification = { decision: "human_review", sentiment: "neutral" };
      }

      db.update(threadReplies)
        .set({ sentiment: classification.sentiment })
        .where(eq(threadReplies.id, replyId))
        .run();

      db.insert(replyDecisions)
        .values({
          id: randomUUID(),
          replyId,
          decision: classification.decision,
          autoReplyBody:
            classification.decision === "safe_auto_reply"
              ? classification.autoReplyBody
              : null,
          createdAt: now,
        })
        .run();

      if (classification.decision === "human_review") {
        const existingReviewItem = db
          .select()
          .from(humanReviewItems)
          .where(
            and(
              eq(humanReviewItems.itemType, "thread_reply"),
              eq(humanReviewItems.itemId, replyId),
            ),
          )
          .get();

        if (existingReviewItem) {
          db.update(humanReviewItems)
            .set({
              reason:
                classification.reason ??
                "LLM classified as requiring human review",
              status: "pending",
              reviewedAt: null,
              reviewerNote: null,
              createdAt: now,
            })
            .where(eq(humanReviewItems.id, existingReviewItem.id))
            .run();
        } else {
          db.insert(humanReviewItems)
            .values({
              id: randomUUID(),
              itemType: "thread_reply",
              itemId: replyId,
              reason:
                classification.reason ??
                "LLM classified as requiring human review",
              status: "pending",
              createdAt: now,
            })
            .run();
        }
      }
    }

    logger.info(
      { postResultId, replyCount: replies.length },
      "Replies fetched and classified",
    );
  }

  async analyzePostPerformance(
    postResultId: string,
    llm: LlmClient,
  ): Promise<ImprovementInsight[]> {
    const postResult = db
      .select()
      .from(threadPostResults)
      .where(eq(threadPostResults.id, postResultId))
      .get();
    if (!postResult) return [];

    const prompt = `以下の投稿パフォーマンスを分析し、改善案を出してください。

## データ
- インプレッション: ${postResult.impressions}
- いいね: ${postResult.likes}
- 返信数: ${postResult.repliesCount}
- シェア: ${postResult.shares}

## 回答形式 (JSON配列)
[
  {
    "insight": "発見・気づき",
    "action": "次回の投稿時間/テーマ/フック/CTAに反映できる具体的な改善アクション",
    "priority": "high" | "medium" | "low"
  }
]

action は「何をどう変えるか」がすぐ分かる粒度で返してください。`;

    const raw = await llm.generate(prompt, { temperature: 0.5 });
    let parsed: Array<{ insight: string; action: string; priority: string }>;
    try {
      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    } catch {
      parsed = [];
    }

    db.delete(improvementInsights)
      .where(
        and(
          eq(improvementInsights.sourceType, "thread_post"),
          eq(improvementInsights.sourceId, postResultId),
        ),
      )
      .run();

    const insights: ImprovementInsight[] = [];
    const now = new Date().toISOString();

    for (const p of parsed) {
      const id = randomUUID();
      db.insert(improvementInsights)
        .values({
          id,
          sourceType: "thread_post",
          sourceId: postResultId,
          insight: p.insight,
          action: p.action,
          priority: p.priority,
          createdAt: now,
        })
        .run();
      insights.push({
        id,
        sourceType: "thread_post",
        sourceId: postResultId,
        insight: p.insight,
        action: p.action,
        priority: p.priority as ImprovementInsight["priority"],
      });
    }

    const refreshed = this.refreshThreadSnapshots();
    insights.push(...refreshed.scheduleInsights);

    logger.info(
      { postResultId, snapshotCount: refreshed.rows.length },
      "Thread performance snapshots refreshed",
    );

    return insights;
  }

  async generateWeeklyReport(llm: LlmClient): Promise<string> {
    const results = db.select().from(threadPostResults).all();
    const refreshed = this.refreshThreadSnapshots();

    const totalImpressions = results.reduce(
      (sum, row) => sum + row.impressions,
      0,
    );
    const totalLikes = results.reduce((sum, row) => sum + row.likes, 0);
    const totalReplies = results.reduce(
      (sum, row) => sum + row.repliesCount,
      0,
    );

    const prompt = `以下の週間データから振り返りレポートを作成してください。

投稿数: ${results.length}
合計インプレッション: ${totalImpressions}
合計いいね: ${totalLikes}
合計返信: ${totalReplies}

## スケジュール改善メモ
${refreshed.summaryLines.map((line) => `- ${line}`).join("\n")}

レポートには以下を含めてください:
1. 概要
2. 勝ちパターン
3. 改善点
4. 来週の実験案
5. 投稿時間・テーマ・フック・CTAの改善方針`;

    return llm.generate(prompt, { temperature: 0.6 });
  }
}
