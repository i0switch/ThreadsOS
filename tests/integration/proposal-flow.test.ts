import { sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = ":memory:";

type Db = typeof import("../../src/db/index.js")["db"];
type SchemaModule = typeof import("../../src/db/schema.js");
type SafetyServiceFactory =
  typeof import("../../src/services/safety/index.js")["createSafetyService"];

let db: Db;
let schema: SchemaModule;
let createSafetyService: SafetyServiceFactory;

beforeAll(async () => {
  ({ db } = await import("../../src/db/index.js"));
  schema = await import("../../src/db/schema.js");
  const { ensureAutonomyTables } = await import("../../src/db/bootstrap.js");
  ({ createSafetyService } = await import(
    "../../src/services/safety/index.js"
  ));

  ensureAutonomyTables();
});

beforeEach(() => {
  db.run(sql`DELETE FROM proposals`);
  db.run(sql`DELETE FROM human_review_items`);
  db.run(sql`DELETE FROM system_controls`);
  db.run(sql`DELETE FROM scheduled_job_runs`);
});

describe("Proposal Flow Integration", () => {
  it("creates a proposal as pending, then approves to executed", () => {
    const now = new Date().toISOString();

    // Create proposal
    db.insert(schema.proposals)
      .values({
        id: "proposal-1",
        agentId: "heartbeat",
        department: "threads",
        title: "generate_and_post requires review",
        description: "Routine post generation",
        reason: "threads slot available",
        evidence: JSON.stringify({ diff: {} }),
        expectedEffect: "Execute generate_and_post action",
        priority: "medium",
        status: "pending",
        createdAt: now,
      })
      .run();

    // Verify pending state
    const pending = db
      .select()
      .from(schema.proposals)
      .where(sql`${schema.proposals.id} = 'proposal-1'`)
      .get();
    expect(pending?.status).toBe("pending");

    // Approve the proposal
    db.update(schema.proposals)
      .set({
        status: "approved",
        reviewerNote: "Looks good",
        reviewedAt: new Date().toISOString(),
      })
      .where(sql`${schema.proposals.id} = 'proposal-1'`)
      .run();

    const approved = db
      .select()
      .from(schema.proposals)
      .where(sql`${schema.proposals.id} = 'proposal-1'`)
      .get();
    expect(approved?.status).toBe("approved");
    expect(approved?.reviewerNote).toBe("Looks good");

    // Mark as executed after running
    db.update(schema.proposals)
      .set({
        status: "executed",
        executedAt: new Date().toISOString(),
      })
      .where(sql`${schema.proposals.id} = 'proposal-1'`)
      .run();

    const executed = db
      .select()
      .from(schema.proposals)
      .where(sql`${schema.proposals.id} = 'proposal-1'`)
      .get();
    expect(executed?.status).toBe("executed");
    expect(executed?.executedAt).toBeDefined();
  });

  it("creates a proposal as pending, then rejects it", () => {
    const now = new Date().toISOString();

    db.insert(schema.proposals)
      .values({
        id: "proposal-reject-1",
        agentId: "heartbeat",
        department: "note",
        title: "weekly_retro requires review",
        description: "Weekly retrospective",
        reason: "7 days since last retro",
        evidence: JSON.stringify({ lastRetro: "2026-04-01" }),
        expectedEffect: "Run weekly retrospective analysis",
        priority: "high",
        status: "pending",
        createdAt: now,
      })
      .run();

    // Reject
    db.update(schema.proposals)
      .set({
        status: "rejected",
        reviewerNote: "Not the right time",
        reviewedAt: new Date().toISOString(),
      })
      .where(sql`${schema.proposals.id} = 'proposal-reject-1'`)
      .run();

    const rejected = db
      .select()
      .from(schema.proposals)
      .where(sql`${schema.proposals.id} = 'proposal-reject-1'`)
      .get();
    expect(rejected?.status).toBe("rejected");
    expect(rejected?.reviewerNote).toBe("Not the right time");
    expect(rejected?.executedAt).toBeNull();
  });

  it("auto-approvable actions pass safety check, high-risk do not", () => {
    const safetyService = createSafetyService();

    // Routine actions are auto-approvable
    const routineAction = {
      type: "generate_and_post" as const,
      priority: 2,
      reason: "thread slot available",
    };
    expect(safetyService.checkAutoApproval(routineAction)).toBe(true);

    const engagementAction = {
      type: "fetch_engagement" as const,
      priority: 1,
      reason: "recent posts",
    };
    expect(safetyService.checkAutoApproval(engagementAction)).toBe(true);

    const replyAction = {
      type: "reply_safe" as const,
      priority: 2,
      reason: "safe replies queued",
    };
    expect(safetyService.checkAutoApproval(replyAction)).toBe(true);

    // High-risk actions require human review
    const retroAction = {
      type: "weekly_retro" as const,
      priority: 5,
      reason: "7 days since last retro",
    };
    expect(safetyService.checkAutoApproval(retroAction)).toBe(false);
  });

  it("human_review_items flow: pending -> approved", () => {
    const now = new Date().toISOString();

    db.insert(schema.humanReviewItems)
      .values({
        id: "hr-1",
        itemType: "thread_draft",
        itemId: "draft-risky-1",
        reason: "Potential policy violation",
        status: "pending",
        createdAt: now,
      })
      .run();

    const pending = db
      .select()
      .from(schema.humanReviewItems)
      .where(sql`${schema.humanReviewItems.id} = 'hr-1'`)
      .get();
    expect(pending?.status).toBe("pending");

    // Approve
    db.update(schema.humanReviewItems)
      .set({
        status: "approved",
        reviewedAt: new Date().toISOString(),
        reviewerNote: "Content is fine after review",
      })
      .where(sql`${schema.humanReviewItems.id} = 'hr-1'`)
      .run();

    const approved = db
      .select()
      .from(schema.humanReviewItems)
      .where(sql`${schema.humanReviewItems.id} = 'hr-1'`)
      .get();
    expect(approved?.status).toBe("approved");
    expect(approved?.reviewerNote).toBe("Content is fine after review");
  });

  it("human_review_items flow: pending -> rejected", () => {
    const now = new Date().toISOString();

    db.insert(schema.humanReviewItems)
      .values({
        id: "hr-reject-1",
        itemType: "note_draft",
        itemId: "note-draft-risky-1",
        reason: "Low quality score",
        status: "pending",
        createdAt: now,
      })
      .run();

    db.update(schema.humanReviewItems)
      .set({
        status: "rejected",
        reviewedAt: new Date().toISOString(),
        reviewerNote: "Needs significant rewrite",
      })
      .where(sql`${schema.humanReviewItems.id} = 'hr-reject-1'`)
      .run();

    const rejected = db
      .select()
      .from(schema.humanReviewItems)
      .where(sql`${schema.humanReviewItems.id} = 'hr-reject-1'`)
      .get();
    expect(rejected?.status).toBe("rejected");
  });
});
