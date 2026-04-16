import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../src/db/schema.js";

vi.mock("../src/db/index.js", () => {
  const sqlite = new Database(":memory:");
  const mockDb = drizzle(sqlite, { schema });
  return { db: mockDb, __sqlite: sqlite };
});

import { db } from "../src/db/index.js";
import type { DiffCollectorService } from "../src/services/diff-collector/index.js";
import { createDiffCollectorService } from "../src/services/diff-collector/index.js";

type TestDb = typeof db & { $client: Database.Database };

function bootstrapTables() {
  const sqlite = (db as TestDb).$client;
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS heartbeat_states (
      job_name TEXT PRIMARY KEY NOT NULL,
      last_run_at TEXT,
      next_notification_at TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      locked_by TEXT,
      locked_at TEXT
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
    CREATE TABLE IF NOT EXISTS thread_post_results (
      id TEXT PRIMARY KEY NOT NULL,
      draft_id TEXT NOT NULL,
      threads_post_id TEXT NOT NULL UNIQUE,
      campaign_id TEXT,
      angle_id TEXT,
      cta_id TEXT,
      canary_group TEXT,
      impressions INTEGER NOT NULL DEFAULT 0,
      likes INTEGER NOT NULL DEFAULT 0,
      replies_count INTEGER NOT NULL DEFAULT 0,
      shares INTEGER NOT NULL DEFAULT 0,
      published_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS competitor_snapshots (
      id TEXT PRIMARY KEY NOT NULL,
      source TEXT NOT NULL,
      data TEXT NOT NULL,
      snapshot_date TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scheduled_job_runs (
      id TEXT PRIMARY KEY NOT NULL,
      job_name TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      dry_run INTEGER NOT NULL DEFAULT 0,
      result_summary TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outbound_notifications (
      id TEXT PRIMARY KEY NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'file',
      sent_at TEXT NOT NULL,
      delivered_at TEXT,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS human_inputs (
      id TEXT PRIMARY KEY NOT NULL,
      input_type TEXT NOT NULL,
      content TEXT NOT NULL,
      processed INTEGER NOT NULL DEFAULT 0,
      processed_at TEXT,
      created_at TEXT NOT NULL
    );
  `);
}

describe("DiffCollectorService", () => {
  let svc: DiffCollectorService;

  beforeEach(() => {
    bootstrapTables();
    const sqlite = (db as TestDb).$client;
    sqlite.exec("DELETE FROM heartbeat_states");
    sqlite.exec("DELETE FROM thread_replies");
    sqlite.exec("DELETE FROM thread_post_results");
    sqlite.exec("DELETE FROM competitor_snapshots");
    sqlite.exec("DELETE FROM scheduled_job_runs");
    sqlite.exec("DELETE FROM outbound_notifications");
    sqlite.exec("DELETE FROM human_inputs");
    svc = createDiffCollectorService();
  });

  it("returns zeros when nothing exists", async () => {
    const diff = await svc.collectSinceLastHeartbeat();
    expect(diff).toEqual({
      newReplies: 0,
      newEngagement: 0,
      newCompetitorPosts: 0,
      newErrors: 0,
      newDirectives: 0,
      newHumanInputs: 0,
    });
  });

  it("counts new replies since last heartbeat", async () => {
    const sqlite = (db as TestDb).$client;
    const past = new Date(Date.now() - 60_000).toISOString();
    const now = new Date().toISOString();

    // Set heartbeat state in the past
    sqlite.exec(
      `INSERT INTO heartbeat_states (job_name, last_run_at) VALUES ('hourly-heartbeat', '${past}')`,
    );

    // Insert a reply after the heartbeat
    sqlite.exec(
      `INSERT INTO thread_replies (id, post_result_id, threads_reply_id, author, body, created_at) VALUES ('r1', 'pr1', 'tr1', 'user1', 'hello', '${now}')`,
    );

    const diff = await svc.collectSinceLastHeartbeat();
    expect(diff.newReplies).toBe(1);
  });

  it("counts failed jobs as errors", async () => {
    const sqlite = (db as TestDb).$client;
    const past = new Date(Date.now() - 60_000).toISOString();
    const now = new Date().toISOString();

    sqlite.exec(
      `INSERT INTO heartbeat_states (job_name, last_run_at) VALUES ('hourly-heartbeat', '${past}')`,
    );
    sqlite.exec(
      `INSERT INTO scheduled_job_runs (id, job_name, status, started_at, created_at) VALUES ('j1', 'test-job', 'failed', '${now}', '${now}')`,
    );

    const diff = await svc.collectSinceLastHeartbeat();
    expect(diff.newErrors).toBe(1);
  });

  it("counts unprocessed human inputs", async () => {
    const sqlite = (db as TestDb).$client;
    const past = new Date(Date.now() - 60_000).toISOString();
    const now = new Date().toISOString();

    sqlite.exec(
      `INSERT INTO heartbeat_states (job_name, last_run_at) VALUES ('hourly-heartbeat', '${past}')`,
    );
    sqlite.exec(
      `INSERT INTO human_inputs (id, input_type, content, processed, created_at) VALUES ('h1', 'directive', 'do something', 0, '${now}')`,
    );

    const diff = await svc.collectSinceLastHeartbeat();
    expect(diff.newHumanInputs).toBe(1);
  });
});
