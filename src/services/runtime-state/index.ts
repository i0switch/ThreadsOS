import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { agentStates } from "../../db/schema.js";
import type { ActionType } from "../content-scheduler/index.js";

type AgentStatus = "idle" | "working" | "proposing" | "awaiting_approval";

type AgentDefinition = {
  id: string;
  name: string;
  department: string;
  role: string;
  actions: ActionType[];
  leaderId?: string;
};

const AGENTS: AgentDefinition[] = [
  {
    id: "executive-director",
    name: "Executive Director",
    department: "command",
    role: "executive",
    actions: ["process_human_inputs"],
  },
  {
    id: "trend-researcher",
    name: "Trend Researcher",
    department: "research",
    role: "researcher",
    actions: ["research_threads", "research_note"],
    leaderId: "research-director",
  },
  {
    id: "research-director",
    name: "Research Director",
    department: "research",
    role: "leader",
    actions: ["research_threads", "research_note"],
  },
  {
    id: "threads-competitor-researcher",
    name: "Threads Competitor Researcher",
    department: "research",
    role: "competitor_research",
    actions: ["research_threads"],
    leaderId: "research-director",
  },
  {
    id: "note-competitor-researcher",
    name: "note Competitor Researcher",
    department: "research",
    role: "competitor_research",
    actions: ["research_note"],
    leaderId: "research-director",
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
    actions: ["generate_and_post"],
  },
  {
    id: "threads-engagement-analyst",
    name: "Threads Engagement Analyst",
    department: "community",
    role: "analyst",
    actions: ["fetch_engagement"],
    leaderId: "community-director",
  },
  {
    id: "threads-reply-generator",
    name: "Threads Reply Generator",
    department: "community",
    role: "reply_generator",
    actions: ["reply_safe"],
    leaderId: "community-director",
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
    actions: ["generate_note"],
    leaderId: "note-operations-director",
  },
  {
    id: "note-operations-director",
    name: "note Operations Director",
    department: "note",
    role: "leader",
    actions: ["generate_note"],
  },
  {
    id: "engagement-analyst",
    name: "Engagement Analyst",
    department: "community",
    role: "analyst",
    actions: [],
    leaderId: "community-director",
  },
  {
    id: "reply-manager",
    name: "Reply Manager",
    department: "community",
    role: "reply_manager",
    actions: [],
    leaderId: "community-director",
  },
  {
    id: "community-director",
    name: "Community Director",
    department: "community",
    role: "leader",
    actions: ["fetch_engagement", "reply_safe"],
  },
  {
    id: "cadence-optimizer",
    name: "Cadence Optimizer",
    department: "optimization",
    role: "optimizer",
    actions: ["optimize_schedule", "weekly_retro", "notify"],
    leaderId: "optimization-director",
  },
  {
    id: "optimization-director",
    name: "Optimization Director",
    department: "optimization",
    role: "leader",
    actions: ["optimize_schedule", "weekly_retro", "notify"],
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
    research_threads: "threads-competitor-researcher",
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
