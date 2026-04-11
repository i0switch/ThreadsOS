import { randomUUID } from "node:crypto";
import { and, desc, eq, gte } from "drizzle-orm";
import type { LlmClient } from "../../adapters/llm/index.js";
import { logger } from "../../app/logger.js";
import { db } from "../../db/index.js";
import {
  contentSlots,
  notePostResults,
  optimizationDecisions,
  threadPostResults,
} from "../../db/schema.js";
import { parseJsonObject } from "../../utils/llm-json.js";

const JST_TIME_ZONE = "Asia/Tokyo";
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const WEEKDAY_TO_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export interface TimeSlot {
  dayOfWeek: number;
  hour: number;
  avgEngagementRate: number;
}

type CadenceChannel = "threads" | "note";

export interface CadenceOptimizerService {
  analyzeOptimalTimes(channel?: string): Promise<TimeSlot[]>;
  adjustFrequency(llm: LlmClient, channel?: CadenceChannel): Promise<string>;
  generateSchedule(channel: string, days: number): Promise<void>;
  analyzeAndUpdate(llm: LlmClient, channel?: CadenceChannel): Promise<void>;
}

const DEFAULT_FREQUENCY_RECOMMENDATIONS: Record<
  CadenceChannel,
  {
    recommendedPostsPerDay: number;
    minIntervalHours: number;
    reasoning: string;
  }
> = {
  threads: {
    recommendedPostsPerDay: 3,
    minIntervalHours: 8,
    reasoning: "データが少ないため安全側の既定値を採用",
  },
  note: {
    recommendedPostsPerDay: 1,
    minIntervalHours: 24,
    reasoning: "note実績が少ないため、1日1本ペースを既定値にする",
  },
};

function getJstWeekdayHour(date: Date): { dayOfWeek: number; hour: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: JST_TIME_ZONE,
    weekday: "short",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "Sun";
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  return {
    dayOfWeek: WEEKDAY_TO_INDEX[weekday] ?? 0,
    hour,
  };
}

function getJstDayStart(base = new Date()): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: JST_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(base);
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return new Date(`${year}-${month}-${day}T00:00:00+09:00`);
}

function buildCandidateScheduleTimes(
  topSlots: TimeSlot[],
  days: number,
  base = new Date(),
): Date[] {
  const dayStart = getJstDayStart(base);
  const candidates: Date[] = [];

  for (let dayOffset = 0; dayOffset < days; dayOffset += 1) {
    const jstDay = new Date(dayStart.getTime() + dayOffset * DAY_MS);
    const { dayOfWeek } = getJstWeekdayHour(jstDay);

    for (const slot of topSlots) {
      if (slot.dayOfWeek !== dayOfWeek) {
        continue;
      }

      const scheduledAt = new Date(jstDay.getTime() + slot.hour * HOUR_MS);
      if (scheduledAt.getTime() <= base.getTime()) {
        continue;
      }
      candidates.push(scheduledAt);
    }
  }

  candidates.sort((left, right) => left.getTime() - right.getTime());
  return candidates;
}

export class CadenceOptimizerServiceImpl implements CadenceOptimizerService {
  async analyzeOptimalTimes(channel = "threads"): Promise<TimeSlot[]> {
    const results =
      channel === "note"
        ? db.select().from(notePostResults).all().map((result) => ({
            publishedAt: result.publishedAt,
            impressions: result.views,
            likes: result.likes,
            repliesCount: result.commentsCount,
            shares:
              result.purchasesCount * 5 +
              Math.max(0, Math.floor(result.revenueYen / 100)),
          }))
        : db.select().from(threadPostResults).all();
    const slots = new Map<string, { total: number; engagement: number }>();

    for (const result of results) {
      const publishedAt = new Date(result.publishedAt);
      if (Number.isNaN(publishedAt.getTime())) {
        continue;
      }

      const { dayOfWeek, hour } = getJstWeekdayHour(publishedAt);
      const key = `${dayOfWeek}-${hour}`;
      const current = slots.get(key) ?? { total: 0, engagement: 0 };
      current.total += Math.max(1, result.impressions);
      current.engagement += result.likes + result.repliesCount + result.shares;
      slots.set(key, current);
    }

    const timeSlots: TimeSlot[] = [];
    for (const [key, value] of slots) {
      const [dayOfWeek, hour] = key.split("-").map(Number);
      timeSlots.push({
        dayOfWeek,
        hour,
        avgEngagementRate: value.engagement / value.total,
      });
    }

    timeSlots.sort((a, b) => b.avgEngagementRate - a.avgEngagementRate);
    return timeSlots;
  }

