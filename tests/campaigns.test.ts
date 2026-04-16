import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../src/db/schema.js";

vi.mock("../src/db/index.js", () => {
  const sqlite = new Database(":memory:");
  const mockDb = drizzle(sqlite, { schema });
  return { db: mockDb };
});

import { ensureAutonomyTables } from "../src/db/bootstrap.js";
import { db } from "../src/db/index.js";
import { createCampaignRepository } from "../src/db/repositories/campaigns.js";
import {
  getCampaignRevenue,
  listCampaignSummaries,
} from "../src/services/dashboard-observation/index.js";

describe("campaigns repository", () => {
  beforeEach(() => {
    ensureAutonomyTables();
    db.delete(schema.campaigns).run();
    db.delete(schema.revenueEvents).run();
    db.delete(schema.noteMetrics).run();
    db.delete(schema.threadsMetrics).run();
  });

  it("creates an active campaign and lists it", () => {
    const repo = createCampaignRepository();

    const created = repo.create({
      name: "春キャンペーン",
      theme: "note収益化",
      bottleneckFocus: "Click",
    });

    expect(created.status).toBe("active");
    expect(created.bottleneckFocus).toBe("Click");

    const active = repo.listActive();
    expect(active).toHaveLength(1);
    expect(active[0]?.id).toBe(created.id);
  });

  it("excludes archived campaigns from listActive", () => {
    const repo = createCampaignRepository();
    const created = repo.create({ name: "test", theme: "t" });

    const archived = repo.updateStatus(created.id, "archived", "終了");
    expect(archived?.status).toBe("archived");
    expect(archived?.endedAt).not.toBeNull();
    expect(archived?.reasoning).toBe("終了");

    expect(repo.listActive()).toHaveLength(0);
    expect(repo.listByStatus("archived")).toHaveLength(1);
  });

  it("updates bottleneckFocus", () => {
    const repo = createCampaignRepository();
    const created = repo.create({ name: "test", theme: "t" });

    const updated = repo.setBottleneckFocus(created.id, "Buy");
    expect(updated?.bottleneckFocus).toBe("Buy");

    const cleared = repo.setBottleneckFocus(created.id, null);
    expect(cleared?.bottleneckFocus).toBeNull();
  });

  it("rejects invalid bottleneck value", () => {
    const repo = createCampaignRepository();
    const created = repo.create({ name: "test", theme: "t" });
    expect(() =>
      repo.setBottleneckFocus(created.id, "Invalid" as unknown as "Reach"),
    ).toThrow(/invalid campaign bottleneck/);
  });

  it("findById returns null for missing campaign", () => {
    const repo = createCampaignRepository();
    expect(repo.findById(randomUUID())).toBeNull();
  });
});

describe("dashboard-observation campaign aggregation", () => {
  beforeEach(() => {
    ensureAutonomyTables();
    db.delete(schema.campaigns).run();
    db.delete(schema.revenueEvents).run();
    db.delete(schema.noteMetrics).run();
    db.delete(schema.threadsMetrics).run();
  });

  it("aggregates revenue_events and latest metrics for a campaign", () => {
    const repo = createCampaignRepository();
    const campaign = repo.create({
      name: "夏キャンペーン",
      theme: "有料note",
      bottleneckFocus: "Buy",
    });

    const now = new Date().toISOString();
    db.insert(schema.revenueEvents)
      .values([
        {
          id: randomUUID(),
          campaignId: campaign.id,
          amountYen: 1500,
          purchasesCount: 1,
          occurredAt: now,
          createdAt: now,
        },
        {
          id: randomUUID(),
          campaignId: campaign.id,
          amountYen: 2500,
          purchasesCount: 2,
          occurredAt: now,
          createdAt: now,
        },
      ])
      .run();

    db.insert(schema.noteMetrics)
      .values({
        id: randomUUID(),
        campaignId: campaign.id,
        noteClicks: 40,
        noteViews: 30,
        purchases: 3,
        revenue: 4000,
        conversionRate: 0.1,
        capturedAt: now,
        createdAt: now,
      })
      .run();

    db.insert(schema.threadsMetrics)
      .values({
        id: randomUUID(),
        campaignId: campaign.id,
        impressions: 1000,
        likes: 50,
        replies: 10,
        shares: 5,
        profileTransitions: 100,
        capturedAt: now,
        createdAt: now,
      })
      .run();

    const summary = getCampaignRevenue(campaign.id);
    expect(summary).not.toBeNull();
    expect(summary?.totalRevenueYen).toBe(4000);
    expect(summary?.totalPurchases).toBe(3);
    expect(summary?.latestSnapshot?.impressions).toBe(1000);
    expect(summary?.latestSnapshot?.purchases).toBe(3);
    expect(summary?.latestSnapshot?.revenue).toBe(4000);

    const list = listCampaignSummaries();
    expect(list).toHaveLength(1);
    expect(list[0]?.campaignId).toBe(campaign.id);

    const activeList = listCampaignSummaries({ status: "active" });
    expect(activeList).toHaveLength(1);

    const archivedList = listCampaignSummaries({ status: "archived" });
    expect(archivedList).toHaveLength(0);
  });

  it("returns null for unknown campaignId", () => {
    expect(getCampaignRevenue(randomUUID())).toBeNull();
  });
});
