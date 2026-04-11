import { createHash } from "node:crypto";
import { createMemoryService, type MemoryService } from "../memory/index.js";

export interface CacheService {
  getJson<T>(scope: string, key: string): T | null;
  setJson<T>(scope: string, key: string, value: T, ttlSeconds: number): T;
  rememberJson<T>(
    scope: string,
    key: string,
    ttlSeconds: number,
    factory: () => Promise<T>,
  ): Promise<T>;
}

const CACHE_LAYER = "cache";

function nowMs(): number {
  return Date.now();
}

function buildCacheKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function resolveExpiry(ttlSeconds: number): string {
  return new Date(nowMs() + ttlSeconds * 1000).toISOString();
}

export function createCacheService(
  memoryService: MemoryService = createMemoryService(),
): CacheService {
  function getJson<T>(scope: string, key: string): T | null {
    const entry = memoryService.get(CACHE_LAYER, scope, buildCacheKey(key));
    if (!entry) {
      return null;
    }

    if (entry.expiresAt && new Date(entry.expiresAt).getTime() <= nowMs()) {
      memoryService.delete(CACHE_LAYER, scope, buildCacheKey(key));
      return null;
    }

    try {
      return JSON.parse(entry.value) as T;
    } catch {
      memoryService.delete(CACHE_LAYER, scope, buildCacheKey(key));
      return null;
    }
  }

  function setJson<T>(
    scope: string,
    key: string,
    value: T,
    ttlSeconds: number,
  ): T {
    memoryService.set(
      CACHE_LAYER,
      scope,
      buildCacheKey(key),
      JSON.stringify(value),
      { expiresAt: resolveExpiry(ttlSeconds) },
    );
    return value;
  }

  async function rememberJson<T>(
    scope: string,
    key: string,
    ttlSeconds: number,
    factory: () => Promise<T>,
  ): Promise<T> {
    const cached = getJson<T>(scope, key);
    if (cached !== null) {
      return cached;
    }

    const value = await factory();
    return setJson(scope, key, value, ttlSeconds);
  }

  return {
    getJson,
    setJson,
    rememberJson,
  };
}