  async adjustFrequency(
    llm: LlmClient,
    channel: CadenceChannel = "threads",
  ): Promise<string> {
    const fallback = DEFAULT_FREQUENCY_RECOMMENDATIONS[channel];

    const resultLines =
      channel === "note"
        ? (() => {
            const noteResults = db
              .select()
              .from(notePostResults)
              .orderBy(desc(notePostResults.createdAt))
              .limit(30)
              .all();

            if (noteResults.length === 0) {
              return null;
            }

            return noteResults
              .map(
                (result) =>
                  `${result.publishedAt}: views=${result.views}, likes=${result.likes}, comments=${result.commentsCount}, purchases=${result.purchasesCount}, revenue=${result.revenueYen}, cv=${result.conversionRate}`,
              )
              .join("\n");
          })()
        : (() => {
            const threadResults = db
              .select()
              .from(threadPostResults)
              .orderBy(desc(threadPostResults.createdAt))
              .limit(30)
              .all();

            if (threadResults.length === 0) {
              return null;
            }

            return threadResults
              .map(
                (result) =>
                  `${result.publishedAt}: imp=${result.impressions}, likes=${result.likes}, replies=${result.repliesCount}`,
              )
              .join("\n");
          })();

    if (!resultLines) {
      return JSON.stringify(fallback);
    }

    const prompt =
      channel === "note"
        ? `以下の直近30本のnote公開データから、最適な公開頻度を分析してください。

${resultLines}

以下の形式で回答:
{
  "recommendedPostsPerDay": 数値,
  "minIntervalHours": 数値,
  "reasoning": "理由"
}`
        : `以下の直近30投稿のデータから、最適な投稿頻度を分析してください。

${resultLines}

以下の形式で回答:
{
  "recommendedPostsPerDay": 数値,
  "minIntervalHours": 数値,
  "reasoning": "理由"
}`;

    try {
      const raw = await llm.generate(prompt, {
        temperature: 0.3,
        tier: "premium",
      });
      const parsed =
        parseJsonObject<Partial<typeof fallback>>(raw);
      if (!parsed) {
        return JSON.stringify(fallback);
      }

      const recommendedPostsPerDay = Number(parsed.recommendedPostsPerDay);
      const minIntervalHours = Number(parsed.minIntervalHours);

      if (
        !Number.isFinite(recommendedPostsPerDay) ||
        !Number.isFinite(minIntervalHours)
      ) {
        return JSON.stringify(fallback);
      }

      return JSON.stringify({
        recommendedPostsPerDay: Math.max(
          1,
          Math.min(10, recommendedPostsPerDay),
        ),
        minIntervalHours: Math.max(1, Math.min(24, minIntervalHours)),
        reasoning: parsed.reasoning?.toString() ?? fallback.reasoning,
      });
    } catch (error) {
      logger.warn(
        { channel, error },
        "Failed to adjust posting frequency, using fallback",
      );
      return JSON.stringify(fallback);
    }
  }

  async generateSchedule(channel: string, days: number): Promise<void> {
    const now = new Date();
    const nowIso = now.toISOString();
    const optimalTimes = await this.analyzeOptimalTimes(channel);
    const topSlots = optimalTimes.slice(0, 5);

    if (topSlots.length === 0) {
      logger.info(
        { channel, days },
        "No optimal times found, schedule not generated",
      );
      return;
    }

    const futurePendingSlots = db
      .select()
      .from(contentSlots)
      .where(
        and(
          eq(contentSlots.channel, channel),
          eq(contentSlots.status, "pending"),
          gte(contentSlots.scheduledAt, nowIso),
        ),
      )
      .all();

    for (const slot of futurePendingSlots) {
      if (slot.draftId) {
        continue;
      }
      db.delete(contentSlots).where(eq(contentSlots.id, slot.id)).run();
    }

    const draftBoundSlots = futurePendingSlots
      .filter((slot) => Boolean(slot.draftId))
      .sort((left, right) => {
        if (left.priority !== right.priority) {
          return right.priority - left.priority;
        }
        return left.scheduledAt.localeCompare(right.scheduledAt);
      });

    if (draftBoundSlots.length === 0) {
      db.insert(optimizationDecisions)
        .values({
          id: randomUUID(),
          channel,
          decisionType: "timing",
          beforeValue: JSON.stringify({
            draftBoundSlots: 0,
            generatedDays: days,
          }),
          afterValue: JSON.stringify({ slotsUpdated: 0 }),
          reason: "No draft-bound pending slots to reschedule",
          changePercent: null,
          approvedBy: "auto",
          createdAt: nowIso,
        })
        .run();
      logger.info(
        { channel, days },
        "No draft-bound pending slots, skipped schedule rewrite",
      );
      return;
    }

    const candidateTimes = buildCandidateScheduleTimes(topSlots, days, now);
    if (candidateTimes.length === 0) {
      logger.info(
        { channel, days },
        "No future candidate slots found, schedule not generated",
      );
      return;
    }

    let updated = 0;
    for (const [index, slot] of draftBoundSlots.entries()) {
      const candidate = candidateTimes[index];
      if (!candidate) {
        break;
      }

      db.update(contentSlots)
        .set({
          scheduledAt: candidate.toISOString(),
          updatedAt: nowIso,
        })
        .where(eq(contentSlots.id, slot.id))
        .run();
      updated++;
    }

    db.insert(optimizationDecisions)
      .values({
        id: randomUUID(),
        channel,
        decisionType: "timing",
        beforeValue: JSON.stringify({
          draftBoundSlots: draftBoundSlots.length,
          generatedDays: days,
        }),
        afterValue: JSON.stringify({ slotsUpdated: updated }),
        reason: "Rescheduled draft-bound slots from recent JST engagement data",
        changePercent: null,
        approvedBy: "auto",
        createdAt: nowIso,
      })
      .run();

    logger.info(
      { channel, days, slotsUpdated: updated },
      "Posting schedule generated",
    );
  }

  async analyzeAndUpdate(
    llm: LlmClient,
    channel: CadenceChannel = "threads",
  ): Promise<void> {
    const frequencyRecommendation = await this.adjustFrequency(llm, channel);
    await this.generateSchedule(channel, 7);

    db.insert(optimizationDecisions)
      .values({
        id: randomUUID(),
        channel,
        decisionType: "frequency",
        beforeValue: JSON.stringify({ source: "recent_posts" }),
        afterValue: frequencyRecommendation,
        reason: "Adjusted by cadence optimizer",
        changePercent: null,
        approvedBy: "auto",
        createdAt: new Date().toISOString(),
      })
      .run();

    logger.info(
      { channel, frequencyRecommendation },
      "Cadence optimizer updated schedule",
    );
  }
}
