import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../src/db/schema.js";

// Mock the db module before importing the service
vi.mock("../src/db/index.js", () => {
  const sqlite = new Database(":memory:");
  const mockDb = drizzle(sqlite, { schema });
  return { db: mockDb, __sqlite: sqlite };
});

import { db } from "../src/db/index.js";
import { memoryEntries } from "../src/db/schema.js";
import type { MemoryService } from "../src/services/memory/index.js";
import { createMemoryService } from "../src/services/memory/index.js";

type TestDb = typeof db & { $client: Database.Database };

function bootstrapTables() {
  const sqlite = (db as TestDb).$client;
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
  `);
}

describe("MemoryService", () => {
  let svc: MemoryService;

  beforeEach(() => {
    bootstrapTables();
    const sqlite = (db as TestDb).$client;
    sqlite.exec("DELETE FROM memory_entries");
    svc = createMemoryService();
  });

  it("set and get a memory entry", () => {
    svc.set("working_memory", "global", "test_key", '{"foo":"bar"}');
    const entry = svc.get("working_memory", "global", "test_key");
    expect(entry).not.toBeNull();
    expect(entry?.value).toBe('{"foo":"bar"}');
    expect(entry?.version).toBe(1);
  });

  it("updates existing entry and increments version", () => {
    svc.set("working_memory", "global", "k1", "v1");
    svc.set("working_memory", "global", "k1", "v2");
    const entry = svc.get("working_memory", "global", "k1");
    expect(entry?.value).toBe("v2");
    expect(entry?.version).toBe(2);
  });

  it("returns null for non-existent key", () => {
    const entry = svc.get("working_memory", "global", "nope");
    expect(entry).toBeNull();
  });

  it("deletes an entry", () => {
    svc.set("event_log", "threads", "e1", "data");
    svc.delete("event_log", "threads", "e1");
    expect(svc.get("event_log", "threads", "e1")).toBeNull();
  });

  it("listByLayer returns all entries in a layer", () => {
    svc.set("event_log", "threads", "a", "1");
    svc.set("event_log", "threads", "b", "2");
    svc.set("working_memory", "global", "c", "3");
    const list = svc.listByLayer("event_log");
    expect(list).toHaveLength(2);
  });

  it("listByLayer filters by scope", () => {
    svc.set("event_log", "threads", "a", "1");
    svc.set("event_log", "note", "b", "2");
    const list = svc.listByLayer("event_log", "threads");
    expect(list).toHaveLength(1);
    expect(list[0].scope).toBe("threads");
  });

  it("promote moves entry from one layer to another", () => {
    svc.set("working_memory", "global", "pk", "val");
    svc.promote("working_memory", "persistent_policy", "global", "pk");
    expect(svc.get("working_memory", "global", "pk")).toBeNull();
    const promoted = svc.get("persistent_policy", "global", "pk");
    expect(promoted).not.toBeNull();
    expect(promoted?.value).toBe("val");
  });

  it("expireWorking removes expired working_memory entries", () => {
    // Insert an already-expired entry directly
    const past = new Date(Date.now() - 60_000).toISOString();
    const now = new Date().toISOString();
    db.insert(memoryEntries)
      .values({
        id: "exp-1",
        layer: "working_memory",
        scope: "global",
        key: "expired_key",
        value: "old",
        version: 1,
        expiresAt: past,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const count = svc.expireWorking();
    expect(count).toBe(1);
    expect(svc.get("working_memory", "global", "expired_key")).toBeNull();
  });
});
