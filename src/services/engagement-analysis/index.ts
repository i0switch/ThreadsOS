import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { LlmClient } from "../../adapters/llm/index.js";
import type { ThreadsApiClient } from "../../adapters/threads-api/index.js";
import { logger } from "../../app/logger.js";
import { db } from "../../db/index.js";
import {
  anomalyEvents,
  channelPerformanceSnapshots,
  improvementInsights,
  replyDecisions,
  strategyStates,
  threadPostDrafts,
  threadPostResults,
  threadReplies,
  topics,
} from "../../db/schema.js";
import type { ImprovementInsight } from "../../domain/analytics/index.js";
import { parseJsonArray } from "../../utils/llm-json.js";

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
  refreshPostMetrics(
    postResultId: string,
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
  measureReplyEffectiveness(
    postResultId: string,
    api: ThreadsApiClient,
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

function safeParseMetrics(
  raw: string,
): PerformanceBucket & { engagementRate?: number } {
  try {
    return JSON.parse(raw) as PerformanceBucket & { engagementRate?: number };
  } catch {
    return { ...createBucket(), engagementRate: 0 };
  }
}

export class EngagementAnalysisServiceImpl
  implements EngagementAnalysisService
{
  private buildReplyEffectivenessContext(
    postResultId: string,
    latestInsights: ImprovementInsight[] = [],
  ): string {
    const rows =
      latestInsights.length > 0
        ? latestInsights
        : db
            .select()
            .from(improvementInsights)
            .where(
              and(
                eq(improvementInsights.sourceType, "reply_effect"),
                eq(improvementInsights.sourceId, postResultId),
              ),
            )
            .orderBy(desc(improvementInsights.createdAt))
            .limit(3)
            .all()
            .map((row) => ({
              id: row.id,
              sourceType: row.sourceType as ImprovementInsight["sourceType"],
              sourceId: row.sourceId,
              insight: row.insight,
              action: row.action,
              priority: row.priority as ImprovementInsight["priority"],
            }));

    if (rows.length === 0) {
      return "";
    }

    return rows
      .map((row) => `- [${row.priority}] ${row.insight} -> ${row.action}`)
      .join("\n");
  }

  private buildScheduleInsights(
    summaryRows: PerformanceSnapshotSummary["rows"],
  ): ImprovementInsight[] {
    const parsedRows = summaryRows.map((row) => ({
      periodType: row.periodType,
      periodKey: row.periodKey,
      metrics: safeParseMetrics(row.metrics),
    }));

    const pickBestWorst = (periodType: PerformanceRow["periodType"]) => {
      const rows = parsedRows
        .filter((row) => row.periodType === periodType)
        .sort(
          (left, right) =>
            (right.metrics.engagementRate ?? 0) -
            (left.metrics.engagementRate ?? 0),
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
    let insights: Awaited<ReturnType<ThreadsApiClient["getInsights"]>>;
    try {
      insights = await api.getInsights(threadsPostId);
    } catch (error) {
      logger.warn(
        {
          draftId,
          threadsPostId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to fetch initial Threads insights, storing zeroed metrics",
      );
      insights = {
        impressions: 0,
        likes: 0,
        replies: 0,
        shares: 0,
        views: 0,
      };
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const draft = db
      .select()
      .from(threadPostDrafts)
      .where(eq(threadPostDrafts.id, draftId))
      .get();

    db.insert(threadPostResults)
      .values({
        id,
        draftId,
        threadsPostId,
        campaignId: draft?.campaignId ?? null,
        angleId: draft?.angleId ?? null,
        ctaId: draft?.ctaId ?? null,
        canaryGroup: draft?.canaryGroup ?? null,
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

  async refreshPostMetrics(
    postResultId: string,
    api: ThreadsApiClient,
  ): Promise<void> {
    const postResult = db
      .select()
      .from(threadPostResults)
      .where(eq(threadPostResults.id, postResultId))
      .get();
    if (!postResult) {
      logger.warn({ postResultId }, "Post result not found for metric refresh");
      return;
    }

    let insights: Awaited<ReturnType<ThreadsApiClient["getInsights"]>>;
    try {
      insights = await api.getInsights(postResult.threadsPostId);
    } catch (error) {
      logger.warn(
        {
          postResultId,
          threadsPostId: postResult.threadsPostId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to refresh Threads insights, keeping previous metrics",
      );
      return;
    }

    if (!insights) {
      logger.warn(
        { postResultId },
        "getInsights returned undefined, skipping metrics update",
      );
      return;
    }

    const draft = db
      .select()
      .from(threadPostDrafts)
      .where(eq(threadPostDrafts.id, postResult.draftId))
      .get();

    db.update(threadPostResults)
      .set({
        campaignId: postResult.campaignId ?? draft?.campaignId ?? null,
        angleId: postResult.angleId ?? draft?.angleId ?? null,
        ctaId: postResult.ctaId ?? draft?.ctaId ?? null,
        canaryGroup: postResult.canaryGroup ?? draft?.canaryGroup ?? null,
        impressions: insights.impressions,
        likes: insights.likes,
        repliesCount: insights.replies,
        shares: insights.shares,
      })
      .where(eq(threadPostResults.id, postResultId))
      .run();

    logger.info(
      {
        postResultId,
        impressions: insights.impressions,
        likes: insights.likes,
        replies: insights.replies,
        shares: insights.shares,
      },
      "Post metrics refreshed from Threads API",
    );
  }

  async measureReplyEffectiveness(
    postResultId: string,
    api: ThreadsApiClient,
  ): Promise<ImprovementInsight[]> {
    const postResult = db
      .select()
      .from(threadPostResults)
      .where(eq(threadPostResults.id, postResultId))
      .get();
    if (!postResult) {
      return [];
    }

    const replies = db
      .select()
      .from(threadReplies)
      .where(eq(threadReplies.postResultId, postResultId))
      .all();
    const replyIds = new Set(replies.map((reply) => reply.id));
    const sentDecisions = db
      .select()
      .from(replyDecisions)
      .where(eq(replyDecisions.decision, "safe_auto_reply"))
      .all()
      .filter(
        (decision) => !!decision.sentAt && replyIds.has(decision.replyId),
      );

    if (sentDecisions.length === 0) {
      return [];
    }

    let currentMetrics = {
      impressions: postResult.impressions,
      likes: postResult.likes,
      replies: postResult.repliesCount,
      shares: postResult.shares,
      views: postResult.impressions,
    };

    try {
      currentMetrics = await api.getInsights(postResult.threadsPostId);
    } catch (error) {
      logger.warn(
        {
          postResultId,
          threadsPostId: postResult.threadsPostId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to refresh metrics for reply effectiveness, using stored values",
      );
    }

    const repliedRows = replies.filter((reply) =>
      sentDecisions.some((decision) => decision.replyId === reply.id),
    );
    const positiveCount = repliedRows.filter(
      (reply) => reply.sentiment === "positive",
    ).length;
    const questionCount = repliedRows.filter(
      (reply) => reply.sentiment === "question",
    ).length;
    const negativeCount = repliedRows.filter(
      (reply) => reply.sentiment === "negative",
    ).length;
    const engagementRate =
      (currentMetrics.likes + currentMetrics.replies + currentMetrics.shares) /
      Math.max(currentMetrics.impressions, 1);

    const insights: ImprovementInsight[] = [
      {
        id: randomUUID(),
        sourceType: "reply_effect",
        sourceId: postResultId,
        insight: `safe_auto_replyを${sentDecisions.length}件送信した投稿の反応率は${engagementRate.toFixed(3)}`,
        action:
          engagementRate >= 0.08
            ? "質問返信と共感返信を優先し、会話が続いた型を次回の自動返信基準に残す"
            : "返信文を短くし、相手の意図を一言で返してから次の一問を置く",
        priority: engagementRate >= 0.08 ? "medium" : "high",
      },
      {
        id: randomUUID(),
        sourceType: "reply_effect",
        sourceId: postResultId,
        insight: `返信相手の内訳は質問${questionCount}件・好意${positiveCount}件・ネガティブ${negativeCount}件`,
        action:
          questionCount > 0
            ? "質問系リプライには追加の具体例で返すテンプレを優先する"
            : "感謝と要点の再提示を軸にした短文返信を優先する",
        priority: questionCount > 0 ? "high" : "medium",
      },
    ];

    db.delete(improvementInsights)
      .where(
        and(
          eq(improvementInsights.sourceType, "reply_effect"),
          eq(improvementInsights.sourceId, postResultId),
        ),
      )
      .run();

    const now = new Date().toISOString();
    for (const insight of insights) {
      db.insert(improvementInsights)
        .values({
          id: insight.id,
          sourceType: insight.sourceType,
          sourceId: insight.sourceId,
          insight: insight.insight,
          action: insight.action,
          priority: insight.priority,
          createdAt: now,
        })
        .run();
    }

    return insights;
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

    const replyEffectiveness = await this.measureReplyEffectiveness(
      postResultId,
      api,
    );
    const replyEffectivenessContext = this.buildReplyEffectivenessContext(
      postResultId,
      replyEffectiveness,
    );
    const replies = await api.getReplies(postResult.threadsPostId);
    const now = new Date().toISOString();

    // ── エグゼクティブの返信ポリシーを一度だけ取得（バッチ全件で共有）──
    const strategyRow = db
      .select()
      .from(strategyStates)
      .where(eq(strategyStates.key, "heartbeat:global"))
      .get();
    let replyPolicyContext = "";
    let toneContext = "";
    if (strategyRow) {
      try {
        const state = JSON.parse(strategyRow.stateJson);
        if (state.policies?.brand?.tone) {
          toneContext = `\n返信トーン: ${state.policies.brand.tone}`;
        }
        if (state.policies?.brand?.topicsToAvoid?.length > 0) {
          toneContext += `\n避けるべき話題: ${state.policies.brand.topicsToAvoid.join(", ")}`;
        }
      } catch {
        // parse failure, skip
      }
      if (strategyRow.summary) {
        replyPolicyContext = `\n## 現在の運用方針\n${strategyRow.summary}`;
      }
    }

    // ── 新規返信のみ抽出して threadReplies にinsert ──
    type NewReply = { replyId: string; reply: (typeof replies)[number] };
    const newReplies: NewReply[] = [];
    for (const reply of replies) {
      const existingReply = db
        .select()
        .from(threadReplies)
        .where(eq(threadReplies.threadsReplyId, reply.id))
        .get();
      if (existingReply) continue;

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
      newReplies.push({ replyId, reply });
    }

    if (newReplies.length === 0) {
      logger.info(
        { postResultId, replyCount: replies.length },
        "Replies fetched, no new items to classify",
      );
      return;
    }

    type ReplyClassification = {
      threadsReplyId: string;
      decision: string;
      sentiment: string;
      autoReplyBody?: string;
      reason?: string;
    };

    const classifyBatch = async (
      batch: NewReply[],
    ): Promise<Map<string, ReplyClassification>> => {
      const listSection = batch
        .map(
          (item, i) =>
            `${i + 1}. threadsReplyId="${item.reply.id}" author="${item.reply.author}" body="${item.reply.body.replace(/"/g, "'")}"`,
        )
        .join("\n");

      const batchPrompt = `以下の${batch.length}件の返信を一括で危険度判定してください。

${replyEffectivenessContext ? `## 直近の返信効果\n${replyEffectivenessContext}\n\n` : ""}${replyPolicyContext ? `${replyPolicyContext}\n\n` : ""}${toneContext ? `${toneContext}\n\n` : ""}## 返信一覧
${listSection}

## 回答形式 (JSON配列)
[
  {
    "threadsReplyId": "入力に対応するthreadsReplyId",
    "decision": "safe_auto_reply" | "quarantine" | "ignore",
    "sentiment": "positive" | "negative" | "neutral" | "question",
    "autoReplyBody": "返信文(safe_auto_replyの場合のみ)",
    "reason": "判定理由"
  }
]

判定基準:
- 攻撃的・挑発的 → quarantine
- 医療・法律・投資の質問 → quarantine
- 好意的な感想 → safe_auto_reply
- 質問 → safe_auto_reply (安全な範囲で)
- スパム → ignore
- ブランドポリシーに反する内容 → quarantine

必ず${batch.length}件全てに対して判定結果を返してください。JSON配列のみ、前置き・コードブロックなし。`;

      let raw = await llm.generate(batchPrompt, {
        label: "engagement-reply-classification-batch",
        temperature: 0.3,
        tier: "fast",
      });
      let arr = parseJsonArray<ReplyClassification>(raw);

      if (!arr || arr.length === 0) {
        logger.warn(
          { batchSize: batch.length },
          "Reply batch classification parse failed, retrying once",
        );
        raw = await llm.generate(batchPrompt, {
          label: "engagement-reply-classification-batch-retry",
          temperature: 0.2,
          tier: "fast",
        });
        arr = parseJsonArray<ReplyClassification>(raw);
      }

      const map = new Map<string, ReplyClassification>();
      if (arr) {
        for (const item of arr) {
          if (item?.threadsReplyId) {
            map.set(item.threadsReplyId, item);
          }
        }
      }
      return map;
    };

    const BATCH_SIZE = 5;
    for (let i = 0; i < newReplies.length; i += BATCH_SIZE) {
      const batch = newReplies.slice(i, i + BATCH_SIZE);
      const results = await classifyBatch(batch);

      for (const { replyId, reply } of batch) {
        let classification = results.get(reply.id);
        if (!classification) {
          logger.warn(
            { replyId, threadsReplyId: reply.id },
            "Reply classification missing from batch result, defaulting to ignore",
          );
          classification = {
            threadsReplyId: reply.id,
            decision: "ignore",
            sentiment: "neutral",
          };
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
                ? (classification.autoReplyBody ?? null)
                : null,
            createdAt: now,
          })
          .run();

        if (classification.decision === "quarantine") {
          db.insert(anomalyEvents)
            .values({
              id: randomUUID(),
              category: "reply_quarantine",
              severity: "medium",
              message:
                classification.reason ?? "Reply quarantined by classifier",
              metadataJson: JSON.stringify({
                replyId,
                threadsReplyId: reply.id,
                author: reply.author,
              }),
              detectedAt: now,
              createdAt: now,
            })
            .run();
        }
      }
    }

    logger.info(
      {
        postResultId,
        replyCount: replies.length,
        newCount: newReplies.length,
      },
      "Replies fetched and classified (batched)",
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

    const raw = await llm.generate(prompt, {
      label: "engagement-post-insight-generation",
      temperature: 0.5,
      tier: "premium",
    });
    const parsed =
      parseJsonArray<{ insight: string; action: string; priority: string }>(
        raw,
      ) ?? [];

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

    return llm.generate(prompt, {
      temperature: 0.6,
      tier: "standard",
      label: "engagement-weekly-report",
    });
  }
}
