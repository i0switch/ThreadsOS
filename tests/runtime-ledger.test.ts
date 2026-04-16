import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../src/db/schema.js";

vi.mock("../src/db/index.js", () => {
  const sqlite = new Database(":memory:");
  const mockDb = drizzle(sqlite, { schema });
  return { db: mockDb };
});

import { ensureAutonomyTables } from "../src/db/bootstrap.js";
import { db } from "../src/db/index.js";
import { createRuntimeLedgerRepository } from "../src/db/repositories/runtime-ledger.js";

describe("runtime-ledger repository", () => {
  beforeEach(() => {
    ensureAutonomyTables();
    db.delete(schema.executionOutbox).run();
    db.delete(schema.funnelSnapshots).run();
    db.delete(schema.jobLeases).run();
    db.delete(schema.jobRuns).run();
    db.delete(schema.publicationEvents).run();
    db.delete(schema.decisionEvidence).run();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects duplicate outbox enqueue by idempotency key", () => {
    const repo = createRuntimeLedgerRepository();

    const first = repo.enqueueOutbox({
      idempotencyKey: "dup-key",
      targetPlatform: "threads",
      operationType: "publish",
      payload: { body: "hello" },
    });
    const second = repo.enqueueOutbox({
      idempotencyKey: "dup-key",
      targetPlatform: "threads",
      operationType: "publish",
      payload: { body: "hello" },
    });

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(first.id).toBe(second.id);
    expect(db.select().from(schema.executionOutbox).all()).toHaveLength(1);
  });

  it("claims, completes, and retries outbox rows until quarantine", () => {
    const repo = createRuntimeLedgerRepository();
    const outbox = repo.enqueueOutbox({
      idempotencyKey: "claim-key",
      targetPlatform: "note",
      operationType: "publish",
      payload: { title: "note" },
    });

    expect(repo.claimOutbox(outbox.id, "worker-1")).toBe(true);
    expect(repo.claimOutbox(outbox.id, "worker-2")).toBe(false);

    const firstFail = repo.failOutbox(outbox.id, "boom", {
      quarantineThreshold: 3,
    });
    expect(firstFail.status).toBe("pending");
    const pendingRow = db.select().from(schema.executionOutbox).all()[0];
    expect(pendingRow.status).toBe("pending");
    expect(pendingRow.lastError).toBe("boom");

    repo.claimOutbox(outbox.id, "worker-1");
    repo.failOutbox(outbox.id, "boom2", { quarantineThreshold: 3 });
    repo.claimOutbox(outbox.id, "worker-1");
    const quarantined = repo.failOutbox(outbox.id, "boom3", {
      quarantineThreshold: 3,
    });
    expect(quarantined.status).toBe("quarantined");

    const finalRow = db.select().from(schema.executionOutbox).all()[0];
    expect(finalRow.status).toBe("quarantined");

    // completeOutbox still transitions to completed regardless
    repo.completeOutbox(outbox.id);
    const completedRow = db.select().from(schema.executionOutbox).all()[0];
    expect(completedRow.status).toBe("completed");
  });

  it("rejects duplicate publication_events by external_fingerprint", () => {
    const repo = createRuntimeLedgerRepository();
    const publishedAt = new Date().toISOString();

    repo.insertPublicationEvent({
      targetPlatform: "threads",
      externalFingerprint: "fp-1",
      publishedAt,
    });

    expect(() =>
      repo.insertPublicationEvent({
        targetPlatform: "threads",
        externalFingerprint: "fp-1",
        publishedAt,
      }),
    ).toThrow();
  });

  it("re-acquires a lease after it has expired", () => {
    const repo = createRuntimeLedgerRepository();
    const pastExpiresAt = new Date(Date.now() - 1000).toISOString();
    const freshExpiresAt = new Date(Date.now() + 60_000).toISOString();

    expect(
      repo.acquireJobLease({
        leaseKey: "job:expiring",
        ownerId: "owner-A",
        expiresAt: pastExpiresAt,
      }),
    ).toBe(true);

    // expired lease should be purged and reacquirable by a new owner
    expect(
      repo.acquireJobLease({
        leaseKey: "job:expiring",
        ownerId: "owner-B",
        expiresAt: freshExpiresAt,
      }),
    ).toBe(true);
  });

  it("stores and reads funnel snapshots", () => {
    const repo = createRuntimeLedgerRepository();

    repo.upsertFunnelSnapshot({
      periodKey: "2026-04-14T22",
      periodType: "hourly",
      impressions: 1000,
      profileTransitions: 80,
      noteClicks: 30,
      noteViews: 20,
      purchases: 4,
      revenue: 3920,
    });

    repo.upsertFunnelSnapshot({
      periodKey: "2026-04-14T22",
      periodType: "hourly",
      impressions: 1100,
      profileTransitions: 90,
      noteClicks: 32,
      noteViews: 21,
      purchases: 5,
      revenue: 4900,
    });

    const snapshots = repo.listFunnelSnapshots(5);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].impressions).toBe(1100);
    expect(snapshots[0].revenue).toBe(4900);
  });

  it("acquires a lease once and releases it", () => {
    const repo = createRuntimeLedgerRepository();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    expect(
      repo.acquireJobLease({
        leaseKey: "job:heartbeat",
        ownerId: "owner-1",
        expiresAt,
      }),
    ).toBe(true);
    expect(
      repo.acquireJobLease({
        leaseKey: "job:heartbeat",
        ownerId: "owner-2",
        expiresAt,
      }),
    ).toBe(false);

    repo.releaseJobLease("job:heartbeat", "owner-1");

    expect(
      repo.acquireJobLease({
        leaseKey: "job:heartbeat",
        ownerId: "owner-2",
        expiresAt,
      }),
    ).toBe(true);
  });
});
