import { createHash, randomUUID } from "node:crypto";
import { and, eq, lte } from "drizzle-orm";
import { db } from "../index.js";
import {
  anomalyEvents,
  decisionEvidence,
  executionOutbox,
  funnelSnapshots,
  jobLeases,
  jobRuns,
  publicationEvents,
  sessionHealth,
} from "../schema.js";

export type OutboxStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "quarantined";

export const OUTBOX_QUARANTINE_THRESHOLD = 5;
export const OUTBOX_RETRY_BACKOFF_MS = 60_000;

export interface FunnelSnapshotInput {
  periodKey: string;
  periodType: string;
  impressions: number;
  profileTransitions: number;
  noteClicks: number;
  noteViews: number;
  purchases: number;
  revenue: number;
  capturedAt?: string;
}

export interface OutboxEntryInput {
  idempotencyKey: string;
  targetPlatform: string;
  operationType: string;
  payload: Record<string, unknown>;
  availableAt?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createRuntimeLedgerRepository() {
  return {
    acquireJobLease(input: {
      leaseKey: string;
      ownerId: string;
      heartbeatScope?: string;
      expiresAt: string;
    }): boolean {
      const now = nowIso();
      db.delete(jobLeases)
        .where(
          and(
            eq(jobLeases.leaseKey, input.leaseKey),
            lte(jobLeases.expiresAt, now),
          ),
        )
        .run();

      const inserted = db
        .insert(jobLeases)
        .values({
          id: randomUUID(),
          leaseKey: input.leaseKey,
          ownerId: input.ownerId,
          heartbeatScope: input.heartbeatScope ?? null,
          acquiredAt: now,
          expiresAt: input.expiresAt,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .run();

      return inserted.changes > 0;
    },

    releaseJobLease(leaseKey: string, ownerId?: string): void {
      if (ownerId) {
        db.delete(jobLeases)
          .where(
            and(
              eq(jobLeases.leaseKey, leaseKey),
              eq(jobLeases.ownerId, ownerId),
            ),
          )
          .run();
        return;
      }
      db.delete(jobLeases).where(eq(jobLeases.leaseKey, leaseKey)).run();
    },

    insertJobRun(input: {
      id?: string;
      jobName: string;
      leaseKey: string;
      ownerId: string;
      status: string;
      startedAt: string;
      dryRun?: boolean;
      resultSummary?: string | null;
    }): string {
      const id = input.id ?? randomUUID();
      db.insert(jobRuns)
        .values({
          id,
          jobName: input.jobName,
          leaseKey: input.leaseKey,
          ownerId: input.ownerId,
          status: input.status,
          startedAt: input.startedAt,
          finishedAt: null,
          dryRun: input.dryRun ? 1 : 0,
          resultSummary: input.resultSummary ?? null,
          createdAt: input.startedAt,
        })
        .run();
      return id;
    },

    updateJobRun(
      runId: string,
      updates: { status: string; finishedAt: string; resultSummary?: string },
    ): void {
      db.update(jobRuns)
        .set({
          status: updates.status,
          finishedAt: updates.finishedAt,
          resultSummary: updates.resultSummary ?? null,
        })
        .where(eq(jobRuns.id, runId))
        .run();
    },

    enqueueOutbox(input: OutboxEntryInput): {
      id: string;
      inserted: boolean;
      row: typeof executionOutbox.$inferSelect;
    } {
      const now = nowIso();
      const payloadJson = JSON.stringify(input.payload);
      const id = randomUUID();
      const inserted = db
        .insert(executionOutbox)
        .values({
          id,
          idempotencyKey: input.idempotencyKey,
          payloadHash: sha256(payloadJson),
          targetPlatform: input.targetPlatform,
          operationType: input.operationType,
          status: "pending",
          payloadJson,
          availableAt: input.availableAt ?? now,
          claimedBy: null,
          claimedAt: null,
          attempts: 0,
          lastError: null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .run();

      const row = db
        .select()
        .from(executionOutbox)
        .where(eq(executionOutbox.idempotencyKey, input.idempotencyKey))
        .get();

      if (!row) {
        throw new Error(`Failed to load outbox row: ${input.idempotencyKey}`);
      }

      return {
        id: row.id,
        inserted: inserted.changes > 0,
        row,
      };
    },

    claimOutbox(id: string, claimedBy: string): boolean {
      const claimedAt = nowIso();
      const row = db
        .select()
        .from(executionOutbox)
        .where(eq(executionOutbox.id, id))
        .get();
      if (!row || row.status !== "pending") {
        return false;
      }
      const result = db
        .update(executionOutbox)
        .set({
          status: "processing",
          claimedBy,
          claimedAt,
          attempts: row.attempts + 1,
          updatedAt: claimedAt,
        })
        .where(
          and(
            eq(executionOutbox.id, id),
            eq(executionOutbox.status, "pending"),
          ),
        )
        .run();

      return result.changes > 0;
    },

    completeOutbox(id: string): void {
      const now = nowIso();
      db.update(executionOutbox)
        .set({
          status: "completed",
          updatedAt: now,
        })
        .where(eq(executionOutbox.id, id))
        .run();
    },

    failOutbox(
      id: string,
      message: string,
      options: {
        quarantineThreshold?: number;
        retryBackoffMs?: number;
      } = {},
    ): { status: OutboxStatus; attempts: number; availableAt: string } {
      const now = nowIso();
      const threshold =
        options.quarantineThreshold ?? OUTBOX_QUARANTINE_THRESHOLD;
      const backoffMs = options.retryBackoffMs ?? OUTBOX_RETRY_BACKOFF_MS;
      const row = db
        .select()
        .from(executionOutbox)
        .where(eq(executionOutbox.id, id))
        .get();
      if (!row) {
        throw new Error(`Outbox row not found: ${id}`);
      }
      const nextStatus: OutboxStatus =
        row.attempts >= threshold ? "quarantined" : "pending";
      const nextAvailableAt =
        nextStatus === "pending"
          ? new Date(Date.now() + backoffMs * Math.max(1, row.attempts)).toISOString()
          : row.availableAt;
      db.update(executionOutbox)
        .set({
          status: nextStatus,
          lastError: message,
          availableAt: nextAvailableAt,
          updatedAt: now,
        })
        .where(eq(executionOutbox.id, id))
        .run();
      return {
        status: nextStatus,
        attempts: row.attempts,
        availableAt: nextAvailableAt,
      };
    },

    getOutboxById(id: string) {
      return db
        .select()
        .from(executionOutbox)
        .where(eq(executionOutbox.id, id))
        .get();
    },

    insertPublicationEvent(input: {
      targetPlatform: string;
      outboxId?: string;
      draftId?: string;
      slotId?: string;
      campaignId?: string;
      angleId?: string;
      ctaId?: string;
      priceVariantId?: string;
      canaryGroup?: string;
      externalId?: string;
      externalUrl?: string;
      externalFingerprint: string;
      publishedAt: string;
    }): void {
      db.insert(publicationEvents)
        .values({
          id: randomUUID(),
          targetPlatform: input.targetPlatform,
          outboxId: input.outboxId ?? null,
          draftId: input.draftId ?? null,
          slotId: input.slotId ?? null,
          campaignId: input.campaignId ?? null,
          angleId: input.angleId ?? null,
          ctaId: input.ctaId ?? null,
          priceVariantId: input.priceVariantId ?? null,
          canaryGroup: input.canaryGroup ?? null,
          externalId: input.externalId ?? null,
          externalUrl: input.externalUrl ?? null,
          externalFingerprint: input.externalFingerprint,
          publishedAt: input.publishedAt,
          createdAt: input.publishedAt,
        })
        .run();
    },

    recordDecisionEvidence(input: {
      entityType: string;
      entityId: string;
      decisionType: string;
      evidence: Record<string, unknown>;
    }): void {
      db.insert(decisionEvidence)
        .values({
          id: randomUUID(),
          entityType: input.entityType,
          entityId: input.entityId,
          decisionType: input.decisionType,
          evidenceJson: JSON.stringify(input.evidence),
          createdAt: nowIso(),
        })
        .run();
    },

    upsertFunnelSnapshot(input: FunnelSnapshotInput): string {
      const capturedAt = input.capturedAt ?? nowIso();
      const id = randomUUID();
      db.insert(funnelSnapshots)
        .values({
          id,
          periodKey: input.periodKey,
          periodType: input.periodType,
          impressions: input.impressions,
          profileTransitions: input.profileTransitions,
          noteClicks: input.noteClicks,
          noteViews: input.noteViews,
          purchases: input.purchases,
          revenue: input.revenue,
          capturedAt,
          createdAt: capturedAt,
        })
        .onConflictDoUpdate({
          target: [funnelSnapshots.periodType, funnelSnapshots.periodKey],
          set: {
            impressions: input.impressions,
            profileTransitions: input.profileTransitions,
            noteClicks: input.noteClicks,
            noteViews: input.noteViews,
            purchases: input.purchases,
            revenue: input.revenue,
            capturedAt,
          },
        })
        .run();

      const row = db
        .select()
        .from(funnelSnapshots)
        .where(
          and(
            eq(funnelSnapshots.periodType, input.periodType),
            eq(funnelSnapshots.periodKey, input.periodKey),
          ),
        )
        .get();

      return row?.id ?? id;
    },

    listFunnelSnapshots(limit = 10) {
      return db.select().from(funnelSnapshots).limit(limit).all();
    },

    updateSessionHealth(input: {
      scope: string;
      provider: string;
      state: "healthy" | "degraded" | "quarantined" | "recovered";
      detail?: string;
      metadata?: Record<string, unknown>;
    }): void {
      const now = nowIso();
      const existing = db
        .select()
        .from(sessionHealth)
        .where(eq(sessionHealth.scope, input.scope))
        .get();
      const baseFailures = existing?.consecutiveFailures ?? 0;
      const nextFailures =
        input.state === "healthy" || input.state === "recovered"
          ? 0
          : baseFailures + 1;
      const lastSuccessAt =
        input.state === "healthy" || input.state === "recovered"
          ? now
          : (existing?.lastSuccessAt ?? null);
      const lastFailureAt =
        input.state === "quarantined" || input.state === "degraded"
          ? now
          : (existing?.lastFailureAt ?? null);
      const metadataJson = input.metadata
        ? JSON.stringify(input.metadata)
        : (existing?.metadataJson ?? null);

      db.insert(sessionHealth)
        .values({
          scope: input.scope,
          provider: input.provider,
          state: input.state,
          consecutiveFailures: nextFailures,
          lastSuccessAt,
          lastFailureAt,
          detail: input.detail ?? existing?.detail ?? null,
          metadataJson,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: sessionHealth.scope,
          set: {
            provider: input.provider,
            state: input.state,
            consecutiveFailures: nextFailures,
            lastSuccessAt,
            lastFailureAt,
            detail: input.detail ?? existing?.detail ?? null,
            metadataJson,
            updatedAt: now,
          },
        })
        .run();
    },

    recordAnomaly(input: {
      category: string;
      severity: string;
      message: string;
      metadata?: Record<string, unknown>;
    }): void {
      const detectedAt = nowIso();
      db.insert(anomalyEvents)
        .values({
          id: randomUUID(),
          category: input.category,
          severity: input.severity,
          message: input.message,
          metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
          detectedAt,
          createdAt: detectedAt,
        })
        .run();
    },
  };
}
