import { sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = ":memory:";

import type {
  LlmClient,
  LlmGenerateOptions,
} from "../src/adapters/llm/index.js";

type Db = typeof import("../src/db/index.js")["db"];
type SchemaModule = typeof import("../src/db/schema.js");
type ExecutiveServiceCtor =
  typeof import("../src/services/executive/index.js")["ExecutiveServiceImpl"];

let db: Db;
let schema: SchemaModule;
let ExecutiveServiceImpl: ExecutiveServiceCtor;

class MockLlmClient implements LlmClient {
  constructor(private response: string) {}
  async generate(
    _prompt: string,
    _options?: LlmGenerateOptions,
  ): Promise<string> {
    return this.response;
  }
  async audit() {
    return {
      verdict: "pass" as const,
      severity: "low" as const,
      reasons: [],
      suggestions: [],
      score: 8,
    };
  }
}

function makeReports() {
  return [
    {
      department: "command" as const,
      summary: "待機中",
      metrics: { pendingInputs: 0 },
      recommendation: "動く必要なし",
      lastExecutedAt: null,
    },
    {
      department: "research" as const,
      summary: "リサーチ済み",
      metrics: { hoursSinceLastResearch: 2, activeTopics: 3 },
      recommendation: "動く必要なし",
      lastExecutedAt: null,
    },
    {
      department: "threads" as const,
      summary: "在庫あり",
      metrics: { pendingDrafts: 3, dueSlots: 0 },
      recommendation: "動く必要なし",
      lastExecutedAt: null,
    },
    {
      department: "note" as const,
      summary: "実績ゼロ",
      metrics: { pendingNoteDrafts: 0, dueNoteSlots: 0, publishedNotes: 0 },
      recommendation: "note実績ゼロ。記事生成を最優先",
      lastExecutedAt: null,
    },
    {
      department: "community" as const,
      summary: "待機中",
      metrics: { pendingReplies: 0, avgEngagement: 0 },
      recommendation: "動く必要なし",
      lastExecutedAt: null,
    },
    {
      department: "optimization" as const,
      summary: "振り返り未実施",
      metrics: { daysSinceRetro: 999 },
      recommendation: "週次振り返り推奨",
      lastExecutedAt: null,
    },
  ];
}

beforeAll(async () => {
  ({ db } = await import("../src/db/index.js"));
  schema = await import("../src/db/schema.js");
  const { ensureAutonomyTables } = await import("../src/db/bootstrap.js");
  ({ ExecutiveServiceImpl } = await import(
    "../src/services/executive/index.js"
  ));

  ensureAutonomyTables();
});

beforeEach(() => {
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
});

describe("ExecutiveService", () => {
  it("uses LLM decision to approve/skip actions", async () => {
    const service = new ExecutiveServiceImpl();
    const llm = new MockLlmClient(
      JSON.stringify({
        objective: "funnel_expansion",
        funnelStage: "bootstrap",
        approvedActionTypes: ["generate_note"],
        reasoning: "note実績ゼロのため記事生成を最優先",
        departmentInstructions: { note: "恋愛ジャンルで記事生成" },
      }),
    );

    const cycle = await service.beginHeartbeatCycle(
      makeReports(),
      [
        { type: "generate_note", priority: 1, reason: "note枠あり" },
        { type: "generate_and_post", priority: 2, reason: "threads枠あり" },
      ],
      llm,
    );

    expect(cycle.objective).toBe("funnel_expansion");
    expect(cycle.approvedActions).toEqual([
      { type: "generate_note", priority: 1, reason: "note枠あり" },
    ]);
    expect(cycle.skippedActions).toHaveLength(1);
    expect(cycle.skippedActions[0].action.type).toBe("generate_and_post");
    expect(cycle.directives.some((item) => item.department === "note")).toBe(
      true,
    );

    const strategy = db.select().from(schema.strategyStates).all();
    const executiveCycles = db.select().from(schema.executiveCycles).all();

    expect(strategy).toHaveLength(1);
    expect(executiveCycles).toHaveLength(1);
    expect(executiveCycles[0].status).toBe("running");
  });

  it("falls back when LLM returns invalid JSON", async () => {
    const service = new ExecutiveServiceImpl();
    const llm = new MockLlmClient("this is not json at all");

    const cycle = await service.beginHeartbeatCycle(
      makeReports(),
      [
        { type: "generate_note", priority: 1, reason: "note枠" },
        { type: "reply_safe", priority: 2, reason: "replies" },
      ],
      llm,
    );

    // Fallback: approve up to 3 candidates
    expect(cycle.approvedActions).toHaveLength(2);
    expect(cycle.objective).toBe("funnel_expansion");
    expect(cycle.funnelStage).toBe("bootstrap");
  });

  it("stores department runs and completes the cycle", async () => {
    const service = new ExecutiveServiceImpl();
    const llm = new MockLlmClient(
      JSON.stringify({
        objective: "funnel_expansion",
        funnelStage: "bootstrap",
        approvedActionTypes: [],
        reasoning: "何もしない",
        departmentInstructions: {},
      }),
    );

    const cycle = await service.beginHeartbeatCycle(makeReports(), [], llm);

    await service.recordDepartmentRun({
      cycleId: cycle.cycleId,
      department: "threads",
      phase: "generate_and_post",
      status: "completed",
      summary: "Auto-published 2 threads posts",
      payload: { published: 2 },
    });
    await service.completeHeartbeatCycle(
      cycle.cycleId,
      "completed",
      "Auto-published 2 threads posts",
    );

    const departmentRuns = db.select().from(schema.departmentRuns).all();
    const cycles = db.select().from(schema.executiveCycles).all();

    expect(departmentRuns).toHaveLength(1);
    expect(departmentRuns[0].department).toBe("threads");
    expect(cycles[0].status).toBe("completed");
    expect(cycles[0].summary).toContain("Auto-published");
  });

  it("fallback persists strategy_states and executive_cycles", async () => {
    const service = new ExecutiveServiceImpl();
    const llm = new MockLlmClient("not-json-at-all");

    const cycle = await service.beginHeartbeatCycle(
      makeReports(),
      [{ type: "generate_note", priority: 1, reason: "note枠" }],
      llm,
    );

    expect(cycle.llmReasoning).toBeDefined();
    expect(cycle.approvedActions).toHaveLength(1); // bounded fallback

    const strategies = db.select().from(schema.strategyStates).all();
    const cycles = db.select().from(schema.executiveCycles).all();

    expect(strategies).toHaveLength(1);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].status).toBe("running");
  });

  it("exposes llmReasoning and departmentInstructions on normal plan", async () => {
    const service = new ExecutiveServiceImpl();
    const llm = new MockLlmClient(
      JSON.stringify({
        objective: "funnel_expansion",
        funnelStage: "bootstrap",
        approvedActionTypes: ["generate_note"],
        reasoning: "test-reasoning-value",
        departmentInstructions: { note: "記事生成開始" },
      }),
    );

    const cycle = await service.beginHeartbeatCycle(
      makeReports(),
      [{ type: "generate_note", priority: 1, reason: "note枠" }],
      llm,
    );

    expect(cycle.llmReasoning).toBe("test-reasoning-value");
    expect(cycle.departmentInstructions).toEqual({ note: "記事生成開始" });
  });

  it("normalizes invalid objective and funnelStage from LLM", async () => {
    const service = new ExecutiveServiceImpl();
    const llm = new MockLlmClient(
      JSON.stringify({
        objective: "world_domination",
        funnelStage: "quantum_tunnel",
        approvedActionTypes: [],
        reasoning: "bad fields test",
        departmentInstructions: {},
      }),
    );

    const cycle = await service.beginHeartbeatCycle(makeReports(), [], llm);

    expect(cycle.objective).toBe("funnel_expansion");
    expect(cycle.funnelStage).toBe("bootstrap");
  });

  it("filters invalid action types from LLM without crashing", async () => {
    const service = new ExecutiveServiceImpl();
    const llm = new MockLlmClient(
      JSON.stringify({
        objective: "funnel_expansion",
        funnelStage: "bootstrap",
        approvedActionTypes: ["generate_note", "totally_invalid_action_xyz"],
        reasoning: "filter test",
        departmentInstructions: {},
      }),
    );

    const cycle = await service.beginHeartbeatCycle(
      makeReports(),
      [
        { type: "generate_note", priority: 1, reason: "note枠" },
        { type: "generate_and_post", priority: 2, reason: "threads枠" },
      ],
      llm,
    );

    expect(cycle.approvedActions).toHaveLength(1);
    expect(cycle.approvedActions[0].type).toBe("generate_note");
  });
});
