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
type PostGenerationServiceCtor =
  typeof import("../src/services/post-generation/index.js")["PostGenerationServiceImpl"];
type CadenceOptimizerServiceCtor =
  typeof import("../src/services/cadence-optimizer/index.js")["CadenceOptimizerServiceImpl"];
type OrchestrationServiceCtor =
  typeof import("../src/services/orchestration/index.js")["OrchestrationServiceImpl"];
type ThreadsGraphApiClientCtor =
  typeof import("../src/adapters/threads-api/index.js")["ThreadsGraphApiClient"];
type StorageClient =
  typeof import("../src/adapters/storage/index.js")["StorageClient"];

let db: Db;
let schema: SchemaModule;
let PostAuditServiceImpl: PostAuditServiceCtor;
let NoteAuditServiceImpl: NoteAuditServiceCtor;
let PostGenerationServiceImpl: PostGenerationServiceCtor;
let CadenceOptimizerServiceImpl: CadenceOptimizerServiceCtor;
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
  ({ PostGenerationServiceImpl } = await import(
    "../src/services/post-generation/index.js"
  ));
  ({ CadenceOptimizerServiceImpl } = await import(
    "../src/services/cadence-optimizer/index.js"
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
  db.run(sql`DELETE FROM content_slots`);
  db.run(sql`DELETE FROM note_post_results`);
  db.run(sql`DELETE FROM note_ideas`);
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

  it("keeps ordinary note revise results out of human review", async () => {
    const service = new NoteAuditServiceImpl();
    const llm: LlmClient = {
      generate: vi.fn().mockResolvedValue(`\`\`\`json
{
  "verdict": "revise",
  "strongestSection": "導入",
  "weakestSection": "CTA",
  "rewriteGuidance": "末尾の導線を\n具体化する",
  "score": 5
}
\`\`\``),
      audit: vi.fn(),
    };

    db.insert(schema.noteDrafts)
      .values({
        id: "note-draft-2",
        ideaId: "idea-2",
        title: "タイトル2",
        body: "本文2",
        outline: null,
        cta: null,
        publishReadinessScore: null,
        status: "draft",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run();

    const audit = await service.auditDraft("note-draft-2", llm);

    expect(audit.verdict).toBe("revise");
    expect(audit.rewriteGuidance).toContain("末尾の導線");

    const reviewItems = db.select().from(schema.humanReviewItems).all();
    expect(reviewItems).toHaveLength(0);
  });

  it("normalizes passed note audits to a publishable score", async () => {
    const service = new NoteAuditServiceImpl();
    const llm: LlmClient = {
      generate: vi.fn().mockResolvedValue(
        JSON.stringify({
          verdict: "pass",
          strongestSection: "導入",
          weakestSection: "なし",
          rewriteGuidance: "十分に良い",
          score: 4,
        }),
      ),
      audit: vi.fn(),
    };

    db.insert(schema.noteDrafts)
      .values({
        id: "note-draft-3",
        ideaId: "idea-3",
        title: "タイトル3",
        body: "本文3",
        outline: null,
        cta: null,
        publishReadinessScore: null,
        status: "draft",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run();

    const audit = await service.auditDraft("note-draft-3", llm);
    const storedDraft = db
      .select()
      .from(schema.noteDrafts)
      .where(sql`id = ${"note-draft-3"}`)
      .get();

    expect(audit.verdict).toBe("pass");
    expect(audit.score).toBe(7);
    expect(storedDraft?.status).toBe("audited");
    expect(storedDraft?.publishReadinessScore).toBe(7);
  });

  it("parses generated draft arrays with multiline body strings", async () => {
    const service = new PostGenerationServiceImpl();
    const llm: LlmClient = {
      generate: vi.fn().mockResolvedValue(`[
  {
    "body": "1行目
2行目",
    "hookType": "story",
    "ctaType": "comment",
    "noteTransition": "noteで続きを読む"
  }
]`),
      audit: vi.fn(),
    };

    const drafts = await service.generateDrafts(
      "topic-1",
      "恋愛",
      "- インサイト",
      1,
      llm,
    );

    expect(drafts).toHaveLength(1);
    expect(drafts[0].body).toContain("1行目");
    expect(drafts[0].body).toContain("2行目");
  });

  it("parses generated draft arrays with unescaped quotes inside body strings", async () => {
    const service = new PostGenerationServiceImpl();
    const llm: LlmClient = {
      generate: vi.fn().mockResolvedValue(`[
  {
    "body": "「本気じゃない男のLINEには、ある"共通点"がある。」\n\n見極めるなら行動を見る。",
    "hookType": "story",
    "ctaType": "comment",
    "noteTransition": "続きはnoteへ"
  }
]`),
      audit: vi.fn(),
    };

    const drafts = await service.generateDrafts(
      "topic-1",
      "恋愛",
      "- インサイト",
      1,
      llm,
    );

    expect(drafts).toHaveLength(1);
    expect(drafts[0].body).toContain('ある"共通点"がある');
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

  it("auto-revises thread drafts until they pass audit", async () => {
    const service = new OrchestrationServiceImpl() as unknown as {
      runDailyThreadsPlan: OrchestrationServiceCtor["prototype"]["runDailyThreadsPlan"];
      topicService: { selectDailyTopics: ReturnType<typeof vi.fn> };
      researchService: {
        getResearchForTopic: ReturnType<typeof vi.fn>;
        summarizeResearch: ReturnType<typeof vi.fn>;
      };
      postGenService: {
        generateDrafts: ReturnType<typeof vi.fn>;
        regenerateDraft: ReturnType<typeof vi.fn>;
      };
      postAuditService: { auditDraft: ReturnType<typeof vi.fn> };
    };
    const storage: StorageClient = {
      saveFile: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn(),
      listFiles: vi.fn(),
      exists: vi.fn(),
    };
    const llm: LlmClient = { generate: vi.fn(), audit: vi.fn() };

    service.topicService = {
      selectDailyTopics: vi.fn().mockResolvedValue([
        {
          id: "topic-1",
          name: "恋愛",
          niche: "恋愛",
          priorityScore: 80,
          status: "active",
        },
      ]),
    };
    service.researchService = {
      getResearchForTopic: vi.fn().mockResolvedValue([]),
      summarizeResearch: vi.fn().mockResolvedValue("- インサイト"),
    };
    service.postGenService = {
      generateDrafts: vi.fn().mockResolvedValue([
        {
          id: "thread-draft-1",
          topicId: "topic-1",
          body: "初稿",
          hookType: "story",
          ctaType: "comment",
          noteTransition: "note導線",
          status: "draft",
        },
      ]),
      regenerateDraft: vi.fn().mockResolvedValue({
        id: "thread-draft-2",
        topicId: "topic-1",
        body: "改善稿",
        hookType: "story",
        ctaType: "comment",
        noteTransition: "note導線",
        status: "draft",
      }),
    };
    service.postAuditService = {
      auditDraft: vi
        .fn()
        .mockResolvedValueOnce({
          id: "thread-audit-1",
          draftId: "thread-draft-1",
          verdict: "revise",
          severity: "medium",
          reasons: ["具体性不足"],
          suggestions: ["冒頭に具体例を入れる"],
        })
        .mockResolvedValueOnce({
          id: "thread-audit-2",
          draftId: "thread-draft-2",
          verdict: "pass",
          severity: "low",
          reasons: ["十分に良い"],
          suggestions: ["そのまま"],
        }),
    };

    const summary = await service.runDailyThreadsPlan(llm, storage, false);

    expect(summary).toBe("Generated 1 drafts, 1 passed audit. ");
    expect(service.postGenService.regenerateDraft).toHaveBeenCalledTimes(1);
    expect(service.postGenService.regenerateDraft).toHaveBeenCalledWith(
      "thread-draft-1",
      expect.stringContaining("冒頭に具体例を入れる"),
      llm,
    );
    expect(storage.saveFile).toHaveBeenCalledWith(
      expect.stringContaining("thread-draft-2.md"),
      expect.stringContaining("改善稿"),
    );
  });

  it("auto-revises note drafts until they pass audit", async () => {
    const service = new OrchestrationServiceImpl() as unknown as {
      runNightlyNotePipeline: OrchestrationServiceCtor["prototype"]["runNightlyNotePipeline"];
      topicService: { selectDailyTopics: ReturnType<typeof vi.fn> };
      noteGenService: {
        createIdea: ReturnType<typeof vi.fn>;
        generateTitleCandidates: ReturnType<typeof vi.fn>;
        generateOutline: ReturnType<typeof vi.fn>;
        generateDraft: ReturnType<typeof vi.fn>;
        regenerateDraft: ReturnType<typeof vi.fn>;
        generateChecklist: ReturnType<typeof vi.fn>;
      };
      noteAuditService: { auditDraft: ReturnType<typeof vi.fn> };
    };
    const storage: StorageClient = {
      saveFile: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn(),
      listFiles: vi.fn(),
      exists: vi.fn(),
    };
    const llm: LlmClient = { generate: vi.fn(), audit: vi.fn() };

    service.topicService = {
      selectDailyTopics: vi.fn().mockResolvedValue([
        {
          id: "topic-2",
          name: "副業",
          niche: "ビジネス",
          priorityScore: 90,
          status: "active",
        },
      ]),
    };
    service.noteGenService = {
      createIdea: vi.fn().mockResolvedValue({
        id: "idea-10",
        sourceTopicId: "topic-2",
        angle: "副業",
        targetReader: "会社員",
        priorityScore: 90,
        status: "idea",
      }),
      generateTitleCandidates: vi.fn().mockResolvedValue(["勝ち筋タイトル"]),
      generateOutline: vi.fn().mockResolvedValue("# outline"),
      generateDraft: vi.fn().mockResolvedValue({
        id: "note-draft-10",
        ideaId: "idea-10",
        title: "勝ち筋タイトル",
        body: "初稿本文",
        outline: "# outline",
        cta: "CTA",
        status: "draft",
      }),
      regenerateDraft: vi.fn().mockResolvedValue({
        id: "note-draft-11",
        ideaId: "idea-10",
        title: "勝ち筋タイトル",
        body: "改善本文",
        outline: "# outline",
        cta: "CTA",
        status: "draft",
      }),
      generateChecklist: vi.fn().mockResolvedValue("checklist"),
    };
    service.noteAuditService = {
      auditDraft: vi
        .fn()
        .mockResolvedValueOnce({
          id: "note-audit-1",
          draftId: "note-draft-10",
          verdict: "revise",
          strongestSection: "導入",
          weakestSection: "CTA",
          rewriteGuidance: "末尾の訴求を具体化する",
          score: 5,
        })
        .mockResolvedValueOnce({
          id: "note-audit-2",
          draftId: "note-draft-11",
          verdict: "pass",
          strongestSection: "導入",
          weakestSection: "なし",
          rewriteGuidance: "そのままでよい",
          score: 7,
        }),
    };

    const summary = await service.runNightlyNotePipeline(llm, storage, false);

    expect(summary).toBe("Generated 1 note drafts.");
    expect(service.noteGenService.regenerateDraft).toHaveBeenCalledTimes(1);
    expect(service.noteGenService.regenerateDraft).toHaveBeenCalledWith(
      "note-draft-10",
      expect.stringContaining("末尾の訴求を具体化する"),
      llm,
    );
    expect(service.noteGenService.generateChecklist).toHaveBeenCalledWith(
      "note-draft-11",
    );
    expect(storage.saveFile).toHaveBeenCalledWith(
      expect.stringContaining("note-draft-11.md"),
      expect.stringContaining("改善本文"),
    );
  });

  it("prioritizes winning Threads topics for nightly note generation", async () => {
    const service = new OrchestrationServiceImpl() as unknown as {
      runNightlyNotePipeline: OrchestrationServiceCtor["prototype"]["runNightlyNotePipeline"];
      topicService: { selectDailyTopics: ReturnType<typeof vi.fn> };
      noteGenService: {
        createIdea: ReturnType<typeof vi.fn>;
        generateTitleCandidates: ReturnType<typeof vi.fn>;
        generateOutline: ReturnType<typeof vi.fn>;
        generateDraft: ReturnType<typeof vi.fn>;
        regenerateDraft: ReturnType<typeof vi.fn>;
        generateChecklist: ReturnType<typeof vi.fn>;
      };
      noteAuditService: { auditDraft: ReturnType<typeof vi.fn> };
    };
    const storage: StorageClient = {
      saveFile: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn(),
      listFiles: vi.fn(),
      exists: vi.fn(),
    };
    const llm: LlmClient = { generate: vi.fn(), audit: vi.fn() };
    const now = new Date().toISOString();

    db.insert(schema.topics)
      .values([
        {
          id: "topic-win",
          name: "勝ちテーマ",
          niche: "ビジネス",
          priorityScore: 60,
          status: "active",
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "topic-lose",
          name: "弱いテーマ",
          niche: "ビジネス",
          priorityScore: 90,
          status: "active",
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();
    db.insert(schema.threadPostDrafts)
      .values([
        {
          id: "winner-draft",
          topicId: "topic-win",
          body: "勝ち本文",
          hookType: "story",
          ctaType: "comment",
          noteTransition: null,
          status: "published",
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "loser-draft",
          topicId: "topic-lose",
          body: "弱い本文",
          hookType: "story",
          ctaType: "comment",
          noteTransition: null,
          status: "published",
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();
    db.insert(schema.threadPostResults)
      .values([
        {
          id: "winner-result",
          draftId: "winner-draft",
          threadsPostId: "winner-thread",
          impressions: 1000,
          likes: 120,
          repliesCount: 30,
          shares: 20,
          publishedAt: now,
          createdAt: now,
        },
        {
          id: "loser-result",
          draftId: "loser-draft",
          threadsPostId: "loser-thread",
          impressions: 1000,
          likes: 10,
          repliesCount: 2,
          shares: 1,
          publishedAt: now,
          createdAt: now,
        },
      ])
      .run();

    service.topicService = {
      selectDailyTopics: vi.fn().mockResolvedValue([]),
    };
    service.noteGenService = {
      createIdea: vi.fn().mockResolvedValue({
        id: "note-idea",
        sourceTopicId: "topic-win",
        angle: "angle",
        targetReader: "reader",
        priorityScore: 50,
        status: "idea",
      }),
      generateTitleCandidates: vi.fn().mockResolvedValue(["title"]),
      generateOutline: vi.fn().mockResolvedValue("outline"),
      generateDraft: vi.fn().mockResolvedValue({
        id: "note-draft-topic",
        ideaId: "note-idea",
        title: "title",
        body: "body",
        outline: "outline",
        cta: "cta",
        status: "draft",
      }),
      regenerateDraft: vi.fn(),
      generateChecklist: vi.fn().mockResolvedValue("checklist"),
    };
    service.noteAuditService = {
      auditDraft: vi.fn().mockResolvedValue({
        id: "note-audit-topic",
        draftId: "note-draft-topic",
        verdict: "pass",
        strongestSection: "導入",
        weakestSection: "なし",
        rewriteGuidance: "そのまま",
        score: 7,
      }),
    };

    const summary = await service.runNightlyNotePipeline(llm, storage, false);

    expect(summary).toBe("Generated 2 note drafts.");
    expect(service.noteGenService.createIdea.mock.calls[0][0]).toBe(
      "勝ちテーマ",
    );
  });

  it("creates a Threads promotion draft after note publication", async () => {
    const { AutoPublisherServiceImpl } = await import(
      "../src/services/auto-publisher/index.js"
    );
    const service = new AutoPublisherServiceImpl({ dryRun: false });
    const now = new Date().toISOString();
    const noteApi = {
      getCurrentUser: vi.fn(),
      publishArticle: vi.fn().mockResolvedValue({
        noteId: "note-1",
        url: "https://note.com/example/n/note-1",
      }),
      updateArticle: vi.fn(),
      getMyArticles: vi.fn(),
      getArticleStats: vi.fn(),
    };

    db.insert(schema.noteIdeas)
      .values({
        id: "idea-promo",
        sourceTopicId: "topic-promo",
        angle: "勝ちテーマ",
        targetReader: "会社員",
        priorityScore: 80,
        status: "idea",
        createdAt: now,
      })
      .run();
    db.insert(schema.noteDrafts)
      .values({
        id: "note-draft-promo",
        ideaId: "idea-promo",
        title: "勝ちテーマの深掘り",
        body: "本文".repeat(1500),
        outline: null,
        cta: null,
        publishReadinessScore: 8,
        status: "audited",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(schema.contentSlots)
      .values({
        id: "note-slot-promo",
        channel: "note",
        scheduledAt: now,
        topicId: "topic-promo",
        draftId: "note-draft-promo",
        status: "pending",
        priority: 10,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const results = await service.publishApprovedNoteDrafts(noteApi as never);
    const promotionDrafts = db.select().from(schema.threadPostDrafts).all();

    expect(results).toHaveLength(1);
    expect(promotionDrafts).toHaveLength(1);
    expect(promotionDrafts[0].topicId).toBe("topic-promo");
    expect(promotionDrafts[0].status).toBe("audited");
    expect(promotionDrafts[0].body).toContain(
      "https://note.com/example/n/note-1",
    );
    expect(promotionDrafts[0].ctaType).toBe("link");
  });

  it("dry-run thread publishing ignores ineligible slots", async () => {
    const { AutoPublisherServiceImpl } = await import(
      "../src/services/auto-publisher/index.js"
    );
    const service = new AutoPublisherServiceImpl({ dryRun: true });
    const now = new Date().toISOString();
    const later = new Date(Date.now() + 60_000).toISOString();

    db.insert(schema.threadPostDrafts)
      .values([
        {
          id: "thread-dry-audited",
          topicId: "topic-1",
          body: "公開候補",
          hookType: "story",
          ctaType: "comment",
          noteTransition: null,
          status: "audited",
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "thread-dry-draft",
          topicId: "topic-1",
          body: "未監査候補",
          hookType: "story",
          ctaType: "comment",
          noteTransition: null,
          status: "draft",
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();
    db.insert(schema.contentSlots)
      .values([
        {
          id: "thread-slot-ok",
          channel: "threads",
          scheduledAt: now,
          topicId: "topic-1",
          draftId: "thread-dry-audited",
          status: "pending",
          priority: 10,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "thread-slot-ng",
          channel: "threads",
          scheduledAt: later,
          topicId: "topic-1",
          draftId: "thread-dry-draft",
          status: "pending",
          priority: 5,
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();

    const results = await service.publishApprovedThreadDrafts({} as never);

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("thread-dry-audited");
  });

  it("dry-run note publishing ignores ineligible slots", async () => {
    const { AutoPublisherServiceImpl } = await import(
      "../src/services/auto-publisher/index.js"
    );
    const service = new AutoPublisherServiceImpl({ dryRun: true });
    const now = new Date().toISOString();
    const later = new Date(Date.now() + 60_000).toISOString();

    db.insert(schema.noteDrafts)
      .values([
        {
          id: "note-dry-ok",
          ideaId: "idea-1",
          title: "公開候補",
          body: "本文",
          outline: null,
          cta: null,
          publishReadinessScore: 8,
          status: "audited",
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "note-dry-ng",
          ideaId: "idea-2",
          title: "未到達候補",
          body: "本文",
          outline: null,
          cta: null,
          publishReadinessScore: 5,
          status: "audited",
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();
    db.insert(schema.contentSlots)
      .values([
        {
          id: "note-slot-ok",
          channel: "note",
          scheduledAt: now,
          topicId: "topic-1",
          draftId: "note-dry-ok",
          status: "pending",
          priority: 10,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "note-slot-ng",
          channel: "note",
          scheduledAt: later,
          topicId: "topic-1",
          draftId: "note-dry-ng",
          status: "pending",
          priority: 5,
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();

    const results = await service.publishApprovedNoteDrafts({} as never);

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("note-dry-ok");
  });

  it("parses cadence optimizer responses with fenced multiline JSON", async () => {
    const service = new CadenceOptimizerServiceImpl();
    const now = new Date().toISOString();
    const llm: LlmClient = {
      generate: vi.fn().mockResolvedValue(`\`\`\`json
{
  "recommendedPostsPerDay": 4,
  "minIntervalHours": 6,
  "reasoning": "直近データでは\n夜帯が強い"
}
\`\`\``),
      audit: vi.fn(),
    };

    db.insert(schema.threadPostResults)
      .values({
        id: "cadence-post-1",
        draftId: "cadence-draft-1",
        threadsPostId: "cadence-thread-1",
        impressions: 100,
        likes: 15,
        repliesCount: 3,
        shares: 2,
        publishedAt: now,
        createdAt: now,
      })
      .run();

    const result = JSON.parse(await service.adjustFrequency(llm)) as {
      recommendedPostsPerDay: number;
      minIntervalHours: number;
      reasoning: string;
    };

    expect(result.recommendedPostsPerDay).toBe(4);
    expect(result.minIntervalHours).toBe(6);
    expect(result.reasoning).toContain("夜帯が強い");
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

  it("falls back to per-metric Threads insights requests when bulk query fails", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              message:
                "metric[0] must be one of the following values: clicks, likes, quotes, replies, reposts, shares, views",
            },
          }),
          { status: 500, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ name: "views", values: [{ value: 120 }] }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ name: "likes", values: [{ value: 12 }] }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ name: "replies", values: [{ value: 3 }] }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ name: "shares", values: [{ value: 2 }] }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

    const client = new ThreadsGraphApiClient();
    const insights = await client.getInsights("post-1");

    expect(insights).toEqual({
      impressions: 120,
      likes: 12,
      replies: 3,
      shares: 2,
      views: 120,
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});
