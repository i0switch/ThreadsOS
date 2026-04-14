import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { agentStates, proposals } from "../../db/schema.js";
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
    name: "総合指揮官",
    department: "command",
    role: "executive",
    actions: ["process_human_inputs", "notify"],
  },
  {
    id: "trend-researcher",
    name: "トレンド調査員",
    department: "external-research",
    role: "researcher",
    actions: ["research_threads"],
    leaderId: "research-director",
  },
  {
    id: "research-director",
    name: "リサーチ部長",
    department: "external-research",
    role: "leader",
    actions: ["research_threads"],
  },
  {
    id: "threads-competitor-researcher",
    name: "Threads競合調査員",
    department: "competitive-analysis",
    role: "competitor_research",
    actions: ["research_threads", "fetch_competitor_updates"],
    leaderId: "competitive-analysis-director",
  },
  {
    id: "note-competitor-researcher",
    name: "note競合調査員",
    department: "competitive-analysis",
    role: "competitor_research",
    actions: ["research_note", "fetch_competitor_updates"],
    leaderId: "competitive-analysis-director",
  },
  {
    id: "threads-post-generator",
    name: "Threads投稿生成員",
    department: "threads",
    role: "generator",
    actions: ["generate_and_post"],
    leaderId: "threads-operations-director",
  },
  {
    id: "threads-operations-director",
    name: "Threads運用部長",
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
    name: "Threadsエンゲージメント調査員",
    department: "threads",
    role: "analyst",
    actions: ["fetch_engagement"],
    leaderId: "threads-operations-director",
  },
  {
    id: "threads-reply-generator",
    name: "Threads返信生成員",
    department: "threads",
    role: "reply_generator",
    actions: ["reply_safe"],
    leaderId: "threads-operations-director",
  },
  {
    id: "note-article-generator",
    name: "note記事生成員",
    department: "note",
    role: "generator",
    actions: ["generate_note"],
    leaderId: "note-operations-director",
  },
  {
    id: "note-engagement-analyst",
    name: "noteエンゲージメント調査員",
    department: "note",
    role: "analyst",
    actions: ["generate_note", "optimize_schedule"],
    leaderId: "note-operations-director",
  },
  {
    id: "note-operations-director",
    name: "note運用部長",
    department: "note",
    role: "leader",
    actions: ["research_note", "generate_note", "optimize_schedule"],
  },
  {
    id: "engagement-analyst",
    name: "エンゲージメント分析官",
    department: "competitive-analysis",
    role: "analyst",
    actions: ["analyze_competitors"],
    leaderId: "competitive-analysis-director",
  },
  {
    id: "competitive-analysis-director",
    name: "競合分析部長",
    department: "competitive-analysis",
    role: "leader",
    actions: ["analyze_competitors", "fetch_competitor_updates"],
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
    analyze_competitors: "engagement-analyst",
    fetch_competitor_updates: "threads-competitor-researcher",
    generate_and_post: "threads-post-generator",
    generate_note: "note-article-generator",
    fetch_engagement: "threads-engagement-analyst",
    reply_safe: "threads-reply-generator",
    weekly_retro: "threads-operations-director",
    optimize_schedule: "threads-operations-director",
    notify: "executive-director",
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
        name: agent.name,
        department: agent.department,
        role: agent.role,
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
    // Clean up agents no longer in catalog
    const validIds = AGENTS.map((a) => a.id);
    db.delete(agentStates)
      .where(
        sql`${agentStates.id} NOT IN (${sql.join(
          validIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      )
      .run();

    // Clean up orphaned proposals pointing to deleted approvers
    // (Executive自律承認が有効なため、executive-director以外の承認待ちは全てorphan)
    db.update(proposals)
      .set({
        status: "rejected",
        currentStage: "rejected",
        reviewerNote: "Auto-rejected: approver no longer exists (Executive自律承認に移行済み)",
        reviewedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(proposals.status, "pending"),
          sql`${proposals.currentApproverId} NOT IN ('executive-director', 'dashboard-human')`,
        ),
      )
      .run();
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
