import { sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = ":memory:";

type Db = typeof import("../src/db/index.js")["db"];
type SchemaModule = typeof import("../src/db/schema.js");
type ExecutiveServiceCtor =
  typeof import("../src/services/executive/index.js")["ExecutiveServiceImpl"];

let db: Db;
let schema: SchemaModule;
let ExecutiveServiceImpl: ExecutiveServiceCtor;

beforeAll(async () => {
  ({ db } = await import("../src/db/index.js"));
  schema = await import("../src/db/schema.js");
  const { ensureAutonomyTables } = await import("../src/db/bootstrap.js");
  ({ ExecutiveServiceImpl } = await import(
    "../src/services/executive/index.js"
  ));

  ensureAutonomyTables();
});

beforeEach(() => {
  db.run(sql`DELETE FROM department_runs`);
  db.run(sql`DELETE FROM executive_cycles`);
  db.run(sql`DELETE FROM strategy_states`);
  db.run(sql`DELETE FROM improvement_insights`);
  db.run(sql`DELETE FROM reply_decisions`);
  db.run(sql`DELETE FROM note_post_results`);
  db.run(sql`DELETE FROM content_slots`);
  db.run(sql`DELETE FROM thread_post_results`);
  db.run(sql`DELETE FROM thread_post_drafts`);
  db.run(sql`DELETE FROM human_inputs`);
  db.run(sql`DELETE FROM topics`);
});

describe("ExecutiveService", () => {
  it("persists heartbeat strategy state and cycle metadata", async () => {
    const now = new Date().toISOString();
    const service = new ExecutiveServiceImpl();

    db.insert(schema.topics)
      .values({
        id: "topic-1",
        name: "勝ちテーマ",
        niche: "ビジネス",
        priorityScore: 90,
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
        hookType: "story",
        ctaType: "comment",
        noteTransition: null,
        status: "published",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(schema.threadPostResults)
      .values({
        id: "result-1",
        draftId: "draft-1",
        threadsPostId: "threads-1",
        impressions: 1000,
        likes: 120,
        repliesCount: 20,
        shares: 10,
        publishedAt: now,
        createdAt: now,
      })
      .run();
    db.insert(schema.contentSlots)
      .values({
        id: "note-slot-1",
        channel: "note",
        scheduledAt: now,
        topicId: "topic-1",
        draftId: null,
        status: "pending",
        priority: 10,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const cycle = await service.beginHeartbeatCycle([
      { type: "generate_note", priority: 1, reason: "note枠あり" },
      { type: "generate_and_post", priority: 2, reason: "threads枠あり" },
    ]);

    expect(cycle.objective).toBe("funnel_expansion");
    expect(cycle.strategy.priorityTopics).toContain("勝ちテーマ");
    expect(cycle.approvedActions).toEqual([
      { type: "generate_note", priority: 1, reason: "note枠あり" },
    ]);
    expect(cycle.skippedActions).toEqual([
      {
        action: {
          type: "generate_and_post",
          priority: 2,
          reason: "threads枠あり",
        },
        reason:
          "executive deferred threads generation in favor of note expansion",
      },
    ]);
    expect(cycle.directives.some((item) => item.department === "note")).toBe(
      true,
    );

    const strategy = db.select().from(schema.strategyStates).all();
    const executiveCycles = db.select().from(schema.executiveCycles).all();

    expect(strategy).toHaveLength(1);
    expect(executiveCycles).toHaveLength(1);
    expect(executiveCycles[0].status).toBe("running");
  });

  it("suppresses heavy generation while pending directives are being assimilated", async () => {
    const now = new Date().toISOString();
    const service = new ExecutiveServiceImpl();

    db.insert(schema.humanInputs)
      .values({
        id: "human-input-1",
        inputType: "directive",
        content: "新テーマを追加",
        processed: 0,
        createdAt: now,
        processedAt: null,
      })
      .run();

    const cycle = await service.beginHeartbeatCycle([
      { type: "process_human_inputs", priority: 1, reason: "pending inputs" },
      { type: "generate_note", priority: 2, reason: "note slot" },
      { type: "research_threads", priority: 3, reason: "stale research" },
    ]);

    expect(cycle.objective).toBe("directive_assimilation");
    expect(cycle.approvedActions).toEqual([
      {
        type: "process_human_inputs",
        priority: 1,
        reason: "pending inputs",
      },
    ]);
    expect(cycle.skippedActions).toEqual([
      {
        action: {
          type: "generate_note",
          priority: 2,
          reason: "note slot",
        },
        reason: "executive deferred while assimilating pending directives",
      },
      {
        action: {
          type: "research_threads",
          priority: 3,
          reason: "stale research",
        },
        reason: "executive deferred while assimilating pending directives",
      },
    ]);
  });

  it("prioritizes engagement work over new generation in engagement mode", async () => {
    const now = new Date().toISOString();
    const service = new ExecutiveServiceImpl();

    db.insert(schema.notePostResults)
      .values({
        id: "note-post-1",
        draftId: "draft-note-1",
        noteUrl: "https://note.com/example/n/test",
        title: "existing note",
        priceYen: null,
        publishedAt: now,
        createdAt: now,
      })
      .run();
    db.insert(schema.replyDecisions)
      .values({
        id: "reply-decision-1",
        replyId: "reply-1",
        decision: "safe_auto_reply",
        autoReplyBody: "ありがとう",
        sentAt: null,
        createdAt: now,
      })
      .run();

    const cycle = await service.beginHeartbeatCycle([
      { type: "fetch_engagement", priority: 1, reason: "recent posts" },
      { type: "reply_safe", priority: 2, reason: "safe replies queued" },
      { type: "generate_note", priority: 3, reason: "note slot" },
    ]);

    expect(cycle.objective).toBe("engagement_compounding");
    expect(cycle.approvedActions).toEqual([
      { type: "fetch_engagement", priority: 1, reason: "recent posts" },
      { type: "reply_safe", priority: 2, reason: "safe replies queued" },
    ]);
    expect(cycle.skippedActions).toEqual([
      {
        action: {
          type: "generate_note",
          priority: 3,
          reason: "note slot",
        },
        reason: "executive deferred to prioritize engagement follow-up",
      },
    ]);
  });

  it("stores department runs and completes the cycle", async () => {
    const service = new ExecutiveServiceImpl();
    const cycle = await service.beginHeartbeatCycle([]);

    await service.recordDepartmentRun({
      cycleId: cycle.cycleId,
      department: "threads",
      phase: "generate_and_post",
      status: "completed",
      summary: "Auto-published 2 threads posts",
      payload: { published: 2 },
    });
    await service.completeHeartbeatCycle(
      cycle.cycleId,
      "completed",
      "Auto-published 2 threads posts",
    );

    const departmentRuns = db.select().from(schema.departmentRuns).all();
    const cycles = db.select().from(schema.executiveCycles).all();

    expect(departmentRuns).toHaveLength(1);
    expect(departmentRuns[0].department).toBe("threads");
    expect(cycles[0].status).toBe("completed");
    expect(cycles[0].summary).toContain("Auto-published");
  });
});
