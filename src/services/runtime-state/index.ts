import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { agentStates } from "../../db/schema.js";
import type { ActionType } from "../content-scheduler/index.js";

export type AgentStatus =
  | "idle"
  | "working"
  | "proposing"
  | "awaiting_approval";

export type AgentDefinition = {
  id: string;
  name: string;
  department: string;
  role: string;
  actions: ActionType[];
  leaderId?: string;
};

export const AGENTS: AgentDefinition[] = [
  {
    id: "executive-director",
    name: "Executive Director",
    department: "command",
    role: "executive",
    actions: ["process_human_inputs", "notify"],
  },
  {
    id: "trend-researcher",
    name: "Trend Researcher",
    department: "external-research",
    role: "researcher",
    actions: ["research_threads"],
    leaderId: "research-director",
  },
  {
    id: "research-director",
    name: "Research Director",
    department: "external-research",
    role: "leader",
    actions: ["research_threads"],
  },
  {
    id: "threads-competitor-researcher",
    name: "Threads Competitor Researcher",
    department: "threads",
    role: "competitor_research",
    actions: ["research_threads"],
    leaderId: "threads-operations-director",
  },
  {
    id: "note-competitor-researcher",
    name: "note Competitor Researcher",
    department: "note",
    role: "competitor_research",
    actions: ["research_note"],
    leaderId: "note-operations-director",
  },
  {
    id: "threads-post-generator",
    name: "Threads Post Generator",
    department: "threads",
    role: "generator",
    actions: ["generate_and_post"],
    leaderId: "threads-operations-director",
  },
  {
    id: "threads-operations-director",
    name: "Threads Operations Director",
    department: "threads",
    role: "leader",
    actions: [
      "research_threads",
      "generate_and_post",
      "fetch_engagement",
      "reply_safe",
      "optimize_schedule",
      "weekly_retro",
    ],
  },
  {
    id: "threads-engagement-analyst",
    name: "Threads Engagement Analyst",
    department: "threads",
    role: "analyst",
    actions: ["fetch_engagement"],
    leaderId: "threads-operations-director",
  },
  {
    id: "threads-reply-generator",
    name: "Threads Reply Generator",
    department: "threads",
    role: "reply_generator",
    actions: ["reply_safe"],
    leaderId: "threads-operations-director",
  },
  {
    id: "note-article-generator",
    name: "note Article Generator",
    department: "note",
    role: "generator",
    actions: ["generate_note"],
    leaderId: "note-operations-director",
  },
  {
    id: "note-engagement-analyst",
    name: "note Engagement Analyst",
    department: "note",
    role: "analyst",
    actions: ["generate_note", "optimize_schedule"],
    leaderId: "note-operations-director",
  },
  {
    id: "note-operations-director",
    name: "note Operations Director",
    department: "note",
    role: "leader",
    actions: ["research_note", "generate_note", "optimize_schedule"],
  },
  {
    id: "engagement-analyst",
    name: "Competitive Signal Analyst",
    department: "competitive-analysis",
    role: "analyst",
    actions: ["analyze_competitors"],
    leaderId: "community-director",
  },
  {
    id: "reply-manager",
    name: "Reply Manager",
    department: "threads",
    role: "reply_manager",
    actions: [],
    leaderId: "threads-operations-director",
  },
  {
    id: "community-director",
    name: "Competitive Analysis Director",
    department: "competitive-analysis",
    role: "leader",
    actions: ["analyze_competitors"],
  },
  {
    id: "cadence-optimizer",
    name: "Cadence Optimizer",
    department: "threads",
    role: "optimizer",
    actions: ["optimize_schedule", "weekly_retro"],
    leaderId: "threads-operations-director",
  },
  {
    id: "optimization-director",
    name: "Command Operations Director",
    department: "command",
    role: "leader",
    actions: ["notify"],
    leaderId: "executive-director",
  },
];

type AgentPair = {
  worker: AgentDefinition;
  leader: AgentDefinition | null;
  executive: AgentDefinition | null;
};

function nowIso(): string {
  return new Date().toISOString();
}

function resolveAgents(actionType: ActionType): AgentPair {
  const preferredWorkers: Partial<Record<ActionType, string>> = {
    research_threads: "trend-researcher",
    research_note: "note-competitor-researcher",
    generate_and_post: "threads-post-generator",
    generate_note: "note-article-generator",
    fetch_engagement: "threads-engagement-analyst",
    reply_safe: "threads-reply-generator",
    weekly_retro: "cadence-optimizer",
    optimize_schedule: "cadence-optimizer",
    notify: "optimization-director",
    process_human_inputs: "executive-director",
  };

  const worker =
    AGENTS.find((agent) => agent.id === preferredWorkers[actionType]) ??
    AGENTS.find(
      (agent) => agent.leaderId && agent.actions.includes(actionType),
    ) ??
    AGENTS.find((agent) => agent.actions.includes(actionType)) ??
    AGENTS[0];
  const leader = worker.leaderId
    ? (AGENTS.find((agent) => agent.id === worker.leaderId) ?? null)
    : null;
  const executive =
    AGENTS.find((agent) => agent.id === "executive-director") ?? null;
  return { worker, leader, executive };
}

