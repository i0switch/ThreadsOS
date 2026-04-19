import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { proposalEvents, proposals } from "../../db/schema.js";

export interface CreateHierarchicalProposalInput {
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
}

export interface ProposalFlowService {
  createHierarchicalProposal(input: CreateHierarchicalProposalInput): string;
  approveProposal(proposalId: string, actorId: string, note?: string): void;
}

export function createProposalFlowService(): ProposalFlowService {
  function appendEvent(
    proposalId: string,
    stage: string,
    action: string,
    actorId: string,
    note?: string,
    metadataJson?: string,
  ): void {
    db.insert(proposalEvents)
      .values({
        id: randomUUID(),
        proposalId,
        stage,
        action,
        actorId,
        note: note ?? null,
        metadataJson: metadataJson ?? null,
        createdAt: new Date().toISOString(),
      })
      .run();
  }

  function createHierarchicalProposal(
    input: CreateHierarchicalProposalInput,
  ): string {
    const proposalId = randomUUID();
    const now = new Date().toISOString();
    const leaderAgentId = input.leaderAgentId ?? null;
    const executiveAgentId = input.executiveAgentId ?? null;
    const currentApproverId = executiveAgentId ?? leaderAgentId;

    db.insert(proposals)
      .values({
        id: proposalId,
        agentId: input.agentId,
        leaderAgentId,
        executiveAgentId,
        department: input.department,
        title: input.title,
        description: input.description,
        reason: input.reason,
        evidence: input.evidence,
        expectedEffect: input.expectedEffect,
        risk: input.risk ?? null,
        priority: input.priority ?? "medium",
        status: "pending",
        currentStage: "executive_review",
        currentApproverId,
        reviewerNote: null,
        reviewedAt: null,
        executedAt: null,
        createdAt: now,
      })
      .run();

    appendEvent(proposalId, "proposal", "created", input.agentId, undefined);
    if (leaderAgentId) {
      appendEvent(
        proposalId,
        "leader_review",
        "queued",
        leaderAgentId,
        undefined,
      );
    }
    if (executiveAgentId) {
      appendEvent(
        proposalId,
        "executive_review",
        "queued",
        executiveAgentId,
        undefined,
      );
    }

    return proposalId;
  }

  function approveProposal(
    proposalId: string,
    actorId: string,
    note?: string,
  ): void {
    const now = new Date().toISOString();
    db.update(proposals)
      .set({
        status: "approved",
        currentStage: "approved",
        currentApproverId: null,
        reviewerNote: note ?? null,
        reviewedAt: now,
      })
      .where(eq(proposals.id, proposalId))
      .run();

    appendEvent(proposalId, "executive_review", "approved", actorId, note);
  }

  return {
    createHierarchicalProposal,
    approveProposal,
  };
}
