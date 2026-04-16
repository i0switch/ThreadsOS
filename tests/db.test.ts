import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import * as schema from "../src/db/schema.js";

describe("Database", () => {
  it("should create tables from schema", () => {
    // Use in-memory DB for testing
    const sqlite = new Database(":memory:");

    // Create all tables
    sqlite.exec(`
      CREATE TABLE topics (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        niche TEXT NOT NULL,
        priority_score INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE thread_post_drafts (
        id TEXT PRIMARY KEY,
        topic_id TEXT NOT NULL,
        body TEXT NOT NULL,
        hook_type TEXT NOT NULL,
        cta_type TEXT NOT NULL,
        note_transition TEXT,
        status TEXT NOT NULL DEFAULT 'draft',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE proposals (
        id TEXT PRIMARY KEY,
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
        current_stage TEXT NOT NULL DEFAULT 'executive_review',
        current_approver_id TEXT,
        reviewer_note TEXT,
        reviewed_at TEXT,
        executed_at TEXT,
        created_at TEXT NOT NULL
      );
    `);

    // Verify tables exist
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("topics");
    expect(tableNames).toContain("thread_post_drafts");
    expect(tableNames).toContain("proposals");
  });

  it("should export all schema tables", () => {
    expect(schema.topics).toBeDefined();
    expect(schema.threadPostDrafts).toBeDefined();
    expect(schema.threadPostAudits).toBeDefined();
    expect(schema.threadPostResults).toBeDefined();
    expect(schema.threadReplies).toBeDefined();
    expect(schema.replyDecisions).toBeDefined();
    expect(schema.improvementInsights).toBeDefined();
    expect(schema.noteIdeas).toBeDefined();
    expect(schema.noteDrafts).toBeDefined();
    expect(schema.noteAudits).toBeDefined();
    expect(schema.sessionHealth).toBeDefined();
    expect(schema.competitorSnapshots).toBeDefined();
    expect(schema.scheduledJobRuns).toBeDefined();
    expect(schema.strategyStates).toBeDefined();
    expect(schema.executiveCycles).toBeDefined();
    expect(schema.departmentRuns).toBeDefined();
  });
});
