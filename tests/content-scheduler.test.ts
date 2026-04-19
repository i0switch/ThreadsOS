import { sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = ":memory:";

type Db = typeof import("../src/db/index.js")["db"];
type SchemaModule = typeof import("../src/db/schema.js");
type ContentSchedulerCtor =
  typeof import("../src/services/content-scheduler/index.js")["ContentSchedulerServiceImpl"];

let db: Db;
let schema: SchemaModule;
let ContentSchedulerServiceImpl: ContentSchedulerCtor;

beforeAll(async () => {
  ({ db } = await import("../src/db/index.js"));
  schema = await import("../src/db/schema.js");
  const { ensureAutonomyTables } = await import("../src/db/bootstrap.js");
  ({ ContentSchedulerServiceImpl } = await import(
    "../src/services/content-scheduler/index.js"
  ));
  ensureAutonomyTables();
});

beforeEach(() => {
  db.run(sql`DELETE FROM strategy_states`);
  db.run(sql`DELETE FROM content_slots`);
  db.run(sql`DELETE FROM reply_decisions`);
  db.run(sql`DELETE FROM thread_post_results`);
  db.run(sql`DELETE FROM scheduled_job_runs`);
  db.run(sql`DELETE FROM note_post_results`);
  db.run(sql`DELETE FROM thread_post_drafts`);
  db.run(sql`DELETE FROM topics`);
  db.run(sql`DELETE FROM human_inputs`);
});

describe("ContentSchedulerService", () => {
  it("releases only one pending note slot immediately without colliding unique timestamps", async () => {
    const now = new Date();
    const firstSlotTime = new Date(
      now.getTime() + 60 * 60 * 1000,
    ).toISOString();
    const secondSlotTime = new Date(
      now.getTime() + 2 * 60 * 60 * 1000,
    ).toISOString();
    const scheduler = new ContentSchedulerServiceImpl();

    db.insert(schema.contentSlots)
      .values([
        {
          id: "note-slot-force-1",
          channel: "note",
          scheduledAt: firstSlotTime,
          topicId: null,
          draftId: "note-draft-1",
          status: "pending",
          priority: 5,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        },
        {
          id: "note-slot-force-2",
          channel: "note",
          scheduledAt: secondSlotTime,
          topicId: null,
          draftId: "note-draft-2",
          status: "pending",
          priority: 4,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        },
      ])
      .run();

    await expect(
      scheduler.releaseNextPendingNoteSlotForImmediatePublish(),
    ).resolves.not.toThrow();

    const slots = db
      .select()
      .from(schema.contentSlots)
      .where(
        sql`${schema.contentSlots.channel} = 'note' AND ${schema.contentSlots.status} = 'pending'`,
      )
      .all()
      .sort((left, right) => left.id.localeCompare(right.id));

    expect(slots).toHaveLength(2);
    expect(new Date(slots[0].scheduledAt).getTime()).toBeLessThanOrEqual(
      Date.now(),
    );
    expect(slots[1].scheduledAt).toBe(secondSlotTime);
  });

  it("bootstraps note generation when no note posts or slots exist", async () => {
    const now = new Date().toISOString();
    const scheduler = new ContentSchedulerServiceImpl();

    db.insert(schema.strategyStates)
      .values({
        key: "heartbeat:global",
        scope: "heartbeat",
        stateJson: JSON.stringify({
          objective: "funnel_expansion",
          funnelStage: "bootstrap",
        }),
        summary: "funnel_expansion:bootstrap",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(schema.scheduledJobRuns)
      .values({
        id: "note-job-1",
        jobName: "nightly-note-pipeline",
        status: "completed",
        startedAt: now,
        finishedAt: now,
        dryRun: 0,
        resultSummary: "Generated 1 note draft.",
        createdAt: now,
      })
      .run();

    const actions = await scheduler.decideActions();
    const noteAction = actions.find(
      (action) => action.type === "generate_note",
    );

    expect(noteAction).toBeTruthy();
    expect(noteAction?.reason).toContain("ブートストラップ");
  });

  it("prioritizes note generation under funnel expansion strategy", async () => {
    const now = new Date().toISOString();
    const scheduler = new ContentSchedulerServiceImpl();

    db.insert(schema.strategyStates)
      .values({
        key: "heartbeat:global",
        scope: "heartbeat",
        stateJson: JSON.stringify({
          objective: "funnel_expansion",
          funnelStage: "conversion",
        }),
        summary: "funnel_expansion:conversion",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(schema.contentSlots)
      .values({
        id: "note-slot-1",
        channel: "note",
        scheduledAt: now,
        topicId: null,
        draftId: null,
        status: "pending",
        priority: 5,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(schema.threadPostResults)
      .values({
        id: "post-result-1",
        draftId: "draft-1",
        threadsPostId: "threads-post-1",
        impressions: 100,
        likes: 10,
        repliesCount: 2,
        shares: 1,
        publishedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        createdAt: now,
      })
      .run();

    const actions = await scheduler.decideActions();
    const noteIndex = actions.findIndex(
      (action) => action.type === "generate_note",
    );
    const engagementIndex = actions.findIndex(
      (action) => action.type === "fetch_engagement",
    );

    expect(noteIndex).toBeGreaterThanOrEqual(0);
    expect(engagementIndex).toBeGreaterThanOrEqual(0);
    expect(noteIndex).toBeLessThan(engagementIndex);
    expect(actions[noteIndex]?.reason).toContain(
      "strategy:funnel_expansion/conversion",
    );
  });

  it("prioritizes engagement followup under engagement compounding strategy", async () => {
    const now = new Date().toISOString();
    const scheduler = new ContentSchedulerServiceImpl();

    db.insert(schema.strategyStates)
      .values({
        key: "heartbeat:global",
        scope: "heartbeat",
        stateJson: JSON.stringify({
          objective: "engagement_compounding",
          funnelStage: "optimization",
        }),
        summary: "engagement_compounding:optimization",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(schema.replyDecisions)
      .values({
        id: "reply-decision-1",
        replyId: "reply-1",
        decision: "safe_auto_reply",
        autoReplyBody: "thanks",
        sentAt: null,
        createdAt: now,
      })
      .run();
    db.insert(schema.threadPostResults)
      .values({
        id: "post-result-2",
        draftId: "draft-2",
        threadsPostId: "threads-post-2",
        impressions: 200,
        likes: 20,
        repliesCount: 3,
        shares: 2,
        publishedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
        createdAt: now,
      })
      .run();
    db.insert(schema.contentSlots)
      .values({
        id: "note-slot-2",
        channel: "note",
        scheduledAt: now,
        topicId: null,
        draftId: null,
        status: "pending",
        priority: 5,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const actions = await scheduler.decideActions();
    const engagementIndex = actions.findIndex(
      (action) => action.type === "fetch_engagement",
    );
    const noteIndex = actions.findIndex(
      (action) => action.type === "generate_note",
    );

    expect(engagementIndex).toBeGreaterThanOrEqual(0);
    expect(noteIndex).toBeGreaterThanOrEqual(0);
    expect(engagementIndex).toBeLessThan(noteIndex);
  });
});
