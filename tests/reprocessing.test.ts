import { sql } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { LlmClient } from "../src/adapters/llm/index.js";
import type { ThreadsApiClient } from "../src/adapters/threads-api/index.js";

type Db = typeof import("../src/db/index.js")["db"];
type SchemaModule = typeof import("../src/db/schema.js");
type OrchestrationServiceCtor =
  typeof import("../src/services/orchestration/index.js")["OrchestrationServiceImpl"];
type ThreadsGraphApiClientCtor =
  typeof import("../src/adapters/threads-api/index.js")["ThreadsGraphApiClient"];
type ImprovementInsight = SchemaModule["improvementInsights"]["$inferSelect"];

let db: Db;
let schema: SchemaModule;
let OrchestrationServiceImpl: OrchestrationServiceCtor;
let ThreadsGraphApiClient: ThreadsGraphApiClientCtor;

class FakeLlm implements LlmClient {
  async generate(prompt: string): Promise<string> {
    if (prompt.includes("投稿パフォーマンス")) {
      return JSON.stringify([
        {
          insight: "CTA を明確にする",
          action: "最後の一文で次の行動を1つだけ伝える",
          priority: "medium",
        },
      ]);
    }

    return JSON.stringify({
      decision: "safe_auto_reply",
      sentiment: "positive",
      autoReplyBody: "ありがとう",
      reason: "positive reply",
    });
  }

  async audit(
    _content: string,
    _criteria: string[],
  ): Promise<{
    verdict: "pass" | "revise" | "reject" | "human_review";
    severity: "low" | "medium" | "high";
    reasons: string[];
    suggestions: string[];
    score: number;
  }> {
    return {
      verdict: "pass",
      severity: "low",
      reasons: ["ok"],
      suggestions: [],
      score: 8,
    };
  }
}

class FakeThreadsApi implements ThreadsApiClient {
  async createContainer(
    _userId: string,
    _text: string,
  ): Promise<{ id: string }> {
    return { id: "container-1" };
  }

  async publishContainer(
    _userId: string,
    _containerId: string,
  ): Promise<{ id: string }> {
    return { id: "post-1" };
  }

  async publishPost(_body: string): Promise<{ id: string; permalink: string }> {
    return { id: "post-1", permalink: "https://threads.net/post-1" };
  }

  async getReplies(
    _postId: string,
  ): Promise<
    Array<{ id: string; author: string; body: string; timestamp: string }>
  > {
    return [
      {
        id: "reply-1",
        author: "reader",
        body: "いい投稿だった",
        timestamp: new Date().toISOString(),
      },
    ];
  }

  async getInsights(_postId: string): Promise<{
    impressions: number;
    likes: number;
    replies: number;
    shares: number;
    views: number;
  }> {
    return {
      impressions: 120,
      likes: 20,
      replies: 1,
      shares: 2,
      views: 140,
    };
  }

  async getUserProfile(): Promise<{
    id: string;
    username: string;
    threadsProfilePictureUrl: string;
  }> {
    return { id: "dummy", username: "dummy", threadsProfilePictureUrl: "" };
  }

