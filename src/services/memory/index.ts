import { randomUUID } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { db } from "../../db/index.js";
import { memoryEntries } from "../../db/schema.js";

export interface MemoryEntry {
  id: string;
  layer: string;
  scope: string;
  key: string;
  value: string;
  version: number;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryService {
  get(layer: string, scope: string, key: string): MemoryEntry | null;
  set(
    layer: string,
    scope: string,
    key: string,
    value: string,
    options?: { expiresAt?: string | null },
  ): void;
  delete(layer: string, scope: string, key: string): void;
  listByLayer(layer: string, scope?: string): MemoryEntry[];
  promote(fromLayer: string, toLayer: string, scope: string, key: string): void;
  expireWorking(): number;
}

export function createMemoryService(): MemoryService {
  function get(layer: string, scope: string, key: string): MemoryEntry | null {
    const rows = db
      .select()
      .from(memoryEntries)
      .where(
        and(
          eq(memoryEntries.layer, layer),
          eq(memoryEntries.scope, scope),
          eq(memoryEntries.key, key),
        ),
      )
      .all();
    if (rows.length === 0) return null;
    return rows[0] as MemoryEntry;
  }

  function set(
    layer: string,
    scope: string,
    key: string,
    value: string,
    options?: { expiresAt?: string | null },
  ): void {
    const now = new Date().toISOString();
    const existing = get(layer, scope, key);
    if (existing) {
      db.update(memoryEntries)
        .set({
          value,
          version: existing.version + 1,
          expiresAt: options?.expiresAt ?? existing.expiresAt,
          updatedAt: now,
        })
        .where(eq(memoryEntries.id, existing.id))
        .run();
    } else {
      db.insert(memoryEntries)
        .values({
          id: randomUUID(),
          layer,
          scope,
          key,
          value,
          version: 1,
          expiresAt: options?.expiresAt ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }
  }

  function del(layer: string, scope: string, key: string): void {
    db.delete(memoryEntries)
      .where(
        and(
          eq(memoryEntries.layer, layer),
          eq(memoryEntries.scope, scope),
          eq(memoryEntries.key, key),
        ),
      )
      .run();
  }

  function listByLayer(layer: string, scope?: string): MemoryEntry[] {
    if (scope) {
      return db
        .select()
        .from(memoryEntries)
        .where(
          and(eq(memoryEntries.layer, layer), eq(memoryEntries.scope, scope)),
        )
        .all() as MemoryEntry[];
    }
    return db
      .select()
      .from(memoryEntries)
      .where(eq(memoryEntries.layer, layer))
      .all() as MemoryEntry[];
  }

  function promote(
    fromLayer: string,
    toLayer: string,
    scope: string,
    key: string,
  ): void {
    const entry = get(fromLayer, scope, key);
    if (!entry) return;
    set(toLayer, scope, key, entry.value);
    del(fromLayer, scope, key);
  }

  function expireWorking(): number {
    const now = new Date().toISOString();
    const expired = db
      .select()
      .from(memoryEntries)
      .where(
        and(
          eq(memoryEntries.layer, "working_memory"),
          lt(memoryEntries.expiresAt, now),
        ),
      )
      .all();

    for (const entry of expired) {
      db.delete(memoryEntries).where(eq(memoryEntries.id, entry.id)).run();
    }
    return expired.length;
  }

  return {
    get,
    set,
    delete: del,
    listByLayer,
    promote,
    expireWorking,
  };
}
