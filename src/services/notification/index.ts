import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import {
  createNotifier,
  type NotifierClient,
} from "../../adapters/notifier/index.js";
import type { StorageClient } from "../../adapters/storage/index.js";
import { logger } from "../../app/logger.js";
import { type Env, loadEnv } from "../../config/env.js";
import { db } from "../../db/index.js";
import {
  contentSlots,
  humanReviewItems,
  improvementInsights,
  notePostResults,
  outboundNotifications,
  replyDecisions,
  scheduledJobRuns,
  threadPostResults,
  thumbnailTasks,
} from "../../db/schema.js";

export interface ProgressReport {
  timestamp: string;
  todayStats: {
    heartbeatRuns: number;
    threadsPosted: number;
    notesPublished: number;
    repliesSent: number;
    totalImpressions: number;
    totalLikes: number;
    totalReplies: number;
    pendingReviews: number;
  };
  recentPosts: Array<{
    channel: "threads" | "note";
    titleOrBody: string;
    impressions?: number;
    views?: number;
  }>;
  upcomingSchedule: Array<{
    channel: string;
    scheduledAt: string;
    status: string;
  }>;
  actionItems: string[];
  improvements: string[];
}

export interface NotificationPayload {
  type: "progress" | "action_needed" | "alert";
  message?: string;
  report?: ProgressReport;
}

export interface NotificationService {
  generateProgressReport(): Promise<ProgressReport>;
  sendNotification(payload: NotificationPayload): Promise<void>;
}

function formatJstDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function toJstDateKey(iso: string): string {
  return formatJstDate(new Date(iso));
}

export class NotificationServiceImpl implements NotificationService {
  private readonly storage: StorageClient | null;
  private readonly notifier: NotifierClient;
  private readonly env: Env;

  constructor(
    storage?: StorageClient,
    notifier?: NotifierClient,
    env = loadEnv(),
  ) {
    this.storage = storage ?? null;
    this.env = env;
    this.notifier =
      notifier ??
      createNotifier({
        discordWebhookUrl: env.NOTIFICATION_DISCORD_WEBHOOK,
        fileDir: "docs/notifications",
      });
  }

  async generateProgressReport(): Promise<ProgressReport> {
    const now = new Date();
    const todayKey = formatJstDate(now);

    const threadResults = db.select().from(threadPostResults).all();
    const noteResults = db.select().from(notePostResults).all();
    const reviews = db
      .select()
      .from(humanReviewItems)
      .where(eq(humanReviewItems.status, "pending"))
      .all();
    const thumbnails = db
      .select()
      .from(thumbnailTasks)
      .where(eq(thumbnailTasks.status, "pending"))
      .all();
    const heartbeatRuns = db
      .select()
      .from(scheduledJobRuns)
      .all()
      .filter(
        (run) =>
          run.jobName === "hourly-heartbeat" &&
          toJstDateKey(run.startedAt) === todayKey,
      );
    const upcoming = db
      .select()
      .from(contentSlots)
      .where(eq(contentSlots.status, "pending"))
      .orderBy(contentSlots.scheduledAt)
      .limit(5)
      .all();

    const todayThreads = threadResults.filter(
      (result) => toJstDateKey(result.publishedAt) === todayKey,
    );
    const todayNotes = noteResults.filter(
      (result) => toJstDateKey(result.publishedAt) === todayKey,
    );
    const sentReplies = db
      .select()
      .from(replyDecisions)
      .where(eq(replyDecisions.decision, "safe_auto_reply"))
      .all()
      .filter(
        (decision) => decision.sentAt !== null && decision.sentAt !== undefined,
      )
      .filter((decision) => toJstDateKey(String(decision.sentAt)) === todayKey);

    const recentPosts = [
      ...todayThreads.slice(0, 3).map((result) => ({
        channel: "threads" as const,
        titleOrBody: result.draftId,
        impressions: result.impressions,
      })),
      ...todayNotes.slice(0, 2).map((result) => ({
        channel: "note" as const,
        titleOrBody: result.draftId,
        views: result.views ?? 0,
      })),
    ];
    const latestImprovements = db
      .select()
      .from(improvementInsights)
      .orderBy(desc(improvementInsights.createdAt))
      .limit(3)
      .all();
    const actionItems = [
      ...thumbnails
        .slice(0, 3)
        .map((task) => `noteサムネ対応: ${task.noteDraftId}`),
      ...reviews
        .slice(0, 3)
        .map((item) => `${item.itemType} レビュー待ち: ${item.itemId}`),
    ];

    return {
      timestamp: now.toISOString(),
      todayStats: {
        heartbeatRuns: heartbeatRuns.length,
        threadsPosted: todayThreads.length,
        notesPublished: todayNotes.length,
        repliesSent: sentReplies.length,
        totalImpressions: todayThreads.reduce(
          (sum, result) => sum + result.impressions,
          0,
        ),
        totalLikes: todayThreads.reduce((sum, result) => sum + result.likes, 0),
        totalReplies: todayThreads.reduce(
          (sum, result) => sum + result.repliesCount,
          0,
        ),
        pendingReviews: reviews.length,
      },
      recentPosts,
      upcomingSchedule: upcoming.map((slot) => ({
        channel: slot.channel,
        scheduledAt: slot.scheduledAt,
        status: slot.status,
      })),
      actionItems,
      improvements: latestImprovements.map(
        (item) => `[${item.sourceType}] ${item.action}`,
      ),
    };
  }

