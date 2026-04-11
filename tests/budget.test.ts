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
import type { BudgetService } from "../src/services/budget/index.js";
import { createBudgetService } from "../src/services/budget/index.js";

type TestDb = typeof db & { $client: Database.Database };

function bootstrapTables() {
  const sqlite = (db as TestDb).$client;
  sqlite.exec(`
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

    CREATE UNIQUE INDEX IF NOT EXISTS budget_tracking_scope_period_key_unique
    ON budget_tracking (scope, period, period_key);
  `);
}

describe("BudgetService", () => {
  let svc: BudgetService;

  beforeEach(() => {
    bootstrapTables();
    const sqlite = (db as TestDb).$client;
    sqlite.exec("DELETE FROM budget_tracking");
    svc = createBudgetService();
  });

  it("initBudget creates a budget entry", () => {
    svc.initBudget("heartbeat-1", "heartbeat", "2026-04-08T12", 10000, 50);
    const remaining = svc.getRemainingBudget("heartbeat-1");
    expect(remaining.tokens).toBe(10000);
    expect(remaining.calls).toBe(50);
  });

  it("canSpend returns true within budget", () => {
    svc.initBudget("scope-a", "daily", "2026-04-08", 5000, 20);
    expect(svc.canSpend("scope-a", 1000, 5)).toBe(true);
  });

  it("canSpend returns false when exceeding budget", () => {
    svc.initBudget("scope-b", "daily", "2026-04-08", 5000, 20);
    expect(svc.canSpend("scope-b", 6000, 1)).toBe(false);
    expect(svc.canSpend("scope-b", 100, 21)).toBe(false);
  });

  it("canSpend returns false for unknown scope", () => {
    expect(svc.canSpend("nope", 1, 1)).toBe(false);
  });

  it("spend deducts tokens and calls", () => {
    svc.initBudget("scope-c", "heartbeat", "hb1", 10000, 100);
    svc.spend("scope-c", 3000, 10);
    const remaining = svc.getRemainingBudget("scope-c");
    expect(remaining.tokens).toBe(7000);
    expect(remaining.calls).toBe(90);
  });

  it("spend throws for unknown scope", () => {
    expect(() => svc.spend("nope", 1, 1)).toThrow("No budget found");
  });

  it("resetPeriod zeros out usage", () => {
    svc.initBudget("scope-d", "daily", "2026-04-08", 5000, 20);
    svc.spend("scope-d", 2000, 10);
    svc.resetPeriod("scope-d", "daily");
    const remaining = svc.getRemainingBudget("scope-d");
    expect(remaining.tokens).toBe(5000);
    expect(remaining.calls).toBe(20);
  });

  it("getRemainingBudget returns zero for unknown scope", () => {
    const remaining = svc.getRemainingBudget("unknown");
    expect(remaining).toEqual({ tokens: 0, calls: 0 });
  });

  it("initBudget is idempotent for the same scope-period-periodKey", () => {
    svc.initBudget("scope-e", "heartbeat", "hb-1", 1000, 5);
    svc.spend("scope-e", 200, 1);
    svc.initBudget("scope-e", "heartbeat", "hb-1", 3000, 10);

    const remaining = svc.getRemainingBudget("scope-e");
    expect(remaining).toEqual({ tokens: 2800, calls: 9 });
  });
});
