import { sql } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = ":memory:";

type Db = typeof import("../src/db/index.js")["db"];
type SchemaModule = typeof import("../src/db/schema.js");
type DashboardQueryModule = typeof import("../src/services/dashboard-query/index.js");
type RequestCacheModule = typeof import("../src/services/dashboard-query/request-cache.js");

let db: Db;
let schema: SchemaModule;
let dashboardQuery: DashboardQueryModule;
let requestCache: RequestCacheModule;

const now = new Date().toISOString();
const future = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

async function seedState() {
  db.insert(schema.strategyStates)
    .values({
      key: "heartbeat:global",
      scope: "heartbeat",
      stateJson: JSON.stringify({
        objective: "funnel_expansion",
        funnelStage: "conversion",
        priorityTopics: ["勝ちテーマ"],
        activeActionTypes: ["generate_note", "reply_safe"],
      }),
      summary: "funnel_expansion:conversion",
      createdAt: now,
      updatedAt: now,
    })
    .run();

  db.insert(schema.heartbeatStates)
    .values({
      jobName: "hourly-heartbeat",
      lastRunAt: now,
      nextNotificationAt: future,
      consecutiveFailures: 0,
      lockedBy: null,
      lockedAt: null,
    })
    .run();

  db.insert(schema.proposals)
    .values({
      id: "proposal-threads-1",
      agentId: "threads-agent-1",
      leaderAgentId: "threads-leader-1",
      executiveAgentId: "exec-1",
      department: "threads",
      title: "投稿時刻を 10 時へ変更",
      description: "朝の投稿枠を 10 時へ寄せる",
      reason: "反応が高い時間帯を使う",
      evidence: "impressions up on late morning",
      expectedEffect: "engagement lift",
      risk: "low",
      priority: "high",
      status: "pending",
      currentStage: "human_review",
      currentApproverId: "dashboard-human",
      reviewerNote: null,
      reviewedAt: null,
      executedAt: null,
      createdAt: now,
    })
    .run();

  db.insert(schema.departmentRuns)
    .values({
      id: "run-threads-1",
      cycleId: "cycle-1",
      department: "threads",
      phase: "generate_and_post",
      status: "completed",
      summary: "2件の Threads 投稿を自動投稿",
      payloadJson: JSON.stringify({ published: 2 }),
      createdAt: now,
    })
    .run();

  db.insert(schema.departmentSummaries)
    .values({
      id: "summary-threads-1",
      department: "threads",
      summaryType: "daily",
      content:
        "入力: 需要が高いテーマ / 出力: 2件投稿 / 停滞: なし / 優先: 10時投稿",
      periodKey: "2026-04-11",
      createdAt: now,
      updatedAt: now,
    })
    .run();

  db.insert(schema.agentStates)
    .values({
      id: "threads-agent-1",
      name: "Threads担当",
      department: "threads",
      role: "writer",
      status: "working",
      currentTask: "投稿時刻の最適化",
      lastCompletedTask: "ドラフト作成",
      budgetUsedTokens: 1200,
      budgetUsedCalls: 4,
      lastActiveAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  db.insert(schema.budgetTracking)
    .values({
      id: "budget-threads-1",
      scope: "threads",
      period: "heartbeat",
      periodKey: "2026-04-11T10",
      tokensUsed: 1200,
      callsUsed: 4,
      tokensLimit: 50000,
      callsLimit: 30,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

async function resetState() {
  db.run(sql`DELETE FROM proposal_events`);
  db.run(sql`DELETE FROM proposals`);
  db.run(sql`DELETE FROM human_review_items`);
  db.run(sql`DELETE FROM system_controls`);
  db.run(sql`DELETE FROM agent_states`);
  db.run(sql`DELETE FROM department_runs`);
  db.run(sql`DELETE FROM department_summaries`);
  db.run(sql`DELETE FROM executive_cycles`);
  db.run(sql`DELETE FROM heartbeat_states`);
  db.run(sql`DELETE FROM budget_tracking`);
  db.run(sql`DELETE FROM note_post_results`);
  db.run(sql`DELETE FROM thread_post_results`);
  db.run(sql`DELETE FROM scheduled_job_runs`);
  db.run(sql`DELETE FROM strategy_states`);
  db.run(sql`DELETE FROM human_inputs`);
}

beforeAll(async () => {
  ({ db } = await import("../src/db/index.js"));
  schema = await import("../src/db/schema.js");
  dashboardQuery = await import("../src/services/dashboard-query/index.js");
  requestCache = await import("../src/services/dashboard-query/request-cache.js");
  const { ensureAutonomyTables } = await import("../src/db/bootstrap.js");
  ensureAutonomyTables();
});

beforeEach(async () => {
  requestCache.clearGlobalDashboardCache();
  await resetState();
  await seedState();
});

afterEach(async () => {
  requestCache.clearGlobalDashboardCache();
  await resetState();
});

describe("dashboard query request cache", () => {
  it("reuses base query results within one request scope", () => {
    const uncachedSummaryA = dashboardQuery.getSummary();
    const uncachedSummaryB = dashboardQuery.getSummary();
    expect(uncachedSummaryA).not.toBe(uncachedSummaryB);

    requestCache.withDashboardQueryCache(() => {
      const summaryA = dashboardQuery.getSummary();
      const summaryB = dashboardQuery.getSummary();
      const departmentsA = dashboardQuery.getDepartments();
      const departmentsB = dashboardQuery.getDepartments();
      const detailA = dashboardQuery.getDepartmentDetail("threads");
      const detailB = dashboardQuery.getDepartmentDetail("threads");
      const agentsA = dashboardQuery.getAgents();
      const agentsB = dashboardQuery.getAgents();
      const proposalsA = dashboardQuery.getProposals();
      const proposalsB = dashboardQuery.getProposals();

      expect(summaryA).toBe(summaryB);
      expect(departmentsA).toBe(departmentsB);
      expect(detailA).toBe(detailB);
      expect(agentsA).toBe(agentsB);
      expect(proposalsA).toBe(proposalsB);
    });
  });

  it("isolates cached objects between request scopes", () => {
    const first = requestCache.withDashboardQueryCache(() =>
      dashboardQuery.getSummary(),
    );
    const second = requestCache.withDashboardQueryCache(() =>
      dashboardQuery.getSummary(),
    );

    expect(first).not.toBe(second);
  });
});