  async sendNotification(payload: NotificationPayload): Promise<void> {
    const now = new Date();
    const sentAt = now.toISOString();
    const content =
      payload.type === "progress" && payload.report
        ? [
            `## 進捗レポート ${payload.report.timestamp}`,
            "",
            `- heartbeat実行: ${payload.report.todayStats.heartbeatRuns}回`,
            `- Threads投稿: ${payload.report.todayStats.threadsPosted}本`,
            `- note投稿: ${payload.report.todayStats.notesPublished}本`,
            `- 返信送信: ${payload.report.todayStats.repliesSent}件`,
            `- インプレッション: ${payload.report.todayStats.totalImpressions}`,
            `- いいね: ${payload.report.todayStats.totalLikes}`,
            `- 返信: ${payload.report.todayStats.totalReplies}`,
            `- レビュー待ち: ${payload.report.todayStats.pendingReviews}件`,
            "",
            "### 直近投稿",
            ...payload.report.recentPosts.map((post) =>
              post.channel === "threads"
                ? `- Threads: ${post.titleOrBody} / imp=${post.impressions ?? 0}`
                : `- note: ${post.titleOrBody} / views=${post.views ?? 0}`,
            ),
            "",
            "### 今後のスケジュール",
            ...payload.report.upcomingSchedule.map(
              (slot) =>
                `- ${slot.scheduledAt} / ${slot.channel} / ${slot.status}`,
            ),
            ...(payload.report.actionItems.length > 0
              ? [
                  "",
                  "### 今やること",
                  ...payload.report.actionItems.map((item) => `- ${item}`),
                ]
              : []),
            ...(payload.report.improvements.length > 0
              ? [
                  "",
                  "### 改善メモ",
                  ...payload.report.improvements.map((item) => `- ${item}`),
                ]
              : []),
          ].join("\n")
        : (payload.message ?? "");

    let channel = this.env.NOTIFICATION_DISCORD_WEBHOOK ? "discord" : "file";
    let deliveredAt: string | null = null;
    let error: string | null = null;

    try {
      const result = await this.notifier.send(payload.type, content);
      channel = result.destination === "discord" ? "discord" : "file";
      deliveredAt = new Date().toISOString();
    } catch (primaryError) {
      const primaryMessage =
        primaryError instanceof Error
          ? primaryError.message
          : String(primaryError);
      logger.error(
        { type: payload.type, error: primaryMessage },
        "Primary notification delivery failed",
      );

      try {
        const fallbackNotifier = createNotifier({
          fileDir: "docs/notifications",
        });
        await fallbackNotifier.send(payload.type, content);
        channel = "file";
        deliveredAt = new Date().toISOString();
        error = `primary_failed:${primaryMessage}`;
      } catch (fallbackError) {
        const fallbackMessage =
          fallbackError instanceof Error
            ? fallbackError.message
            : String(fallbackError);
        error = `primary_failed:${primaryMessage}; fallback_failed:${fallbackMessage}`;
      }
    }

    db.insert(outboundNotifications)
      .values({
        id: randomUUID(),
        type: payload.type,
        content,
        channel,
        sentAt,
        deliveredAt,
        error,
      })
      .run();

    if (this.storage && channel === "discord") {
      const fileName = `docs/notifications/${sentAt.replace(/[:.]/g, "-")}.md`;
      await this.storage.saveFile(fileName, content);
    }

    logger.info(
      { type: payload.type, channel, deliveredAt, error },
      "Notification processed",
    );

    if (!deliveredAt) {
      throw new Error(error ?? "通知配信に失敗");
    }
  }
}
