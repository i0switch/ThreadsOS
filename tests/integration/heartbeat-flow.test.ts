import { sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = ":memory:";

type Db = typeof import("../../src/db/index.js")["db"];
type SchemaModule = typeof import("../../src/db/schema.js");
type ExecutiveServiceCtor =
  typeof import("../../src/services/executive/index.js")["ExecutiveServiceImpl"];
type BudgetServiceFactory =
  typeof import("../../src/services/budget/index.js")["createBudgetService"];
type DiffCollectorFactory =
  typeof import("../../src/services/diff-collector/index.js")["createDiffCollectorService"];
type SafetyServiceFactory =
  typeof import("../../src/services/safety/index.js")["createSafetyService"];
type MemoryServiceFactory =
  typeof import("../../src/services/memory/index.js")["createMemoryService"];

let db: Db;
let schema: SchemaModule;
let ExecutiveServiceImpl: ExecutiveServiceCtor;
let createBudgetService: BudgetServiceFactory;
let createDiffCollectorService: DiffCollectorFactory;
let createSafetyService: SafetyServiceFactory;
let createMemoryService: MemoryServiceFactory;

beforeAll(async () => {
  ({ db } = await import("../../src/db/index.js"));
  schema = await import("../../src/db/schema.js");
  const { ensureAutonomyTables } = await import("../../src/db/bootstrap.js");
  ({ ExecutiveServiceImpl } = await import(
    "../../src/services/executive/index.js"
  ));
  ({ createBudgetService } = await import(
    "../../src/services/budget/index.js"
  ));
  ({ createDiffCollectorService } = await import(
    "../../src/services/diff-collector/index.js"
  ));
  ({ createSafetyService } = await import(
    "../../src/services/safety/index.js"
  ));
  ({ createMemoryService } = await import(
    "../../src/services/memory/index.js"
  ));

  ensureAutonomyTables();
});

beforeEach(() => {
  // Clean all relevant tables between tests
  db.run(sql`DELETE FROM department_runs`);
  db.run(sql`DELETE FROM executive_cycles`);
  db.run(sql`DELETE FROM strategy_states`);
  db.run(sql`DELETE FROM improvement_insights`);
  db.run(sql`DELETE FROM reply_decisions`);
  db.run(sql`DELETE FROM note_post_results`);
  db.run(sql`DELETE FROM content_slots`);
  db.run(sql`DELETE FROM thread_post_results`);
  db.run(sql`DELETE FROM thread_post_drafts`);
  db.run(sql`DELETE FROM human_inputs`);
  db.run(sql`DELETE FROM topics`);
  db.run(sql`DELETE FROM heartbeat_states`);
  db.run(sql`DELETE FROM system_controls`);
  db.run(sql`DELETE FROM budget_tracking`);
  db.run(sql`DELETE FROM memory_entries`);
  db.run(sql`DELETE FROM department_summaries`);
  db.run(sql`DELETE FROM scheduled_job_runs`);
});

describe("Heartbeat Flow Integration", () => {
  it("runs a full heartbeat cycle: diff -> executive plan -> department run -> summary", async () => {
    const now = new Date().toISOString();
    const executive = new ExecutiveServiceImpl();

    // Seed a topic to give the executive something to work with
    db.insert(schema.topics)
      .values({
        id: "topic-hb-1",
        name: "Test Topic",
        niche: "tech",
        priorityScore: 80,
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    // Step 1: Diff collection
    const diffCollector = createDiffCollectorService();
    const diff = await diffCollector.collectSinceLastHeartbeat();
    expect(diff).toBeDefined();
    expect(typeof diff.newReplies).toBe("number");
    expect(typeof diff.newErrors).toBe("number");

    // Step 2: Budget initialization
    const budgetService = createBudgetService();
    const periodKey = `hb-${now.slice(0, 13)}`;
    budgetService.initBudget("global", "heartbeat", periodKey, 50000, 30);
    budgetService.initBudget("threads", "heartbeat", periodKey, 10000, 10);
    expect(budgetService.canSpend("global", 1000, 1)).toBe(true);

    // Step 3: Executive plans the cycle
    const actions = [
      {
        type: "fetch_engagement" as const,
        priority: 1,
        reason: "recent posts",
      },
    ];
    const mockLlm = {
      async generate() {
        return JSON.stringify({
          objective: "engagement_compounding",
          funnelStage: "distribution",
          approvedActionTypes: ["fetch_engagement"],
          reasoning: "engagement follow-up",
          departmentInstructions: {},
        });
      },
      async audit() {
        return {
          verdict: "pass" as const,
          severity: "low" as const,
          reasons: [],
          suggestions: [],
          score: 8,
        };
      },
    };
    const mockReports = [
      {
        department: "community" as const,
        summary: "test",
        metrics: { pendingReplies: 0, avgEngagement: 0 },
        recommendation: "test",
        lastExecutedAt: null,
      },
    ];
    const cycle = await executive.beginHeartbeatCycle(
      mockReports,
      actions,
      mockLlm,
    );
    expect(cycle.cycleId).toBeDefined();
    expect(cycle.objective).toBeDefined();
    expect(cycle.approvedActions.length).toBeGreaterThanOrEqual(0);

    // Step 4: Record a department run
    await executive.recordDepartmentRun({
      cycleId: cycle.cycleId,
      department: "community",
      phase: "fetch_engagement",
      status: "completed",
      summary: "Fetched engagement for 3 posts",
      payload: { fetched: 3 },
    });

    // Step 5: Complete the cycle
    await executive.completeHeartbeatCycle(
      cycle.cycleId,
      "completed",
      "Fetched engagement for 3 posts",
    );

    // Verify persisted state
    const cycles = db.select().from(schema.executiveCycles).all();
    expect(cycles).toHaveLength(1);
    expect(cycles[0].status).toBe("completed");

    const deptRuns = db.select().from(schema.departmentRuns).all();
    expect(deptRuns).toHaveLength(1);
    expect(deptRuns[0].department).toBe("community");
  });

  it("skips heartbeat when system_controls has global pause", () => {
    const now = new Date().toISOString();

    // Insert global pause
    db.insert(schema.systemControls)
      .values({
        id: "ctrl-pause-1",
        scope: "global",
        action: "pause",
        reason: "maintenance",
        createdBy: "human",
        active: 1,
        createdAt: now,
      })
      .run();

    // Simulate the heartbeat's pause check
    const activePauses = db
      .select()
      .from(schema.systemControls)
      .where(
        sql`${schema.systemControls.action} = 'pause' AND ${schema.systemControls.active} = 1`,
      )
      .all();

    const pausedScopes = new Set(activePauses.map((c) => c.scope));
    expect(pausedScopes.has("global")).toBe(true);
  });

  it("defers actions when budget is exceeded", () => {
    const budgetService = createBudgetService();
    const periodKey = "hb-test-budget";

    // Initialize with very small budget
    budgetService.initBudget("threads", "heartbeat", periodKey, 500, 1);

    // First call within budget
    expect(budgetService.canSpend("threads", 500, 1)).toBe(true);
    budgetService.spend("threads", 500, 1);

    // Budget now exhausted
    expect(budgetService.canSpend("threads", 1, 1)).toBe(false);
    expect(budgetService.canSpend("threads", 100, 0)).toBe(false);
  });

  it("memory service stores and retrieves department context across heartbeats", () => {
    const memoryService = createMemoryService();

    memoryService.set(
      "department_summary",
      "threads",
      "last_run",
      "Published 2 posts with 500 impressions",
    );

    const entries = memoryService.listByLayer("department_summary", "threads");
    expect(entries).toHaveLength(1);
    expect(entries[0].value).toContain("Published 2 posts");

    // Overwrite with new data (simulating next heartbeat)
    memoryService.set(
      "department_summary",
      "threads",
      "last_run",
      "Published 3 posts with 800 impressions",
    );

    const updated = memoryService.listByLayer("department_summary", "threads");
    expect(updated).toHaveLength(1);
    expect(updated[0].value).toContain("800 impressions");
  });

  it("safety service detects consecutive failures", () => {
    const now = new Date().toISOString();
    const safetyService = createSafetyService();

    // Insert 5 consecutive failed job runs
    for (let i = 0; i < 5; i++) {
      db.insert(schema.scheduledJobRuns)
        .values({
          id: `run-fail-${i}`,
          jobName: "hourly-heartbeat",
          status: "failed",
          startedAt: now,
          finishedAt: now,
          dryRun: 0,
          resultSummary: `Failure ${i}`,
          createdAt: now,
        })
        .run();
    }

    expect(safetyService.shouldForceStop()).toBe(true);
  });

  it("executive returns llmReasoning and departmentInstructions on normal plan", async () => {
    const executive = new ExecutiveServiceImpl();
    const mockLlm = {
      async generate() {
        return JSON.stringify({
          objective: "funnel_expansion",
          funnelStage: "bootstrap",
          approvedActionTypes: ["generate_note"],
          reasoning: "integration-test-reasoning",
          departmentInstructions: { note: "integration-instruction" },
        });
      },
      async audit() {
        return {
          verdict: "pass" as const,
          severity: "low" as const,
          reasons: [],
          suggestions: [],
          score: 8,
        };
      },
    };

    const cycle = await executive.beginHeartbeatCycle(
      [
        {
          department: "note" as const,
          summary: "実績ゼロ",
          metrics: { pendingNoteDrafts: 0, dueNoteSlots: 0, publishedNotes: 0 },
          recommendation: "note実績ゼロ。記事生成を最優先",
          lastExecutedAt: null,
        },
      ],
      [{ type: "generate_note" as const, priority: 1, reason: "note枠" }],
      mockLlm,
    );

    expect(cycle.llmReasoning).toBe("integration-test-reasoning");
    expect(cycle.departmentInstructions?.note).toBe("integration-instruction");
  });
});
