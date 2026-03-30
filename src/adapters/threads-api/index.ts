import { z } from "zod";
import { ExternalApiError } from "../../app/errors.js";
import { logger } from "../../app/logger.js";
import { loadEnv } from "../../config/env.js";

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

export class ThreadsGraphApiClient implements ThreadsApiClient {
  private accessToken: string;
  private userId: string;

  constructor() {
    const env = loadEnv();
    this.accessToken = env.THREADS_ACCESS_TOKEN ?? "";
    this.userId = env.THREADS_USER_ID ?? "";
  }

  private async request<T>(url: string, options: RequestInit = {}): Promise<T> {
    const separator = url.includes("?") ? "&" : "?";
    const fullUrl = `${url}${separator}access_token=${this.accessToken}`;

    logger.debug(
      { url: url.replace(this.accessToken, "***") },
      "Threads API request",
    );

    const maxRetries = 3;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const response = await fetch(fullUrl, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...options.headers,
        },
      });

      if (response.ok) {
        return response.json() as Promise<T>;
      }

      const status = response.status;
      const errorBody = await response.text();

      if (status === 429) {
        if (attempt >= 1) {
          throw new ExternalApiError("Threads API", `429 (rate limit): ${errorBody}`);
        }
        const retryAfter = response.headers.get("Retry-After");
        const waitMs = retryAfter ? Number(retryAfter) * 1000 : 60_000;
        logger.warn({ status, waitMs, attempt }, "Threads API 429 – retrying after wait");
        await new Promise((r) => setTimeout(r, waitMs));
        lastError = new ExternalApiError("Threads API", `${status}: ${errorBody}`);
        continue;
      }

      if (status >= 500) {
        if (attempt >= maxRetries) {
          throw new ExternalApiError("Threads API", `${status}: ${errorBody}`);
        }
        const waitMs = 1000 * 2 ** attempt;
        logger.warn({ status, waitMs, attempt }, "Threads API 5xx – retrying with backoff");
        await new Promise((r) => setTimeout(r, waitMs));
        lastError = new ExternalApiError("Threads API", `${status}: ${errorBody}`);
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

  async getInsights(postId: string): Promise<{
    impressions: number;
    likes: number;
    replies: number;
    shares: number;
    views: number;
  }> {
    const result = await this.request<{
      data: Array<{ name: string; values: Array<{ value: number }> }>;
    }>(
      `${THREADS_API_BASE}/${postId}/insights?metric=impressions,likes,replies,shares,views`,
    );

    const metrics: Record<string, number> = {};
    for (const m of result.data ?? []) {
      metrics[m.name] = m.values?.[0]?.value ?? 0;
    }

    return {
      impressions: metrics.impressions ?? 0,
      likes: metrics.likes ?? 0,
      replies: metrics.replies ?? 0,
      shares: metrics.shares ?? 0,
      views: metrics.views ?? 0,
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
