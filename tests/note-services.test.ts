import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../src/db/schema.js";

vi.mock("../src/db/index.js", () => {
  const sqlite = new Database(":memory:");
  const mockDb = drizzle(sqlite, { schema });
  return { db: mockDb, __sqlite: sqlite };
});

import { db } from "../src/db/index.js";
import { AutoPublisherServiceImpl } from "../src/services/auto-publisher/index.js";
import { NoteEngagementAnalysisServiceImpl } from "../src/services/note-engagement-analysis/index.js";

type TestDb = typeof db & { $client: Database.Database };

function bootstrapTables() {
  const sqlite = (db as TestDb).$client;
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS content_slots (
      id TEXT PRIMARY KEY NOT NULL,
      channel TEXT NOT NULL,
      scheduled_at TEXT NOT NULL,
      topic_id TEXT,
      draft_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      priority INTEGER NOT NULL DEFAULT 5,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS note_ideas (
      id TEXT PRIMARY KEY NOT NULL,
      source_topic_id TEXT,
      angle TEXT NOT NULL,
      target_reader TEXT NOT NULL,
      priority_score INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'idea',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS note_drafts (
      id TEXT PRIMARY KEY NOT NULL,
      idea_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      outline TEXT,
      cta TEXT,
      publish_readiness_score REAL,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS note_post_results (
      id TEXT PRIMARY KEY NOT NULL,
      draft_id TEXT NOT NULL,
      title TEXT,
      note_url TEXT,
      price_yen INTEGER,
      views INTEGER NOT NULL DEFAULT 0,
      likes INTEGER NOT NULL DEFAULT 0,
      comments_count INTEGER NOT NULL DEFAULT 0,
      purchases_count INTEGER NOT NULL DEFAULT 0,
      revenue_yen INTEGER NOT NULL DEFAULT 0,
      conversion_rate REAL NOT NULL DEFAULT 0,
      traffic_source TEXT,
      published_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS thread_post_drafts (
      id TEXT PRIMARY KEY NOT NULL,
      topic_id TEXT NOT NULL,
      body TEXT NOT NULL,
      hook_type TEXT NOT NULL,
      cta_type TEXT NOT NULL,
      note_transition TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS thread_post_results (
      id TEXT PRIMARY KEY NOT NULL,
      draft_id TEXT NOT NULL,
      threads_post_id TEXT NOT NULL UNIQUE,
      impressions INTEGER NOT NULL DEFAULT 0,
      likes INTEGER NOT NULL DEFAULT 0,
      replies_count INTEGER NOT NULL DEFAULT 0,
      shares INTEGER NOT NULL DEFAULT 0,
      published_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS thread_replies (
      id TEXT PRIMARY KEY NOT NULL,
      post_result_id TEXT NOT NULL,
      threads_reply_id TEXT NOT NULL,
      author TEXT NOT NULL,
      body TEXT NOT NULL,
      sentiment TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reply_decisions (
      id TEXT PRIMARY KEY NOT NULL,
      reply_id TEXT NOT NULL,
      decision TEXT NOT NULL,
      auto_reply_body TEXT,
      sent_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS channel_performance_snapshots (
      id TEXT PRIMARY KEY NOT NULL,
      channel TEXT NOT NULL,
      period_type TEXT NOT NULL,
      period_key TEXT NOT NULL,
      metrics TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS improvement_insights (
      id TEXT PRIMARY KEY NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      insight TEXT NOT NULL,
      action TEXT NOT NULL,
      priority TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

function clearTables() {
  const sqlite = (db as TestDb).$client;
  sqlite.exec(`
    DELETE FROM content_slots;
    DELETE FROM note_ideas;
    DELETE FROM note_drafts;
    DELETE FROM note_post_results;
    DELETE FROM thread_post_drafts;
    DELETE FROM thread_post_results;
    DELETE FROM thread_replies;
    DELETE FROM reply_decisions;
    DELETE FROM channel_performance_snapshots;
    DELETE FROM improvement_insights;
  `);
}

function seedPublishableNoteDraft(overrides?: {
  ideaId?: string;
  sourceTopicId?: string;
  title?: string;
  body?: string;
}) {
  const now = new Date().toISOString();
  const ideaId = overrides?.ideaId ?? "idea-1";
  const draftId = "draft-1";
  const slotId = "slot-1";

  db.insert(schema.noteIdeas)
    .values({
      id: ideaId,
      sourceTopicId: overrides?.sourceTopicId ?? "topic-1",
      angle: "勝ち筋のテーマ",
      targetReader: "購買意欲の高い読者",
      priorityScore: 80,
      status: "drafted",
      createdAt: now,
    })
    .run();

  db.insert(schema.noteDrafts)
    .values({
      id: draftId,
      ideaId,
      title: overrides?.title ?? "売れるnoteの作り方",
      body: overrides?.body ?? "A".repeat(6200),
      outline: "outline",
      cta: "cta",
      publishReadinessScore: 8.5,
      status: "audited",
      createdAt: now,
      updatedAt: now,
    })
    .run();

  db.insert(schema.contentSlots)
    .values({
      id: slotId,
      channel: "note",
      scheduledAt: new Date(Date.now() - 60_000).toISOString(),
      topicId: "topic-1",
      draftId,
      status: "pending",
      priority: 10,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  return { ideaId, draftId, slotId };
}

describe("note publish services", () => {
  beforeEach(() => {
    bootstrapTables();
    clearTables();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prices note higher when historical CV and purchases are strong", async () => {
    const now = new Date().toISOString();
    seedPublishableNoteDraft();

    db.insert(schema.noteIdeas)
      .values({
        id: "idea-hist",
        sourceTopicId: "topic-1",
        angle: "勝ち筋のテーマ",
        targetReader: "既存読者",
        priorityScore: 70,
        status: "published",
        createdAt: now,
      })
      .run();
    db.insert(schema.noteDrafts)
      .values({
        id: "draft-hist",
        ideaId: "idea-hist",
        title: "過去の勝ち記事",
        body: "B".repeat(5000),
        outline: "outline",
        cta: "cta",
        publishReadinessScore: 9,
        status: "published",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(schema.notePostResults)
      .values({
        id: "result-hist",
        draftId: "draft-hist",
        title: "過去の勝ち記事",
        noteUrl: "https://note.com/example/n/hist",
        priceYen: 980,
        views: 120,
        likes: 30,
        commentsCount: 5,
        purchasesCount: 8,
        revenueYen: 7840,
        conversionRate: 8 / 120,
        trafficSource: "threads",
        publishedAt: now,
        createdAt: now,
      })
      .run();

    const noteApi = {
      publishArticle: vi.fn().mockResolvedValue({
        noteId: "note-1",
        url: "https://note.com/example/n/note-1",
      }),
    } as const;

    const service = new AutoPublisherServiceImpl();
    const results = await service.publishApprovedNoteDrafts(
      noteApi as unknown as never,
    );

    expect(results).toHaveLength(1);
    const saved = db.select().from(schema.notePostResults).all();
    const published = saved.find((row) => row.draftId === "draft-1");
    expect(published?.priceYen).toBe(1480);
    expect(published?.trafficSource).toContain("strategy=optimized");
  });

  it("stores sync-pending compensation record when local sync fails after remote publish", async () => {
    seedPublishableNoteDraft({
      title: "補償テスト記事",
      body: "C".repeat(5200),
    });

    const noteApi = {
      publishArticle: vi.fn().mockResolvedValue({
        noteId: "note-compensated",
        url: "https://note.com/example/n/compensated",
      }),
    } as const;

    vi.spyOn(db, "transaction").mockImplementationOnce(() => {
      throw new Error("local transaction failed");
    });

    const service = new AutoPublisherServiceImpl();
    const results = await service.publishApprovedNoteDrafts(
      noteApi as unknown as never,
    );

    expect(results).toHaveLength(1);
    const compensation = db
      .select()
      .from(schema.notePostResults)
      .where(
        eq(
          schema.notePostResults.noteUrl,
          "https://note.com/example/n/compensated",
        ),
      )
      .get();
    const slot = db
      .select()
      .from(schema.contentSlots)
      .where(eq(schema.contentSlots.id, "slot-1"))
      .get();
    const draft = db
      .select()
      .from(schema.noteDrafts)
      .where(eq(schema.noteDrafts.id, "draft-1"))
      .get();

    expect(compensation?.trafficSource).toContain("status=sync_pending");
    expect(compensation?.trafficSource).toContain("noteId=note-compensated");
    expect(slot?.status).toBe("published");
    expect(draft?.status).toBe("audited");
  });

  it("reconciles sync-pending note rows and restores published state from fetched stats", async () => {
    const now = new Date().toISOString();
    db.insert(schema.noteIdeas)
      .values({
        id: "idea-sync",
        sourceTopicId: "topic-9",
        angle: "再同期テーマ",
        targetReader: "読者",
        priorityScore: 60,
        status: "drafted",
        createdAt: now,
      })
      .run();
    db.insert(schema.noteDrafts)
      .values({
        id: "draft-sync",
        ideaId: "idea-sync",
        title: "再同期テスト",
        body: "D".repeat(4000),
        outline: "outline",
        cta: "cta",
        publishReadinessScore: 8,
        status: "audited",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(schema.notePostResults)
      .values({
        id: "result-sync",
        draftId: "draft-sync",
        title: "再同期テスト",
        noteUrl: "https://note.com/example/n/recovered",
        priceYen: 980,
        views: 0,
        likes: 0,
        commentsCount: 0,
        purchasesCount: 0,
        revenueYen: 0,
        conversionRate: 0,
        trafficSource: "threads|status=sync_pending|noteId=note-sync",
        publishedAt: now,
        createdAt: now,
      })
      .run();

    const noteApi = {
      getMyArticles: vi.fn().mockResolvedValue([
        {
          id: "note-sync",
          title: "再同期テスト",
          url: "https://note.com/example/n/recovered",
          views: 100,
          likes: 12,
          comments: 2,
        },
      ]),
      getArticleStats: vi.fn().mockResolvedValue({
        views: 100,
        likes: 12,
        comments: 2,
        priceYen: 980,
        purchasesCount: 2,
      }),
    } as const;

    const service = new NoteEngagementAnalysisServiceImpl();
    const stored = await service.fetchAndStoreNoteResults(
      noteApi as unknown as never,
    );

    expect(stored).toBe(1);
    const recovered = db
      .select()
      .from(schema.notePostResults)
      .where(eq(schema.notePostResults.id, "result-sync"))
      .get();
    const draft = db
      .select()
      .from(schema.noteDrafts)
      .where(eq(schema.noteDrafts.id, "draft-sync"))
      .get();
    const idea = db
      .select()
      .from(schema.noteIdeas)
      .where(eq(schema.noteIdeas.id, "idea-sync"))
      .get();

    expect(recovered?.trafficSource).toContain("status=recovered_sync");
    expect(recovered?.revenueYen).toBe(1960);
    expect(recovered?.conversionRate).toBe(0.02);
    expect(draft?.status).toBe("published");
    expect(idea?.status).toBe("published");
  });
});