function findAgent(agentId: string): AgentDefinition | null {
  return AGENTS.find((agent) => agent.id === agentId) ?? null;
}

function upsertAgentState(
  agent: AgentDefinition,
  updates: Partial<typeof agentStates.$inferInsert>,
): void {
  const existing = db
    .select()
    .from(agentStates)
    .where(eq(agentStates.id, agent.id))
    .get();
  const now = nowIso();

  if (existing) {
    db.update(agentStates)
      .set({
        ...updates,
        updatedAt: now,
      })
      .where(eq(agentStates.id, agent.id))
      .run();
    return;
  }

  db.insert(agentStates)
    .values({
      id: agent.id,
      name: agent.name,
      department: agent.department,
      role: agent.role,
      status: "idle",
      currentTask: null,
      lastCompletedTask: null,
      budgetUsedTokens: 0,
      budgetUsedCalls: 0,
      lastActiveAt: now,
      createdAt: now,
      updatedAt: now,
      ...updates,
    })
    .run();
}

function setStatus(
  agent: AgentDefinition | null,
  status: AgentStatus,
  currentTask: string | null,
  lastCompletedTask?: string | null,
  budgetUsedTokens = 0,
  budgetUsedCalls = 0,
): void {
  if (!agent) return;
  const existing = db
    .select()
    .from(agentStates)
    .where(eq(agentStates.id, agent.id))
    .get();

  upsertAgentState(agent, {
    status,
    currentTask,
    lastCompletedTask:
      lastCompletedTask !== undefined
        ? lastCompletedTask
        : (existing?.lastCompletedTask ?? null),
    budgetUsedTokens: (existing?.budgetUsedTokens ?? 0) + budgetUsedTokens,
    budgetUsedCalls: (existing?.budgetUsedCalls ?? 0) + budgetUsedCalls,
    lastActiveAt: nowIso(),
  });
}

export interface RuntimeStateService {
  ensureCatalog(): void;
  startAction(
    actionType: ActionType,
    task: string,
  ): {
    workerId: string;
    leaderId: string | null;
    executiveId: string | null;
  };
  markPendingProposal(
    actionType: ActionType,
    task: string,
  ): {
    workerId: string;
    leaderId: string | null;
    executiveId: string | null;
  };
  finishAction(
    actionType: ActionType,
    summary: string,
    budgetUsedTokens?: number,
    budgetUsedCalls?: number,
  ): void;
  startAgent(agentId: string, task: string): void;
  finishAgent(
    agentId: string,
    summary: string,
    budgetUsedTokens?: number,
    budgetUsedCalls?: number,
  ): void;
}

export function createRuntimeStateService(): RuntimeStateService {
  function ensureCatalog(): void {
    for (const agent of AGENTS) {
      upsertAgentState(agent, {});
    }
  }

  function startAction(actionType: ActionType, task: string) {
    const { worker, leader, executive } = resolveAgents(actionType);
    setStatus(worker, "working", task);
    setStatus(
      leader,
      "working",
      leader ? `${worker.name} を監督中: ${task}` : task,
    );
    setStatus(
      executive,
      "working",
      leader
        ? `${leader.name} からの実行状況を監督中`
        : `${worker.name} の実行状況を監督中`,
    );
    return {
      workerId: worker.id,
      leaderId: leader?.id ?? null,
      executiveId: executive?.id ?? null,
    };
  }

  function markPendingProposal(actionType: ActionType, task: string) {
    const { worker, leader, executive } = resolveAgents(actionType);
    setStatus(worker, "proposing", task);
    setStatus(
      leader,
      "awaiting_approval",
      leader ? `${worker.name} の提案を確認中` : task,
    );
    setStatus(
      executive,
      "awaiting_approval",
      `${leader?.name ?? worker.name} の提案を人間レビューへ送るか確認中`,
    );
    return {
      workerId: worker.id,
      leaderId: leader?.id ?? null,
      executiveId: executive?.id ?? null,
    };
  }

  function finishAction(
    actionType: ActionType,
    summary: string,
    budgetUsedTokens = 0,
    budgetUsedCalls = 0,
  ) {
    const { worker, leader, executive } = resolveAgents(actionType);
    setStatus(worker, "idle", null, summary, budgetUsedTokens, budgetUsedCalls);
    setStatus(leader, "idle", null, summary);
    setStatus(executive, "idle", null, summary);
  }

  function startAgent(agentId: string, task: string): void {
    const agent = findAgent(agentId);
    if (!agent) return;
    setStatus(agent, "working", task);
  }

  function finishAgent(
    agentId: string,
    summary: string,
    budgetUsedTokens = 0,
    budgetUsedCalls = 0,
  ): void {
    const agent = findAgent(agentId);
    if (!agent) return;
    setStatus(agent, "idle", null, summary, budgetUsedTokens, budgetUsedCalls);
  }

  return {
    ensureCatalog,
    startAction,
    markPendingProposal,
    finishAction,
    startAgent,
    finishAgent,
  };
}
