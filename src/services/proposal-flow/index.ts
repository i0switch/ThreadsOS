import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { proposalEvents, proposals } from "../../db/schema.js";

export interface ProposalChain {
  workerId: string;
  leaderId: string | null;
  executiveId: string | null;
}

export interface CreateProposalInput {
  agentId: string;
  leaderAgentId?: string | null;
  executiveAgentId?: string | null;
  department: string;
  title: string;
  description: string;
  reason: string;
  evidence: string;
  expectedEffect: string;
  risk?: string | null;
  priority?: string;
  metadata?: Record<string, unknown>;
}

export interface ProposalFlowService {
  createHierarchicalProposal(input: CreateProposalInput): string;
  approveProposal(id: string, actorId: string, note?: string): void;
  rejectProposal(id: string, actorId: string, note?: string): void;
  getHistory(proposalId: string): Array<{
    id: string;
    stage: string;
    action: string;
    actorId: string;
    note: string | null;
    metadataJson: string | null;
    createdAt: string;
  }>;
}

function logEvent(params: {
  proposalId: string;
  stage: string;
  action: string;
  actorId: string;
  note?: string | null;
  metadata?: Record<string, unknown>;
}): void {
  db.insert(proposalEvents)
    .values({
      id: randomUUID(),
      proposalId: params.proposalId,
      stage: params.stage,
      action: params.action,
      actorId: params.actorId,
      note: params.note ?? null,
      metadataJson: params.metadata ? JSON.stringify(params.metadata) : null,
      createdAt: new Date().toISOString(),
    })
    .run();
}

export function createProposalFlowService(): ProposalFlowService {
  function createHierarchicalProposal(input: CreateProposalInput): string {
    const now = new Date().toISOString();
    const proposalId = randomUUID();

    db.insert(proposals)
      .values({
        id: proposalId,
        agentId: input.agentId,
        leaderAgentId: input.leaderAgentId ?? null,
        executiveAgentId: input.executiveAgentId ?? null,
        department: input.department,
        title: input.title,
        description: input.description,
        reason: input.reason,
        evidence: input.evidence,
        expectedEffect: input.expectedEffect,
        risk: input.risk ?? null,
        priority: input.priority ?? "medium",
        status: "pending",
        currentStage: "human_review",
        currentApproverId: "dashboard-human",
        reviewerNote: null,
        reviewedAt: null,
        executedAt: null,
        createdAt: now,
      })
      .run();

    logEvent({
      proposalId,
      stage: "leader_review",
      action: "created",
      actorId: input.agentId,
      note: "担当者が提案を作成",
      metadata: input.metadata,
    });

    if (input.leaderAgentId) {
      logEvent({
        proposalId,
        stage: "leader_review",
        action: "approved",
        actorId: input.leaderAgentId,
        note: "部署リーダーが提案を統合して上申",
      });
    }

    if (input.executiveAgentId) {
      logEvent({
        proposalId,
        stage: "executive_review",
        action: "approved",
        actorId: input.executiveAgentId,
        note: "管理・指揮系統が人間レビューへ送付",
      });
    }

    logEvent({
      proposalId,
      stage: "human_review",
      action: "queued",
      actorId: "dashboard-human",
      note: "人間ダッシュボードでの承認待ち",
    });

    return proposalId;
  }

  function approveProposal(id: string, actorId: string, note?: string): void {
    const now = new Date().toISOString();
    db.update(proposals)
      .set({
        status: "approved",
        currentStage: "approved",
        currentApproverId: null,
        reviewerNote: note ?? null,
        reviewedAt: now,
      })
      .where(eq(proposals.id, id))
      .run();

    logEvent({
      proposalId: id,
      stage: "human_review",
      action: "approved",
      actorId,
      note: note ?? "人間が提案を承認",
    });
  }

  function rejectProposal(id: string, actorId: string, note?: string): void {
    const now = new Date().toISOString();
    db.update(proposals)
      .set({
        status: "rejected",
        currentStage: "rejected",
        currentApproverId: null,
        reviewerNote: note ?? null,
        reviewedAt: now,
      })
      .where(eq(proposals.id, id))
      .run();

    logEvent({
      proposalId: id,
      stage: "human_review",
      action: "rejected",
      actorId,
      note: note ?? "人間が提案を差し戻し",
    });
  }

  function getHistory(proposalId: string) {
    return db
      .select()
      .from(proposalEvents)
      .where(eq(proposalEvents.proposalId, proposalId))
      .orderBy(asc(proposalEvents.createdAt))
      .all();
  }

  return {
    createHierarchicalProposal,
    approveProposal,
    rejectProposal,
    getHistory,
  };
}
