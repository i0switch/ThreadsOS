import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../index.js";
import {
  CAMPAIGN_BOTTLENECKS,
  CAMPAIGN_STATUSES,
  type CampaignBottleneck,
  type CampaignStatus,
  campaigns,
} from "../schema.js";

export interface CampaignRow {
  id: string;
  name: string;
  theme: string;
  bottleneckFocus: CampaignBottleneck | null;
  status: CampaignStatus;
  startedAt: string;
  endedAt: string | null;
  reasoning: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCampaignInput {
  name: string;
  theme: string;
  bottleneckFocus?: CampaignBottleneck | null;
  reasoning?: string | null;
  startedAt?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function assertStatus(value: string): CampaignStatus {
  if (!(CAMPAIGN_STATUSES as readonly string[]).includes(value)) {
    throw new Error(`invalid campaign status: ${value}`);
  }
  return value as CampaignStatus;
}

function assertBottleneck(value: string | null): CampaignBottleneck | null {
  if (value === null) return null;
  if (!(CAMPAIGN_BOTTLENECKS as readonly string[]).includes(value)) {
    throw new Error(`invalid campaign bottleneck: ${value}`);
  }
  return value as CampaignBottleneck;
}

function mapRow(row: typeof campaigns.$inferSelect): CampaignRow {
  return {
    id: row.id,
    name: row.name,
    theme: row.theme,
    bottleneckFocus: assertBottleneck(row.bottleneckFocus ?? null),
    status: assertStatus(row.status),
    startedAt: row.startedAt,
    endedAt: row.endedAt ?? null,
    reasoning: row.reasoning ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createCampaignRepository() {
  return {
    listActive(): CampaignRow[] {
      const rows = db
        .select()
        .from(campaigns)
        .where(eq(campaigns.status, "active"))
        .orderBy(desc(campaigns.startedAt))
        .all();
      return rows.map(mapRow);
    },

    listByStatus(status: CampaignStatus): CampaignRow[] {
      const rows = db
        .select()
        .from(campaigns)
        .where(eq(campaigns.status, status))
        .orderBy(desc(campaigns.startedAt))
        .all();
      return rows.map(mapRow);
    },

    findById(id: string): CampaignRow | null {
      const row = db.select().from(campaigns).where(eq(campaigns.id, id)).get();
      return row ? mapRow(row) : null;
    },

    create(input: CreateCampaignInput): CampaignRow {
      const bottleneckFocus =
        input.bottleneckFocus === undefined
          ? null
          : assertBottleneck(input.bottleneckFocus);
      const now = nowIso();
      const row = {
        id: randomUUID(),
        name: input.name,
        theme: input.theme,
        bottleneckFocus,
        status: "active" as CampaignStatus,
        startedAt: input.startedAt ?? now,
        endedAt: null,
        reasoning: input.reasoning ?? null,
        createdAt: now,
        updatedAt: now,
      };
      db.insert(campaigns).values(row).run();
      return row;
    },

    updateStatus(
      id: string,
      status: CampaignStatus,
      reasoning?: string | null,
    ): CampaignRow | null {
      const now = nowIso();
      const existing = db
        .select()
        .from(campaigns)
        .where(eq(campaigns.id, id))
        .get();
      if (!existing) return null;

      const endedAt =
        status === "archived"
          ? (existing.endedAt ?? now)
          : status === "active"
            ? null
            : existing.endedAt;

      db.update(campaigns)
        .set({
          status,
          endedAt,
          reasoning: reasoning !== undefined ? reasoning : existing.reasoning,
          updatedAt: now,
        })
        .where(eq(campaigns.id, id))
        .run();

      const updated = db
        .select()
        .from(campaigns)
        .where(eq(campaigns.id, id))
        .get();
      return updated ? mapRow(updated) : null;
    },

    setBottleneckFocus(
      id: string,
      bottleneck: CampaignBottleneck | null,
    ): CampaignRow | null {
      const checked = assertBottleneck(bottleneck);
      const now = nowIso();
      const existing = db
        .select()
        .from(campaigns)
        .where(eq(campaigns.id, id))
        .get();
      if (!existing) return null;

      db.update(campaigns)
        .set({ bottleneckFocus: checked, updatedAt: now })
        .where(eq(campaigns.id, id))
        .run();

      const updated = db
        .select()
        .from(campaigns)
        .where(and(eq(campaigns.id, id)))
        .get();
      return updated ? mapRow(updated) : null;
    },
  };
}

export type CampaignRepository = ReturnType<typeof createCampaignRepository>;
