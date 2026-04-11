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
import { createCacheService } from "../src/services/cache/index.js";
import { createMemoryService } from "../src/services/memory/index.js";

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
  `);
}

describe("CacheService", () => {
  beforeEach(() => {
    bootstrapTables();
    const sqlite = (db as { $client: Database.Database }).$client;
    sqlite.exec("DELETE FROM memory_entries");
  });

  it("reuses cached JSON without rerunning the factory", async () => {
    const cache = createCacheService(createMemoryService());
    let calls = 0;

    const first = await cache.rememberJson(
      "web-search",
      "foo",
      3600,
      async () => {
        calls += 1;
        return [{ title: "A" }];
      },
    );
    const second = await cache.rememberJson(
      "web-search",
      "foo",
      3600,
      async () => {
        calls += 1;
        return [{ title: "B" }];
      },
    );

    expect(first).toEqual([{ title: "A" }]);
    expect(second).toEqual([{ title: "A" }]);
    expect(calls).toBe(1);
  });

  it("drops expired cache entries", () => {
    const cache = createCacheService(createMemoryService());
    cache.setJson("web-search", "expired", { ok: true }, -1);

    expect(cache.getJson("web-search", "expired")).toBeNull();
  });
});
