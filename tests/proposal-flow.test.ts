import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../src/db/schema.js";

vi.mock("../src/db/index.js", () => {
  const sqlite = new Database(":memory:");
  const mockDb = drizzle(sqlite, { schema });
  return { db: mockDb };
});

import { db } from "../src/db/index.js";
import { proposalEvents, proposals } from "../src/db/schema.js";
import { createProposalFlowService } from "../src/services/proposal-flow/index.js";

function bootstrapTables() {
  const sqlite = (db as { $client: Database.Database }).$client;
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY NOT NULL,
      agent_id TEXT NOT NULL,
      leader_agent_id TEXT,
      executive_agent_id TEXT,
      department TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      reason TEXT NOT NULL,
      evidence TEXT NOT NULL,
      expected_effect TEXT NOT NULL,
      risk TEXT,
      priority TEXT NOT NULL DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'pending',
      current_stage TEXT NOT NULL DEFAULT 'human_review',
      current_approver_id TEXT,
      reviewer_note TEXT,
      reviewed_at TEXT,
      executed_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS proposal_events (
      id TEXT PRIMARY KEY NOT NULL,
      proposal_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      action TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      note TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL
    );
  `);
}

describe("ProposalFlowService", () => {
  beforeEach(() => {
    bootstrapTables();
    const sqlite = (db as { $client: Database.Database }).$client;
    sqlite.exec("DELETE FROM proposal_events; DELETE FROM proposals;");
  });

  it("creates hierarchical proposal history and moves to approved", () => {
    const service = createProposalFlowService();
    const proposalId = service.createHierarchicalProposal({
      agentId: "threads-post-generator",
      leaderAgentId: "threads-operations-director",
      executiveAgentId: "executive-director",
      department: "threads",
      title: "投稿頻度を上げる",
      description: "勝ちパターンを追加投入する",
      reason: "CV改善が見込める",
      evidence: '{"kpi":1}',
      expectedEffect: "投稿数増加",
      priority: "high",
    });

    service.approveProposal(proposalId, "dashboard-human", "実行してよい");

    const proposal = db
      .select()
      .from(proposals)
      .where(eq(proposals.id, proposalId))
      .get();
    const history = db
      .select()
      .from(proposalEvents)
      .where(eq(proposalEvents.proposalId, proposalId))
      .all();

    expect(proposal?.status).toBe("approved");
    expect(proposal?.currentStage).toBe("approved");
    expect(history).toHaveLength(5);
    expect(history.at(-1)?.action).toBe("approved");
  });
});
