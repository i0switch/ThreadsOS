import { z } from "zod";
import { ExternalApiError } from "../../app/errors.js";
import { logger } from "../../app/logger.js";
import { loadEnv } from "../../config/env.js";
import { waitForRateLimit } from "../../utils/network-policy.js";

const THREADS_API_BASE = "https://graph.threads.net/v1.0";

export interface ThreadsApiClient {
  createContainer(userId: string, text: string): Promise<{ id: string }>;
  publishContainer(
    userId: string,
    containerId: string,
  ): Promise<{ id: string }>;
  publishPost(body: string): Promise<{ id: string; permalink: string }>;
  getReplies(
    postId: string,
  ): Promise<
    Array<{ id: string; author: string; body: string; timestamp: string }>
  >;
  getInsights(postId: string): Promise<{
    impressions: number;
    likes: number;
    replies: number;
    shares: number;
    views: number;
  }>;
  getUserProfile(): Promise<{
    id: string;
    username: string;
    threadsProfilePictureUrl: string;
  }>;
  replyToPost(postId: string, text: string): Promise<{ id: string }>;
}

const createContainerResponseSchema = z.object({ id: z.string() });
const publishResponseSchema = z.object({ id: z.string() });
const userProfileResponseSchema = z.object({
  id: z.string(),
  username: z.string(),
  threads_profile_picture_url: z.string().optional(),
});
const insightMetricNames = ["views", "likes", "replies", "shares"] as const;
type InsightMetricName = (typeof insightMetricNames)[number];
type InsightMetricOrImpression = InsightMetricName | "impressions";

const insightMetricAliases: Record<
  InsightMetricOrImpression,
  readonly string[]
> = {
  impressions: ["impressions", "views"],
  views: ["views", "impressions"],
  likes: ["likes"],
  replies: ["replies"],
  shares: ["shares", "reposts"],
};

export class ThreadsGraphApiClient implements ThreadsApiClient {
  private accessToken: string;
  private userId: string;

  constructor() {
    const env = loadEnv();
    this.accessToken = env.THREADS_ACCESS_TOKEN ?? "";
    this.userId = env.THREADS_USER_ID ?? "";
  }

