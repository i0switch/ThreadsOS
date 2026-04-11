import { sql } from "drizzle-orm";
import Fastify from "fastify";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = ":memory:";

type Db = typeof import("../../src/db/index.js")["db"];
type SchemaModule = typeof import("../../src/db/schema.js");
type DashboardRoutes =
  typeof import("../../src/dashboard/routes.js")["dashboardRoutes"];

let db: Db;
let schema: SchemaModule;
let dashboardRoutes: DashboardRoutes;

const now = new Date().toISOString();
const future = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();

async function seedState() {
  db.insert(schema.strategyStates)
    .values({
      key: "heartbeat:global",
      scope: "heartbeat",
      stateJson: JSON.stringify({
        objective: "engagement_compounding",
        funnelStage: "optimization",
        priorityTopics: ["関係性の濃いテーマ"],
        activeActionTypes: ["fetch_engagement", "reply_safe"],
      }),
      summary: "engagement_compounding:optimization",
      createdAt: now,
      updatedAt: now,
    })
    .run();

  db.insert(schema.proposals)
    .values({
      id: "p1",
      agentId: "agent-1",
      leaderAgentId: "leader-1",
      executiveAgentId: "exec-1",
      department: "threads",
      title: "午前投稿を止めて夜へ寄せる",
      description: "夜に寄せて回遊を高める",
      reason: "夜間の反応が高い",
      evidence: "night posts work",
      expectedEffect: "reply rate up",
      risk: "medium",
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

  db.insert(schema.proposalEvents)
    .values({
      id: "pe1",
      proposalId: "p1",
      stage: "leader_review",
      action: "created",
      actorId: "agent-1",
      note: "提案を作成",
      metadataJson: JSON.stringify({ source: "threads" }),
      createdAt: now,
    })
    .run();

  db.insert(schema.departmentRuns)
    .values({
      id: "dr1",
      cycleId: "cycle-1",
      department: "threads",
      phase: "reply_safe",
      status: "completed",
      summary: "安全返信を2件実行",
      payloadJson: JSON.stringify({ replied: 2 }),
      createdAt: now,
    })
    .run();

  db.insert(schema.executiveCycles)
    .values({
      id: "cycle-1",
      objective: "engagement_compounding",
      funnelStage: "optimization",
      strategyKey: "heartbeat:global",
      status: "running",
      decisionJson: JSON.stringify({}),
      summary: null,
      startedAt: now,
      completedAt: null,
      createdAt: now,
    })
    .run();

  db.insert(schema.departmentSummaries)
    .values({
      id: "ds1",
      department: "threads",
      summaryType: "weekly",
      content:
        "入力: 過去の反応が高い / 出力: 返信強化 / 停滞: なし / 優先: 夜返信",
      periodKey: "2026-W15",
      createdAt: now,
      updatedAt: now,
    })
    .run();

  db.insert(schema.agentStates)
    .values({
      id: "agent-1",
      name: "Threads担当",
      department: "threads",
      role: "writer",
      status: "working",
      currentTask: "夜向け文面の調整",
      lastCompletedTask: "返信分類",
      budgetUsedTokens: 2200,
      budgetUsedCalls: 7,
      lastActiveAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  db.insert(schema.humanReviewItems)
    .values({
      id: "hr1",
      itemType: "note_draft",
      itemId: "draft-1",
      reason: "needs review",
      status: "pending",
      reviewedAt: null,
      reviewerNote: null,
      createdAt: now,
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

  db.insert(schema.notePostResults)
    .values({
      id: "np1",
      draftId: "note-draft-1",
      title: "note sample",
      noteUrl: "https://note.example/test",
      priceYen: 2980,
      views: 480,
      likes: 32,
      commentsCount: 5,
      purchasesCount: 5,
      revenueYen: 14900,
      conversionRate: 0.01,
      trafficSource: "threads",
      publishedAt: now,
      createdAt: now,
    })
    .run();

  db.insert(schema.budgetTracking)
    .values({
      id: "budget-threads",
      scope: "threads",
      period: "heartbeat",
      periodKey: "2026-04-08T10",
      tokensUsed: 2200,
      callsUsed: 7,
      tokensLimit: 50000,
      callsLimit: 30,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  db.insert(schema.scheduledJobRuns)
    .values({
      id: "run1",
      jobName: "hourly-heartbeat",
      status: "completed",
      startedAt: now,
      finishedAt: now,
      dryRun: 0,
      resultSummary: "ok",
      createdAt: now,
    })
    .run();
}

async function resetState() {
  db.run(sql`DELETE FROM proposal_events`);
  db.run(sql`DELETE FROM proposals`);
  db.run(sql`DELETE FROM department_runs`);
  db.run(sql`DELETE FROM department_summaries`);
  db.run(sql`DELETE FROM executive_cycles`);
  db.run(sql`DELETE FROM agent_states`);
  db.run(sql`DELETE FROM human_review_items`);
  db.run(sql`DELETE FROM heartbeat_states`);
  db.run(sql`DELETE FROM note_post_results`);
  db.run(sql`DELETE FROM budget_tracking`);
  db.run(sql`DELETE FROM scheduled_job_runs`);
  db.run(sql`DELETE FROM strategy_states`);
  db.run(sql`DELETE FROM system_controls`);
  db.run(sql`DELETE FROM human_inputs`);
}

beforeAll(async () => {
  ({ db } = await import("../../src/db/index.js"));
  schema = await import("../../src/db/schema.js");
  const { ensureAutonomyTables } = await import("../../src/db/bootstrap.js");
  ({ dashboardRoutes } = await import("../../src/dashboard/routes.js"));
  ensureAutonomyTables();
});

beforeEach(async () => {
  await resetState();
  await seedState();
});

afterEach(async () => {
  await resetState();
});

describe("Dashboard E2E Integration", () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    app = Fastify();
    await app.register(dashboardRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("surfaces summary focus and detail panels from real routes", async () => {
    const summaryRes = await app.inject({
      method: "GET",
      url: "/api/dashboard/summary",
    });
    expect(summaryRes.statusCode).toBe(200);
    const summary = JSON.parse(summaryRes.body);
    expect(summary).toEqual(
      expect.objectContaining({
        currentTheme: "関係性の濃いテーマ",
        nextHeartbeat: expect.objectContaining({
          jobName: "hourly-heartbeat",
        }),
      }),
    );

    const departmentRes = await app.inject({
      method: "GET",
      url: "/api/dashboard/departments/threads",
    });
    expect(departmentRes.statusCode).toBe(200);
    const department = JSON.parse(departmentRes.body);
    expect(department.signals.blockers).toEqual(
      expect.arrayContaining(["未処理提案あり"]),
    );

    const agentRes = await app.inject({
      method: "GET",
      url: "/api/dashboard/agents/agent-1",
    });
    expect(agentRes.statusCode).toBe(200);
    const agent = JSON.parse(agentRes.body);
    expect(agent.recentProposals).toBeInstanceOf(Array);

    const proposalRes = await app.inject({
      method: "GET",
      url: "/api/dashboard/proposals/p1/history",
    });
    expect(proposalRes.statusCode).toBe(200);
    expect(JSON.parse(proposalRes.body).history).toHaveLength(1);
  });

  it("records department control and structured directive flows", async () => {
    const pauseRes = await app.inject({
      method: "POST",
      url: "/api/dashboard/control/departments/threads/pause",
      payload: { note: "pause for review" },
    });
    expect(pauseRes.statusCode).toBe(200);

    const detailRes = await app.inject({
      method: "GET",
      url: "/api/dashboard/departments/threads",
    });
    const detail = JSON.parse(detailRes.body);
    expect(detail.paused).toBe(true);

    const directiveRes = await app.inject({
      method: "POST",
      url: "/api/dashboard/control/directives",
      payload: {
        scope: "threads",
        target: "assignee",
        department: "threads",
        agentId: "agent-1",
        priority: "high",
        content: "明日は夜投稿へ切り替える",
      },
    });
    expect(directiveRes.statusCode).toBe(201);
    expect(JSON.parse(directiveRes.body)).toEqual(
      expect.objectContaining({
        target: "assignee",
        department: "threads",
      }),
    );

    const approveRes = await app.inject({
      method: "POST",
      url: "/api/dashboard/proposals/p1/approve",
      payload: { note: "approved in integration test" },
    });
    expect(approveRes.statusCode).toBe(200);

    const detailAfter = await app.inject({
      method: "GET",
      url: "/api/dashboard/proposals/p1",
    });
    const proposal = JSON.parse(detailAfter.body);
    expect(proposal.proposal.status).toBe("approved");
    expect(proposal.history.at(-1)).toEqual(
      expect.objectContaining({
        action: "approved",
      }),
    );
  });

  it("surfaces KPI and logs from the actual dashboard routes", async () => {
    const kpiRes = await app.inject({
      method: "GET",
      url: "/api/dashboard/kpi",
    });
    expect(kpiRes.statusCode).toBe(200);
    const kpi = JSON.parse(kpiRes.body);
    expect(kpi).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metricName: "revenue_yen",
        }),
      ]),
    );

    const logsRes = await app.inject({
      method: "GET",
      url: "/api/dashboard/logs?page=1&perPage=10",
    });
    expect(logsRes.statusCode).toBe(200);
    const logs = JSON.parse(logsRes.body);
    expect(logs.rows[0]).toEqual(
      expect.objectContaining({
        jobName: "hourly-heartbeat",
      }),
    );
  });
});