  async replyToPost(_postId: string, _text: string): Promise<{ id: string }> {
    return { id: "reply-1" };
  }
}

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = ":memory:";
  process.env.THREADS_ACCESS_TOKEN = "test-token";
  process.env.THREADS_USER_ID = "test-user";

  const dbModule = await import("../src/db/index.js");
  schema = await import("../src/db/schema.js");
  const { ensureAutonomyTables } = await import("../src/db/bootstrap.js");
  ({ OrchestrationServiceImpl } = await import(
    "../src/services/orchestration/index.js"
  ));
  ({ ThreadsGraphApiClient } = await import(
    "../src/adapters/threads-api/index.js"
  ));
  db = dbModule.db;

  ensureAutonomyTables();

  db.run(sql`CREATE TABLE IF NOT EXISTS topics (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    niche TEXT NOT NULL,
    priority_score INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS thread_post_drafts (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL,
    body TEXT NOT NULL,
    hook_type TEXT NOT NULL,
    cta_type TEXT NOT NULL,
    note_transition TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS thread_post_results (
    id TEXT PRIMARY KEY,
    draft_id TEXT NOT NULL,
    threads_post_id TEXT NOT NULL UNIQUE,
    impressions INTEGER NOT NULL DEFAULT 0,
    likes INTEGER NOT NULL DEFAULT 0,
    replies_count INTEGER NOT NULL DEFAULT 0,
    shares INTEGER NOT NULL DEFAULT 0,
    published_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS thread_replies (
    id TEXT PRIMARY KEY,
    post_result_id TEXT NOT NULL,
    threads_reply_id TEXT NOT NULL,
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    sentiment TEXT,
    created_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS reply_decisions (
    id TEXT PRIMARY KEY,
    reply_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    auto_reply_body TEXT,
    sent_at TEXT,
    created_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS improvement_insights (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    insight TEXT NOT NULL,
    action TEXT NOT NULL,
    priority TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);

});

afterEach(() => {
  db?.run(sql`DELETE FROM topics`);
  db?.run(sql`DELETE FROM thread_post_drafts`);
  db?.run(sql`DELETE FROM reply_decisions`);
  db?.run(sql`DELETE FROM thread_replies`);
  db?.run(sql`DELETE FROM improvement_insights`);
  db?.run(sql`DELETE FROM thread_post_results`);
  vi.restoreAllMocks();
});

describe("reprocessing safety", () => {
  it("does not duplicate replies or insights when followup runs twice", async () => {
    const now = new Date().toISOString();
    const postResultId = "post-result-1";

    db.run(sql`INSERT INTO thread_post_results (
      id, draft_id, threads_post_id, impressions, likes, replies_count, shares, published_at, created_at
    ) VALUES (
      ${postResultId}, 'draft-1', 'threads-post-1', 120, 20, 1, 2, ${now}, ${now}
    )`);
    db.run(sql`INSERT INTO topics (
      id, name, niche, priority_score, status, created_at, updated_at
    ) VALUES (
      'topic-1', 'topic', 'niche', 10, 'active', ${now}, ${now}
    )`);
    db.run(sql`INSERT INTO thread_post_drafts (
      id, topic_id, body, hook_type, cta_type, note_transition, status, created_at, updated_at
    ) VALUES (
      'draft-1', 'topic-1', '本文', 'curiosity', 'comment', NULL, 'audited', ${now}, ${now}
    )`);

    const orchestration = new OrchestrationServiceImpl();
    const api = new FakeThreadsApi();
    const llm = new FakeLlm();

    await orchestration.runPostPublishFollowup(api, llm, false);

    const firstReplies = db.select().from(schema.threadReplies).all();
    const firstDecisions = db.select().from(schema.replyDecisions).all();
    const firstInsights = db.select().from(schema.improvementInsights).all();

    expect(firstReplies).toHaveLength(1);
    expect(firstDecisions).toHaveLength(1);
    // analyzePostPerformance produces LLM insights + schedule insights from refreshThreadSnapshots.
    expect(firstInsights.length).toBeGreaterThanOrEqual(1);

    await orchestration.runPostPublishFollowup(api, llm, false);

    const secondReplies = db.select().from(schema.threadReplies).all();
    const secondDecisions = db.select().from(schema.replyDecisions).all();
    const secondInsights = db.select().from(schema.improvementInsights).all();

    expect(secondReplies).toHaveLength(1);
    expect(secondDecisions).toHaveLength(1);
    // Key invariant: no duplicates across re-runs
    expect(secondInsights.length).toBe(firstInsights.length);
    // At least one insight should reference our post
    const postInsights = secondInsights.filter(
      (i: ImprovementInsight) => i.sourceId === postResultId,
    );
    expect(postInsights.length).toBeGreaterThanOrEqual(1);
  });

  it("returns camelCase user profile fields", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "user-1",
          username: "codex",
          threads_profile_picture_url: "https://example.com/profile.jpg",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    const client = new ThreadsGraphApiClient();
    const profile = await client.getUserProfile();

    expect(profile).toEqual({
      id: "user-1",
      username: "codex",
      threadsProfilePictureUrl: "https://example.com/profile.jpg",
    });
    expect(fetchMock).toHaveBeenCalled();
  });
});