  private async request<T>(url: string, options: RequestInit = {}): Promise<T> {
    logger.debug({ url }, "Threads API request");

    const maxRetries = 3;
    let lastError: unknown;
    const env = loadEnv();

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      await waitForRateLimit(
        "threads-api",
        Math.min(env.SCRAPER_RATE_LIMIT_MS, 1000),
      );
      const response = await fetch(url, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...options.headers,
          Authorization: `Bearer ${this.accessToken}`,
        },
      });

      if (response.ok) {
        return response.json() as Promise<T>;
      }

      const status = response.status;
      const errorBody = await response.text();

      if (status === 429) {
        if (attempt >= maxRetries) {
          throw new ExternalApiError(
            "Threads API",
            `429 (rate limit): ${errorBody}`,
          );
        }
        const retryAfter = response.headers.get("Retry-After");
        const waitMs = retryAfter ? Number(retryAfter) * 1000 : 60_000;
        logger.warn(
          { status, waitMs, attempt },
          "Threads API 429 – retrying after wait",
        );
        await new Promise((r) => setTimeout(r, waitMs));
        lastError = new ExternalApiError(
          "Threads API",
          `${status}: ${errorBody}`,
        );
        continue;
      }

      if (status >= 500) {
        if (attempt >= maxRetries) {
          throw new ExternalApiError("Threads API", `${status}: ${errorBody}`);
        }
        const waitMs = 1000 * 2 ** attempt;
        logger.warn(
          { status, waitMs, attempt },
          "Threads API 5xx – retrying with backoff",
        );
        await new Promise((r) => setTimeout(r, waitMs));
        lastError = new ExternalApiError(
          "Threads API",
          `${status}: ${errorBody}`,
        );
        continue;
      }

      throw new ExternalApiError("Threads API", `${status}: ${errorBody}`);
    }

    throw lastError ?? new ExternalApiError("Threads API", "Unknown error");
  }

  async createContainer(userId: string, text: string): Promise<{ id: string }> {
    const params = new URLSearchParams({
      media_type: "TEXT",
      text,
    });
    const result = await this.request<{ id: string }>(
      `${THREADS_API_BASE}/${userId}/threads?${params.toString()}`,
      { method: "POST" },
    );
    return createContainerResponseSchema.parse(result);
  }

  async publishContainer(
    userId: string,
    containerId: string,
  ): Promise<{ id: string }> {
    const params = new URLSearchParams({
      creation_id: containerId,
    });
    const result = await this.request<{ id: string }>(
      `${THREADS_API_BASE}/${userId}/threads_publish?${params.toString()}`,
      { method: "POST" },
    );
    return publishResponseSchema.parse(result);
  }

  async publishPost(body: string): Promise<{ id: string; permalink: string }> {
    if (body.length > 500) {
      throw new Error(`Threads post exceeds 500 chars: ${body.length}`);
    }
    const container = await this.createContainer(this.userId, body);
    const published = await this.publishContainer(this.userId, container.id);
    const post = await this.request<{ id: string; permalink?: string }>(
      `${THREADS_API_BASE}/${published.id}?fields=id,permalink`,
    );

    logger.info({ postId: published.id }, "Post published to Threads");

    return { id: published.id, permalink: post.permalink ?? "" };
  }

  async getReplies(
    postId: string,
  ): Promise<
    Array<{ id: string; author: string; body: string; timestamp: string }>
  > {
    const result = await this.request<{
      data: Array<{
        id: string;
        username: string;
        text: string;
        timestamp: string;
      }>;
    }>(
      `${THREADS_API_BASE}/${postId}/replies?fields=id,username,text,timestamp`,
    );

    return (result.data ?? []).map((r) => ({
      id: r.id,
      author: r.username,
      body: r.text,
      timestamp: r.timestamp,
    }));
  }

  private buildInsightsUrl(
    postId: string,
    metricNames: readonly string[],
  ): string {
    const params = new URLSearchParams();
    for (const metric of metricNames) {
      params.append("metric", metric);
    }
    return `${THREADS_API_BASE}/${postId}/insights?${params.toString()}`;
  }

  private async fetchInsightsMetrics(
    postId: string,
    metricNames: readonly InsightMetricName[],
  ): Promise<Record<InsightMetricName, number>> {
    const metrics = Object.fromEntries(
      metricNames.map((metric) => [metric, 0]),
    ) as Record<InsightMetricName, number>;
    const remainingMetrics = new Set<InsightMetricName>(metricNames);

    try {
      const result = await this.request<{
        data: Array<{ name: string; values: Array<{ value: number }> }>;
      }>(this.buildInsightsUrl(postId, metricNames));

      for (const item of result.data ?? []) {
        if (metricNames.includes(item.name as InsightMetricName)) {
          metrics[item.name as InsightMetricName] =
            item.values?.[0]?.value ?? 0;
          remainingMetrics.delete(item.name as InsightMetricName);
        }
      }

      if (remainingMetrics.size === 0) {
        return metrics;
      }

      logger.warn(
        { postId, missingMetrics: [...remainingMetrics] },
        "Threads insights response was partial, fetching missing metrics individually",
      );
    } catch (error) {
      logger.warn(
        {
          postId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Bulk Threads insights request failed, retrying per metric",
      );
    }

    for (const metric of remainingMetrics) {
      metrics[metric] = await this.fetchSingleInsightMetric(postId, metric);
    }

    return metrics;
  }

  private async fetchSingleInsightMetric(
    postId: string,
    metric: InsightMetricOrImpression,
  ): Promise<number> {
    const aliases = insightMetricAliases[metric] ?? [metric];

    for (const alias of aliases) {
      try {
        const result = await this.request<{
          data: Array<{ name: string; values: Array<{ value: number }> }>;
        }>(this.buildInsightsUrl(postId, [alias]));

        const matchedMetric = result.data?.find((item) =>
          aliases.includes(item.name),
        );
        if (matchedMetric) {
          return matchedMetric.values?.[0]?.value ?? 0;
        }
      } catch (error) {
        logger.warn(
          {
            postId,
            metric,
            alias,
            error: error instanceof Error ? error.message : String(error),
          },
          "Threads single insight metric request failed",
        );
      }
    }

    logger.error(
      { postId, metric },
      "Threads insight metric unavailable after all retries — possible token expiry or API issue",
    );
    return 0;
  }

  /** Check if the current access token is still valid */
  async verifyTokenHealth(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.getUserProfile();
      return { ok: true, detail: "token is valid" };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async getInsights(postId: string): Promise<{
    impressions: number;
    likes: number;
    replies: number;
    shares: number;
    views: number;
  }> {
    const metrics = await this.fetchInsightsMetrics(postId, insightMetricNames);
    const impressions =
      metrics.views > 0
        ? metrics.views
        : await this.fetchSingleInsightMetric(postId, "impressions");

    return {
      impressions,
      likes: metrics.likes,
      replies: metrics.replies,
      shares: metrics.shares,
      views: metrics.views,
    };
  }

  async getUserProfile(): Promise<{
    id: string;
    username: string;
    threadsProfilePictureUrl: string;
  }> {
    const raw = await this.request<{
      id: string;
      username: string;
      threads_profile_picture_url?: string;
    }>(`${THREADS_API_BASE}/me?fields=id,username,threads_profile_picture_url`);

    const parsed = userProfileResponseSchema.parse(raw);

    return {
      id: parsed.id,
      username: parsed.username,
      threadsProfilePictureUrl: parsed.threads_profile_picture_url ?? "",
    };
  }

  async replyToPost(postId: string, text: string): Promise<{ id: string }> {
    const params = new URLSearchParams({
      media_type: "TEXT",
      text,
      reply_to_id: postId,
    });
    const container = await this.request<{ id: string }>(
      `${THREADS_API_BASE}/${this.userId}/threads?${params.toString()}`,
      { method: "POST" },
    );
    return this.publishContainer(this.userId, container.id);
  }
}

export class DryRunThreadsApiClient implements ThreadsApiClient {
  async createContainer(
    _userId: string,
    text: string,
  ): Promise<{ id: string }> {
    logger.info(
      { text: text.slice(0, 50) },
      "[DRY-RUN] Would create container",
    );
    return { id: `dry-run-container-${Date.now()}` };
  }

  async publishContainer(
    _userId: string,
    containerId: string,
  ): Promise<{ id: string }> {
    logger.info({ containerId }, "[DRY-RUN] Would publish container");
    return { id: `dry-run-post-${Date.now()}` };
  }

  async publishPost(body: string): Promise<{ id: string; permalink: string }> {
    logger.info({ body: body.slice(0, 50) }, "[DRY-RUN] Would publish post");
    return {
      id: `dry-run-${Date.now()}`,
      permalink: "https://threads.net/dry-run",
    };
  }

  async getReplies(
    _postId: string,
  ): Promise<
    Array<{ id: string; author: string; body: string; timestamp: string }>
  > {
    return [];
  }

  async getInsights(_postId: string): Promise<{
    impressions: number;
    likes: number;
    replies: number;
    shares: number;
    views: number;
  }> {
    return { impressions: 0, likes: 0, replies: 0, shares: 0, views: 0 };
  }

  async getUserProfile(): Promise<{
    id: string;
    username: string;
    threadsProfilePictureUrl: string;
  }> {
    return {
      id: "dry-run",
      username: "dry-run-user",
      threadsProfilePictureUrl: "",
    };
  }

  async replyToPost(_postId: string, _text: string): Promise<{ id: string }> {
    logger.info("[DRY-RUN] Would reply to post");
    return { id: `dry-run-reply-${Date.now()}` };
  }
}
