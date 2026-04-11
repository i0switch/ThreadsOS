import { sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = ":memory:";

type Db = typeof import("../src/db/index.js")["db"];
type SchemaModule = typeof import("../src/db/schema.js");

let db: Db;
let schema: SchemaModule;

beforeAll(async () => {
  const dbMod = await import("../src/db/index.js");
  db = dbMod.db;
  schema = await import("../src/db/schema.js");
  const { ensureAutonomyTables } = await import("../src/db/bootstrap.js");
  ensureAutonomyTables();
});

beforeEach(() => {
  db.run(sql`DELETE FROM strategy_history`);
});

describe("strategyHistory", () => {
  it("stores a strategy history entry", () => {
    const now = new Date().toISOString();
    db.insert(schema.strategyHistory)
      .values({
        id: "sh-1",
        cycleId: "cycle-1",
        objective: "funnel_expansion",
        funnelStage: "distribution",
        reasoning: "コンテンツ生成を優先",
        departmentInstructions: JSON.stringify({ threads: "投稿数を増やせ" }),
        stateJson: JSON.stringify({ priorityTopics: ["AI副業"] }),
        createdAt: now,
      })
      .run();

    const rows = db.select().from(schema.strategyHistory).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].objective).toBe("funnel_expansion");
    expect(rows[0].reasoning).toBe("コンテンツ生成を優先");
  });

  it("preserves history across multiple cycles", () => {
    const base = Date.now();
    for (let i = 0; i < 5; i++) {
      db.insert(schema.strategyHistory)
        .values({
          id: `sh-${i}`,
          cycleId: `cycle-${i}`,
          objective: i < 3 ? "funnel_expansion" : "engagement_compounding",
          funnelStage: "distribution",
          reasoning: `判断理由 ${i}`,
          stateJson: "{}",
          createdAt: new Date(base + i * 3600000).toISOString(),
        })
        .run();
    }

    const rows = db.select().from(schema.strategyHistory).all();
    expect(rows).toHaveLength(5);
  });
});
