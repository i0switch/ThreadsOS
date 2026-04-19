import { sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = ":memory:";

type BuildServer = typeof import("../../src/server/app.js")["buildServer"];
type Db = typeof import("../../src/db/index.js")["db"];
type SchemaModule = typeof import("../../src/db/schema.js");

let buildServer: BuildServer;
let db: Db;
let schema: SchemaModule;

const now = new Date().toISOString();

beforeAll(async () => {
  ({ db } = await import("../../src/db/index.js"));
  schema = await import("../../src/db/schema.js");
  const { ensureAutonomyTables } = await import("../../src/db/bootstrap.js");
  ({ buildServer } = await import("../../src/server/app.js"));
  ensureAutonomyTables();
});

beforeEach(() => {
  db.run(sql`DELETE FROM runner_budget`);
  db.run(sql`DELETE FROM runner_health`);

  db.insert(schema.runnerHealth)
    .values({
      runner: "claude",
      status: "healthy",
      consecutiveFailures: 0,
      timeoutCount: 0,
      invalidJsonCount: 0,
      totalCalls: 4,
      lastModel: "claude-sonnet",
      lastError: null,
      lastDurationMs: 2100,
      lastSuccessAt: now,
      lastFailureAt: null,
      updatedAt: now,
    })
    .run();

  db.insert(schema.runnerBudgets)
    .values({
      id: "runner-budget-e2e",
      runner: "claude",
      periodKey: "2026-04-15T10",
      tokensUsed: 1200,
      callsUsed: 4,
      tokensLimit: 10000,
      callsLimit: 40,
      createdAt: now,
      updatedAt: now,
    })
    .run();
});

describe("dashboard production wiring", () => {
  it("requires auth and serves observation data once authenticated", async () => {
    const app = await buildServer({
      dashboardToken: "secret-token",
      logger: false,
    });

    const denied = await app.inject({
      method: "GET",
      url: "/api/dashboard/observation",
    });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/dashboard/observation",
      headers: { authorization: "Bearer secret-token" },
    });
    expect(allowed.statusCode).toBe(200);

    const root = await app.inject({
      method: "GET",
      url: "/",
      headers: { authorization: "Bearer secret-token" },
    });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain("<title>ThreadsOS 司令室</title>");
    await app.close();
  });

  it("returns 404 for retired dashboard endpoints", async () => {
    const app = await buildServer({
      dashboardToken: "secret-token",
      logger: false,
    });

    const summary = await app.inject({
      method: "GET",
      url: "/api/dashboard/summary",
      headers: { authorization: "Bearer secret-token" },
    });
    const control = await app.inject({
      method: "POST",
      url: "/api/dashboard/control/pause",
      headers: { authorization: "Bearer secret-token" },
    });

    expect(summary.statusCode).toBe(404);
    expect(control.statusCode).toBe(404);
    await app.close();
  });
});
