import { sql } from "drizzle-orm";
import Fastify from "fastify";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearGlobalDashboardCache } from "../src/services/dashboard-query/request-cache.js";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = ":memory:";

type Db = typeof import("../src/db/index.js")["db"];
type SchemaModule = typeof import("../src/db/schema.js");
type DashboardRoutes =
  typeof import("../src/dashboard/routes.js")["dashboardRoutes"];

let db: Db;
let schema: SchemaModule;
let dashboardRoutes: DashboardRoutes;

const now = new Date().toISOString();
const future = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

async function seedDashboardState() {
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

  db.insert(schema.humanReviewItems)
    .values({
      id: "hr1",
      itemType: "thread_draft",
      itemId: "d1",
      reason: "risky content",
      status: "pending",
      reviewedAt: null,
      reviewerNote: null,
      createdAt: now,
    })
    .run();

  db.insert(schema.proposals)
    .values({
      id: "p1",
      agentId: "agent-1",
      leaderAgentId: "leader-1",
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

  db.insert(schema.proposalEvents)
    .values([
      {
        id: "pe1",
        proposalId: "p1",
        stage: "leader_review",
        action: "created",
        actorId: "agent-1",
        note: "担当者が提案を作成",
        metadataJson: JSON.stringify({ topic: "timing" }),
        createdAt: now,
      },
      {
        id: "pe2",
        proposalId: "p1",
        stage: "leader_review",
        action: "approved",
        actorId: "leader-1",
        note: "部署リーダーが確認済み",
        metadataJson: null,
        createdAt: now,
      },
    ])
    .run();

  db.insert(schema.departmentRuns)
    .values({
      id: "dr1",
      cycleId: "cycle-1",
      department: "threads",
      phase: "generate_and_post",
      status: "completed",
      summary: "2件の Threads 投稿を自動投稿",
      payloadJson: JSON.stringify({ published: 2 }),
      createdAt: now,
    })
    .run();

  db.insert(schema.executiveCycles)
    .values({
      id: "cycle-1",
      objective: "funnel_expansion",
      funnelStage: "conversion",
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
    .values([
      {
        id: "ds1",
        department: "threads",
        summaryType: "daily",
        content:
          "入力: 需要が高いテーマ / 出力: 2件投稿 / 停滞: なし / 優先: 10時投稿",
        periodKey: "2026-04-08",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "ds2",
        department: "external-research",
        summaryType: "daily",
        content: "Researched note competitors for 3 topics.",
        periodKey: "2026-04-08",
        createdAt: now,
        updatedAt: now,
      },
    ])
    .run();

  db.insert(schema.agentStates)
    .values({
      id: "agent-1",
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

  db.insert(schema.systemControls)
    .values({
      id: "ctrl1",
      scope: "threads",
      action: "pause",
      reason: "manual review",
      createdBy: "dashboard",
      active: 1,
      createdAt: now,
      resolvedAt: null,
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

  db.insert(schema.budgetTracking)
    .values({
      id: "budget-threads",
      scope: "threads",
      period: "heartbeat",
      periodKey: "2026-04-08T10",
      tokensUsed: 1200,
      callsUsed: 4,
      tokensLimit: 50000,
      callsLimit: 30,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  db.insert(schema.notePostResults)
    .values({
      id: "np1",
      draftId: "note-draft-1",
      title: "note sample",
      noteUrl: "https://note.example/test",
      priceYen: 1980,
      views: 300,
      likes: 20,
      commentsCount: 4,
      purchasesCount: 3,
      revenueYen: 5940,
      conversionRate: 0.01,
      trafficSource: "threads",
      publishedAt: now,
      createdAt: now,
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
      resultSummary: "heartbeat completed",
      createdAt: now,
    })
    .run();
}

async function resetDashboardState() {
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
  db.run(sql`DELETE FROM scheduled_job_runs`);
  db.run(sql`DELETE FROM strategy_states`);
  db.run(sql`DELETE FROM human_inputs`);
}

beforeAll(async () => {
  ({ db } = await import("../src/db/index.js"));
  schema = await import("../src/db/schema.js");
  const { ensureAutonomyTables } = await import("../src/db/bootstrap.js");
  ({ dashboardRoutes } = await import("../src/dashboard/routes.js"));
  ensureAutonomyTables();
});

beforeEach(async () => {
  clearGlobalDashboardCache();
  await resetDashboardState();
  await seedDashboardState();
});

afterEach(async () => {
  clearGlobalDashboardCache();
  await resetDashboardState();
});

describe("Dashboard API", () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    app = Fastify();
    await app.register(dashboardRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("GET /api/dashboard/summary returns operational focus and alerts", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/dashboard/summary",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual(
      expect.objectContaining({
        currentTheme: "勝ちテーマ",
        currentPolicy: expect.stringContaining("ファネル拡大"),
        health: "warning",
        healthHeadline: expect.stringContaining("AIが2件の判断を処理中"),
        healthReasons: expect.arrayContaining([
          expect.stringContaining("手動で止めている処理"),
        ]),
        nextHeartbeat: expect.objectContaining({
          jobName: "hourly-heartbeat",
          nextAt: expect.any(String),
        }),
        userActionItems: expect.arrayContaining([
          expect.objectContaining({
            id: "reviews",
          }),
        ]),
        channelSnapshots: expect.arrayContaining([
          expect.objectContaining({
            channel: "threads",
          }),
          expect.objectContaining({
            channel: "note",
          }),
        ]),
        workstreamSnapshots: expect.arrayContaining([
          expect.objectContaining({
            label: "Threads運用",
          }),
          expect.objectContaining({
            label: "外部リサーチ",
            summary: expect.stringContaining("note競合"),
          }),
        ]),
        importantAlerts: expect.arrayContaining([
          expect.objectContaining({
            type: "thread_draft",
            reason: "risky content",
          }),
        ]),
      }),
    );
    expect(body.notes24h).toEqual(
      expect.objectContaining({
        revenueYen: 5940,
      }),
    );
  });

  it("GET /api/dashboard/summary marks missing heartbeat as critical", async () => {
    db.run(sql`DELETE FROM heartbeat_states`);

    const res = await app.inject({
      method: "GET",
      url: "/api/dashboard/summary",
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.heartbeatFreshness).toBe("missing");
    expect(body.health).toBe("critical");
    expect(body.healthReasons).toEqual(
      expect.arrayContaining([expect.stringContaining("次回予定が見つからない")]),
    );
  });

  it("GET /api/dashboard/summary escalates when pending reviews pile up", async () => {
    db.insert(schema.humanReviewItems)
      .values(
        Array.from({ length: 9 }, (_, index) => ({
          id: `hr-extra-${index}`,
          itemType: "thread_draft",
          itemId: `draft-${index}`,
          reason: "ハートビートタイムアウト",
          status: "pending" as const,
          reviewedAt: null,
          reviewerNote: null,
          createdAt: now,
        })),
      )
      .run();

    const res = await app.inject({
      method: "GET",
      url: "/api/dashboard/summary",
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.health).toBe("critical");
    expect(body.userActionItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "reviews",
          level: "critical",
        }),
      ]),
    );
  });

  it("GET /api/dashboard/summary describes threads running and note stalled", async () => {
    db.run(sql`DELETE FROM human_review_items`);
    db.run(sql`DELETE FROM proposals`);
    db.run(sql`DELETE FROM system_controls`);
    db.run(sql`DELETE FROM note_post_results`);

    const stale = new Date(Date.now() - 18 * 60 * 60 * 1000).toISOString();
    db.insert(schema.departmentRuns)
      .values({
        id: "dr-note-old",
        cycleId: "cycle-note-old",
        department: "note",
        phase: "generate_note",
        status: "completed",
        summary: "前回のnote生成",
        payloadJson: JSON.stringify({ drafts: 1 }),
        createdAt: stale,
      })
      .run();

    const res = await app.inject({
      method: "GET",
      url: "/api/dashboard/summary",
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.healthHeadline).toContain("Threadsは稼働中");
    expect(body.healthHeadline).toContain("noteは停滞");
  });

  it("GET /api/dashboard/proposals/:id returns detail and history", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/dashboard/proposals/p1",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.proposal).toEqual(
      expect.objectContaining({
        id: "p1",
        currentStage: "human_review",
        currentApproverId: "dashboard-human",
        leaderAgentId: "leader-1",
        executiveAgentId: "exec-1",
      }),
    );
    expect(body.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "leader_review",
          action: "created",
        }),
      ]),
    );
  });

  it("GET /api/dashboard/proposals/:id/history returns the event timeline", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/dashboard/proposals/p1/history",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.proposalId).toBe("p1");
    expect(body.history).toHaveLength(2);
  });

  it("POST /api/dashboard/proposals/:id/approve records approval history", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/dashboard/proposals/p1/approve",
      payload: { note: "approved by dashboard" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });

    const detail = await app.inject({
      method: "GET",
      url: "/api/dashboard/proposals/p1",
    });
    const body = JSON.parse(detail.body);
    expect(body.proposal.status).toBe("approved");
    expect(body.proposal.currentStage).toBe("approved");
    expect(body.history.at(-1)).toEqual(
      expect.objectContaining({
        action: "approved",
        stage: "human_review",
      }),
    );
  });

  it("GET /api/dashboard/departments/:department returns operational signals", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/dashboard/departments/threads",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual(
      expect.objectContaining({
        department: "threads",
        currentTheme: expect.any(String),
        currentPolicy: expect.stringContaining("ファネル拡大"),
        signals: expect.objectContaining({
          inputs: expect.arrayContaining([
            expect.stringContaining("最新サマリー"),
          ]),
          outputs: expect.arrayContaining([expect.stringContaining("2件投稿")]),
          blockers: expect.arrayContaining([expect.stringContaining("停止中")]),
          priorityTasks: expect.arrayContaining([
            expect.stringContaining("投稿時刻の最適化"),
          ]),
        }),
        importantAlerts: expect.arrayContaining([
          expect.objectContaining({
            type: "pause",
          }),
        ]),
      }),
    );
  });

  it("GET /api/dashboard/departments adds owner-facing summary fields", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/dashboard/departments",
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          department: "threads",
          displayName: "Threads運用",
          statusSummary: expect.any(String),
          stale: false,
          blockingReason: expect.stringContaining("停止"),
        }),
      ]),
    );
  });

  it("GET /api/dashboard/agents/:id returns agent detail and budget", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/dashboard/agents/agent-1",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual(
      expect.objectContaining({
        id: "agent-1",
        department: "threads",
        recentProposals: expect.any(Array),
        budget: expect.objectContaining({
          scope: "threads",
          tokensRemaining: 48800,
        }),
      }),
    );
  });

  it("POST /api/dashboard/control/departments/:department/pause and resume round-trip", async () => {
    const pauseRes = await app.inject({
      method: "POST",
      url: "/api/dashboard/control/departments/threads/pause",
      payload: { note: "pause threads for review" },
    });
    expect(pauseRes.statusCode).toBe(200);
    expect(JSON.parse(pauseRes.body)).toEqual(
      expect.objectContaining({
        ok: true,
        paused: "threads",
      }),
    );

    const resumeRes = await app.inject({
      method: "POST",
      url: "/api/dashboard/control/departments/threads/resume",
      payload: { note: "resume threads" },
    });
    expect(resumeRes.statusCode).toBe(200);
    expect(JSON.parse(resumeRes.body)).toEqual(
      expect.objectContaining({
        ok: true,
        resumed: "threads",
      }),
    );
  });

  it("POST /api/dashboard/control/directives stores structured directives", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/dashboard/control/directives",
      payload: {
        scope: "threads",
        target: "next_heartbeat",
        department: "threads",
        agentId: "agent-1",
        priority: "high",
        content: "次回HBでは承認を最優先",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body).toEqual(
      expect.objectContaining({
        ok: true,
        scope: "threads",
        target: "next_heartbeat",
        department: "threads",
        agentId: "agent-1",
      }),
    );
  });

  it("GET /api/dashboard/logs returns real execution rows", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/dashboard/logs?page=1&perPage=10",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.rows[0]).toEqual(
      expect.objectContaining({
        jobName: "hourly-heartbeat",
        status: "completed",
      }),
    );
  });
});
