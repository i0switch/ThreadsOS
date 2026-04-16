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
  db.run(sql`DELETE FROM system_controls`);
  db.run(sql`DELETE FROM scheduled_job_runs`);
});

describe("Proposal Flow Integration", () => {
  it("creates a proposal as pending, then approves to executed", () => {
    const now = new Date().toISOString();

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
        currentStage: "executive_review",
        currentApproverId: "executive-director",
        createdAt: now,
      })
      .run();

    db.update(schema.proposals)
      .set({
        status: "approved",
        currentStage: "approved",
        currentApproverId: null,
        reviewerNote: "Executive approved",
        reviewedAt: new Date().toISOString(),
      })
      .where(sql`${schema.proposals.id} = 'proposal-1'`)
      .run();

    db.update(schema.proposals)
      .set({
        status: "executed",
        currentStage: "executed",
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
    expect(executed?.currentStage).toBe("executed");
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
        currentStage: "executive_review",
        currentApproverId: "executive-director",
        createdAt: now,
      })
      .run();

    db.update(schema.proposals)
      .set({
        status: "rejected",
        currentStage: "rejected",
        currentApproverId: null,
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
    expect(rejected?.currentStage).toBe("rejected");
  });

  it("auto-approvable actions pass safety check, high-risk do not", () => {
    const safetyService = createSafetyService();

    expect(
      safetyService.checkAutoApproval({
        type: "generate_and_post",
        priority: 2,
        reason: "thread slot available",
      }),
    ).toBe(true);

    expect(
      safetyService.checkAutoApproval({
        type: "reply_safe",
        priority: 2,
        reason: "safe replies queued",
      }),
    ).toBe(true);

    expect(
      safetyService.checkAutoApproval({
        type: "weekly_retro",
        priority: 5,
        reason: "7 days since last retro",
      }),
    ).toBe(false);
  });
});
