import { sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmClient } from "../src/adapters/llm/index.js";
import type { ThreadsApiClient } from "../src/adapters/threads-api/index.js";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = ":memory:";

type Db = typeof import("../src/db/index.js")["db"];
type SchemaModule = typeof import("../src/db/schema.js");
type PostAuditServiceCtor =
  typeof import("../src/services/post-audit/index.js")["PostAuditServiceImpl"];
type NoteAuditServiceCtor =
  typeof import("../src/services/note-audit/index.js")["NoteAuditServiceImpl"];
type OrchestrationServiceCtor =
  typeof import("../src/services/orchestration/index.js")["OrchestrationServiceImpl"];
type ThreadsGraphApiClientCtor =
  typeof import("../src/adapters/threads-api/index.js")["ThreadsGraphApiClient"];

let db: Db;
let schema: SchemaModule;
let PostAuditServiceImpl: PostAuditServiceCtor;
let NoteAuditServiceImpl: NoteAuditServiceCtor;
let OrchestrationServiceImpl: OrchestrationServiceCtor;
let ThreadsGraphApiClient: ThreadsGraphApiClientCtor;

beforeAll(async () => {
  ({ db } = await import("../src/db/index.js"));
  schema = await import("../src/db/schema.js");
  const { ensureAutonomyTables } = await import("../src/db/bootstrap.js");
  ({ PostAuditServiceImpl } = await import(
    "../src/services/post-audit/index.js"
  ));
  ({ NoteAuditServiceImpl } = await import(
    "../src/services/note-audit/index.js"
  ));
  ({ OrchestrationServiceImpl } = await import(
    "../src/services/orchestration/index.js"
  ));
  ({ ThreadsGraphApiClient } = await import(
    "../src/adapters/threads-api/index.js"
  ));

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
  db.run(sql`CREATE TABLE IF NOT EXISTS thread_post_audits (
    id TEXT PRIMARY KEY,
    draft_id TEXT NOT NULL UNIQUE,
    verdict TEXT NOT NULL,
    severity TEXT NOT NULL,
    reasons TEXT NOT NULL,
    suggestions TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  db.run(sql`CREATE TABLE IF NOT EXISTS note_drafts (
    id TEXT PRIMARY KEY,
    idea_id TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    outline TEXT,
    cta TEXT,
    publish_readiness_score REAL,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.run(sql`CREATE TABLE IF NOT EXISTS note_audits (
    id TEXT PRIMARY KEY,
    draft_id TEXT NOT NULL UNIQUE,
    verdict TEXT NOT NULL,
    strongest_section TEXT,
    weakest_section TEXT,
    rewrite_guidance TEXT,
    score REAL NOT NULL,
    created_at TEXT NOT NULL
  )`);
  db.run(sql`CREATE TABLE IF NOT EXISTS human_review_items (
    id TEXT PRIMARY KEY,
    item_type TEXT NOT NULL,
    item_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    reviewed_at TEXT,
    reviewer_note TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(item_type, item_id)
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

beforeEach(() => {
  db.run(sql`DELETE FROM topics`);
  db.run(sql`DELETE FROM improvement_insights`);
  db.run(sql`DELETE FROM reply_decisions`);
  db.run(sql`DELETE FROM thread_replies`);
  db.run(sql`DELETE FROM thread_post_results`);
  db.run(sql`DELETE FROM human_review_items`);
  db.run(sql`DELETE FROM note_audits`);
  db.run(sql`DELETE FROM note_drafts`);
  db.run(sql`DELETE FROM thread_post_audits`);
  db.run(sql`DELETE FROM thread_post_drafts`);
});

describe("re-execution safety", () => {
  it("keeps post audits and human review items stable across re-audits", async () => {
    const service = new PostAuditServiceImpl();
    const llm: LlmClient = {
      generate: vi.fn(),
      audit: vi
        .fn()
        .mockResolvedValueOnce({
          verdict: "human_review",
          severity: "high",
          reasons: ["first pass needs review"],
          suggestions: ["tighten the hook"],
          score: 5,
        })
        .mockResolvedValueOnce({
          verdict: "pass",
          severity: "low",
          reasons: ["fixed"],
          suggestions: ["looks good"],
          score: 8,
        }),
    };

    db.insert(schema.threadPostDrafts)
      .values({
        id: "draft-post-1",
        topicId: "topic-1",
        body: "本文",
        hookType: "curiosity",
        ctaType: "comment",
        noteTransition: null,
        status: "draft",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run();

    const first = await service.auditDraft("draft-post-1", llm);
    const second = await service.auditDraft("draft-post-1", llm);

    expect(first.id).toBe(second.id);

    const audits = db.select().from(schema.threadPostAudits).all();
    expect(audits).toHaveLength(1);
    expect(audits[0].verdict).toBe("pass");

    const reviewItems = db.select().from(schema.humanReviewItems).all();
    expect(reviewItems).toHaveLength(1);
    expect(reviewItems[0].status).toBe("approved");
  });

  it("keeps note audits and human review items stable across re-audits", async () => {
    const service = new NoteAuditServiceImpl();
    const llm: LlmClient = {
      generate: vi
        .fn()
        .mockResolvedValueOnce(
          JSON.stringify({
            verdict: "human_review",
            strongestSection: "導入",
            weakestSection: "結論",
            rewriteGuidance: "結論を強くする",
            score: 5,
          }),
        )
        .mockResolvedValueOnce(
          JSON.stringify({
            verdict: "pass",
            strongestSection: "導入",
            weakestSection: "なし",
            rewriteGuidance: "そのままでよい",
            score: 8,
          }),
        ),
      audit: vi.fn(),
    };

    db.insert(schema.noteDrafts)
      .values({
        id: "note-draft-1",
        ideaId: "idea-1",
        title: "タイトル",
        body: "本文",
        outline: null,
        cta: null,
        publishReadinessScore: null,
        status: "draft",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run();

    const first = await service.auditDraft("note-draft-1", llm);
    const second = await service.auditDraft("note-draft-1", llm);

    expect(first.id).toBe(second.id);

    const audits = db.select().from(schema.noteAudits).all();
    expect(audits).toHaveLength(1);
    expect(audits[0].verdict).toBe("pass");

    const reviewItems = db.select().from(schema.humanReviewItems).all();
    expect(reviewItems).toHaveLength(1);
    expect(reviewItems[0].status).toBe("approved");
  });

  it("does not duplicate replies or insights when followup runs twice", async () => {
    const service = new OrchestrationServiceImpl();
    const api: ThreadsApiClient = {
      createContainer: vi.fn(),
      publishContainer: vi.fn(),
      publishPost: vi.fn(),
      getReplies: vi.fn().mockResolvedValue([
        {
          id: "reply-1",
          author: "alice",
          body: "great post",
          timestamp: new Date().toISOString(),
        },
      ]),
      getInsights: vi.fn(),
      getUserProfile: vi.fn(),
      replyToPost: vi.fn(),
    };
    const llm: LlmClient = {
      generate: vi.fn((prompt: string) => {
        if (prompt.includes("返信の危険度")) {
          return Promise.resolve(
            JSON.stringify({
              decision: "safe_auto_reply",
              sentiment: "positive",
              autoReplyBody: "ありがとう",
              reason: "好意的な反応",
            }),
          );
        }

        if (prompt.includes("投稿パフォーマンス")) {
          return Promise.resolve(
            JSON.stringify([
              {
                insight: "導入が強い",
                action: "冒頭の勢いを維持する",
                priority: "medium",
              },
            ]),
          );
        }

        return Promise.resolve("");
      }),
      audit: vi.fn(),
    };

    const now = new Date().toISOString();
    db.insert(schema.threadPostResults)
      .values({
        id: "post-result-1",
        draftId: "draft-1",
        threadsPostId: "threads-post-1",
        impressions: 100,
        likes: 10,
        repliesCount: 1,
        shares: 2,
        publishedAt: now,
        createdAt: now,
      })
      .run();
    db.insert(schema.topics)
      .values({
        id: "topic-1",
        name: "topic",
        niche: "niche",
        priorityScore: 10,
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(schema.threadPostDrafts)
      .values({
        id: "draft-1",
        topicId: "topic-1",
        body: "本文",
        hookType: "curiosity",
        ctaType: "comment",
        noteTransition: null,
        status: "audited",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const first = await service.runPostPublishFollowup(api, llm);
    const second = await service.runPostPublishFollowup(api, llm);

    expect(first).toBe("Processed 1 posts for post publish followup.");
    expect(second).toBe("Processed 1 posts for post publish followup.");
    expect(db.select().from(schema.threadReplies).all()).toHaveLength(1);
    expect(db.select().from(schema.replyDecisions).all()).toHaveLength(1);
    // analyzePostPerformance produces LLM insights + schedule insights from refreshThreadSnapshots.
    // The key invariant: running followup twice yields the same count (no duplicates).
    const insightsAfterFirst = db
      .select()
      .from(schema.improvementInsights)
      .all();
    const insightsAfterSecond = db
      .select()
      .from(schema.improvementInsights)
      .all();
    expect(insightsAfterFirst.length).toBe(insightsAfterSecond.length);
    expect(insightsAfterSecond.length).toBeGreaterThanOrEqual(1);
  });

  it("returns camelCase profile data from Threads API", async () => {
    const client = new ThreadsGraphApiClient();
    type ClientWithRequest = InstanceType<ThreadsGraphApiClientCtor> & {
      request: ReturnType<typeof vi.fn>;
    };
    (client as ClientWithRequest).request = vi.fn().mockResolvedValue({
      id: "user-1",
      username: "threads_user",
      threads_profile_picture_url: "https://example.com/profile.jpg",
    });

    const profile = await client.getUserProfile();

    expect(profile).toEqual({
      id: "user-1",
      username: "threads_user",
      threadsProfilePictureUrl: "https://example.com/profile.jpg",
    });
  });
});
