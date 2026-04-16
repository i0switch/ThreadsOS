import { randomUUID } from "node:crypto";
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
import type { ScheduledAction } from "../src/services/content-scheduler/index.js";
import type { SafetyService } from "../src/services/safety/index.js";
import { createSafetyService } from "../src/services/safety/index.js";

type TestDb = typeof db & { $client: Database.Database };

function bootstrapTables() {
  const sqlite = (db as TestDb).$client;
  sqlite.exec(`
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

    CREATE TABLE IF NOT EXISTS thread_post_drafts (
      id TEXT PRIMARY KEY NOT NULL,
      topic_id TEXT NOT NULL,
      body TEXT NOT NULL,
      hook_type TEXT NOT NULL,
      cta_type TEXT NOT NULL,
      note_transition TEXT,
      campaign_id TEXT,
      angle_id TEXT,
      cta_id TEXT,
      canary_group TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
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

    CREATE TABLE IF NOT EXISTS budget_tracking (
      id TEXT PRIMARY KEY NOT NULL,
      scope TEXT NOT NULL,
      period TEXT NOT NULL,
      period_key TEXT NOT NULL,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      calls_used INTEGER NOT NULL DEFAULT 0,
      tokens_limit INTEGER NOT NULL,
      calls_limit INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function clearTables() {
  const sqlite = (db as TestDb).$client;
  sqlite.exec("DELETE FROM thread_post_results");
  sqlite.exec("DELETE FROM thread_post_drafts");
  sqlite.exec("DELETE FROM scheduled_job_runs");
  sqlite.exec("DELETE FROM budget_tracking");
}

describe("SafetyService", () => {
  let svc: SafetyService;

  beforeEach(() => {
    bootstrapTables();
    clearTables();
    svc = createSafetyService();
  });

  describe("checkDuplicatePost", () => {
    it("returns false when no recent posts exist", () => {
      expect(svc.checkDuplicatePost("Hello world")).toBe(false);
    });

    it("returns true for exact duplicate within 24h", () => {
      const now = new Date();
      const draftId = randomUUID();
      db.insert(schema.threadPostDrafts)
        .values({
          id: draftId,
          topicId: "topic-1",
          body: "Hello world test post",
          hookType: "question",
          ctaType: "none",
          status: "published",
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        })
        .run();

      db.insert(schema.threadPostResults)
        .values({
          id: randomUUID(),
          draftId,
          threadsPostId: `post-${randomUUID()}`,
          publishedAt: now.toISOString(),
          createdAt: now.toISOString(),
        })
        .run();

      expect(svc.checkDuplicatePost("Hello world test post")).toBe(true);
    });

    it("returns true for near-duplicate (high similarity)", () => {
      const now = new Date();
      const draftId = randomUUID();
      db.insert(schema.threadPostDrafts)
        .values({
          id: draftId,
          topicId: "topic-1",
          body: "This is a very specific post about TypeScript programming best practices",
          hookType: "question",
          ctaType: "none",
          status: "published",
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        })
        .run();

      db.insert(schema.threadPostResults)
        .values({
          id: randomUUID(),
          draftId,
          threadsPostId: `post-${randomUUID()}`,
          publishedAt: now.toISOString(),
          createdAt: now.toISOString(),
        })
        .run();

      // Very similar with minor difference
      expect(
        svc.checkDuplicatePost(
          "This is a very specific post about TypeScript programming best practice",
        ),
      ).toBe(true);
    });

    it("returns false for dissimilar posts", () => {
      const now = new Date();
      const draftId = randomUUID();
      db.insert(schema.threadPostDrafts)
        .values({
          id: draftId,
          topicId: "topic-1",
          body: "Hello world test post about JavaScript",
          hookType: "question",
          ctaType: "none",
          status: "published",
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        })
        .run();

      db.insert(schema.threadPostResults)
        .values({
          id: randomUUID(),
          draftId,
          threadsPostId: `post-${randomUUID()}`,
          publishedAt: now.toISOString(),
          createdAt: now.toISOString(),
        })
        .run();

      expect(
        svc.checkDuplicatePost(
          "Completely different topic about cooking and recipes",
        ),
      ).toBe(false);
    });
  });

  describe("checkAutoApproval", () => {
    it("returns true for routine actions", () => {
      const routineTypes = [
        "generate_and_post",
        "generate_note",
        "fetch_engagement",
        "reply_safe",
        "optimize_schedule",
        "notify",
      ] as const;

      for (const type of routineTypes) {
        const action: ScheduledAction = { type, priority: 5, reason: "test" };
        expect(svc.checkAutoApproval(action)).toBe(true);
      }
    });

    it("returns false for weekly_retro (requires review)", () => {
      const action: ScheduledAction = {
        type: "weekly_retro",
        priority: 5,
        reason: "test",
      };
      expect(svc.checkAutoApproval(action)).toBe(false);
    });
  });

  describe("checkCostDegradation", () => {
    it("returns normal when no budgets exist", () => {
      expect(svc.checkCostDegradation()).toBe("normal");
    });

    it("returns normal when usage is low", () => {
      const now = new Date().toISOString();
      db.insert(schema.budgetTracking)
        .values({
          id: randomUUID(),
          scope: "global",
          period: "heartbeat",
          periodKey: "hb-test",
          tokensUsed: 1000,
          callsUsed: 2,
          tokensLimit: 50000,
          callsLimit: 30,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      expect(svc.checkCostDegradation()).toBe("normal");
    });

    it("returns degraded when usage exceeds 80%", () => {
      const now = new Date().toISOString();
      db.insert(schema.budgetTracking)
        .values({
          id: randomUUID(),
          scope: "global",
          period: "heartbeat",
          periodKey: "hb-test",
          tokensUsed: 42000,
          callsUsed: 5,
          tokensLimit: 50000,
          callsLimit: 30,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      expect(svc.checkCostDegradation()).toBe("degraded");
    });

    it("returns emergency when usage exceeds 95%", () => {
      const now = new Date().toISOString();
      db.insert(schema.budgetTracking)
        .values({
          id: randomUUID(),
          scope: "global",
          period: "heartbeat",
          periodKey: "hb-test",
          tokensUsed: 48000,
          callsUsed: 29,
          tokensLimit: 50000,
          callsLimit: 30,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      expect(svc.checkCostDegradation()).toBe("emergency");
    });

    it("returns emergency when calls exceed 95%", () => {
      const now = new Date().toISOString();
      db.insert(schema.budgetTracking)
        .values({
          id: randomUUID(),
          scope: "test",
          period: "heartbeat",
          periodKey: "hb-test",
          tokensUsed: 100,
          callsUsed: 29,
          tokensLimit: 50000,
          callsLimit: 30,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      expect(svc.checkCostDegradation()).toBe("emergency");
    });
  });

  describe("shouldForceStop", () => {
    it("returns false when fewer than 5 runs exist", () => {
      const now = new Date();
      for (let i = 0; i < 3; i++) {
        db.insert(schema.scheduledJobRuns)
          .values({
            id: randomUUID(),
            jobName: "hourly-heartbeat",
            status: "failed",
            startedAt: new Date(now.getTime() - i * 60000).toISOString(),
            createdAt: new Date(now.getTime() - i * 60000).toISOString(),
          })
          .run();
      }
      expect(svc.shouldForceStop()).toBe(false);
    });

    it("returns true when last 5 runs all failed", () => {
      const now = new Date();
      for (let i = 0; i < 5; i++) {
        db.insert(schema.scheduledJobRuns)
          .values({
            id: randomUUID(),
            jobName: "hourly-heartbeat",
            status: "failed",
            startedAt: new Date(now.getTime() - i * 60000).toISOString(),
            createdAt: new Date(now.getTime() - i * 60000).toISOString(),
          })
          .run();
      }
      expect(svc.shouldForceStop()).toBe(true);
    });

    it("returns false when one of last 5 runs succeeded", () => {
      const now = new Date();
      for (let i = 0; i < 5; i++) {
        db.insert(schema.scheduledJobRuns)
          .values({
            id: randomUUID(),
            jobName: "hourly-heartbeat",
            status: i === 2 ? "completed" : "failed",
            startedAt: new Date(now.getTime() - i * 60000).toISOString(),
            createdAt: new Date(now.getTime() - i * 60000).toISOString(),
          })
          .run();
      }
      expect(svc.shouldForceStop()).toBe(false);
    });

    it("ignores failures from other job types", () => {
      const now = new Date();
      for (let i = 0; i < 5; i++) {
        db.insert(schema.scheduledJobRuns)
          .values({
            id: randomUUID(),
            jobName: "nightly-note-pipeline",
            status: "failed",
            startedAt: new Date(now.getTime() - i * 60000).toISOString(),
            createdAt: new Date(now.getTime() - i * 60000).toISOString(),
          })
          .run();
      }
      expect(svc.shouldForceStop()).toBe(false);
    });
  });
});
