import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../src/db/schema.js";

vi.mock("../src/db/index.js", () => {
  const sqlite = new Database(":memory:");
  const mockDb = drizzle(sqlite, { schema });
  return { db: mockDb };
});

import { db } from "../src/db/index.js";
import {
  competitorSnapshots,
  departmentSummaries,
  improvementInsights,
  researchItems,
} from "../src/db/schema.js";
import { createMemoryService } from "../src/services/memory/index.js";
import { createRetrievalService } from "../src/services/retrieval/index.js";

function bootstrapTables() {
  const sqlite = (db as { $client: Database.Database }).$client;
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS memory_entries (
      id TEXT PRIMARY KEY NOT NULL,
      layer TEXT NOT NULL,
      scope TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS memory_entries_layer_scope_key_unique
      ON memory_entries (layer, scope, key);
    CREATE TABLE IF NOT EXISTS department_summaries (
      id TEXT PRIMARY KEY NOT NULL,
      department TEXT NOT NULL,
      summary_type TEXT NOT NULL,
      content TEXT NOT NULL,
      period_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS research_items (
      id TEXT PRIMARY KEY NOT NULL,
      topic_id TEXT NOT NULL,
      source TEXT NOT NULL,
      content TEXT NOT NULL,
      evidence_type TEXT NOT NULL,
      confidence TEXT NOT NULL,
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
    CREATE TABLE IF NOT EXISTS competitor_snapshots (
      id TEXT PRIMARY KEY NOT NULL,
      source TEXT NOT NULL,
      data TEXT NOT NULL,
      snapshot_date TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

describe("RetrievalService", () => {
  beforeEach(() => {
    bootstrapTables();
    const sqlite = (db as { $client: Database.Database }).$client;
    sqlite.exec(`
      DELETE FROM memory_entries;
      DELETE FROM department_summaries;
      DELETE FROM research_items;
      DELETE FROM improvement_insights;
      DELETE FROM competitor_snapshots;
    `);
  });

  it("builds compact context from memory and research records", () => {
    const memory = createMemoryService();
    const now = new Date().toISOString();

    memory.set(
      "department_summary",
      "threads",
      "wins",
      "朝の教育系ポストは保存率が高い",
    );

    db.insert(researchItems)
      .values({
        id: "r1",
        topicId: "t1",
        source: "web",
        content: "Threadsでは教育系の具体例が伸びる",
        evidenceType: "trend",
        confidence: "high",
        createdAt: now,
      })
      .run();
    db.insert(departmentSummaries)
      .values({
        id: "d1",
        department: "threads",
        summaryType: "daily",
        content: "保存率の高い投稿は具体例と導線がセット",
        periodKey: "2026-04-10",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(improvementInsights)
      .values({
        id: "i1",
        sourceType: "threads",
        sourceId: "post1",
        insight: "導線クリックが弱い",
        action: "3行目にnote導線を置く",
        priority: "high",
        createdAt: now,
      })
      .run();
    db.insert(competitorSnapshots)
      .values({
        id: "c1",
        source: "note_search",
        data: "教育系コンテンツが売れている",
        snapshotDate: "2026-04-10",
        createdAt: now,
      })
      .run();

    const retrieval = createRetrievalService(memory);
    const context = retrieval.buildContext("教育系 導線", {
      scope: "threads",
      limit: 4,
    });

    expect(context).toContain("教育系");
    expect(context).toContain("導線");
    expect(context).toContain("department_summary");
  });
});
