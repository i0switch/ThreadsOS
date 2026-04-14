import { AsyncLocalStorage } from "node:async_hooks";

const dashboardQueryCacheStorage =
  new AsyncLocalStorage<Map<string, unknown>>();

function buildCacheKey(name: string, args: unknown[]): string {
  return `${name}:${JSON.stringify(args, (_key, value) =>
    value === undefined ? "__dashboard_query_undefined__" : value,
  )}`;
}

export function withDashboardQueryCache<T>(compute: () => T): T {
  if (dashboardQueryCacheStorage.getStore()) {
    return compute();
  }

  return dashboardQueryCacheStorage.run(new Map<string, unknown>(), compute);
}

const GLOBAL_TTL_MS = 10_000;
const globalCache = new Map<string, { value: unknown; expiry: number }>();

export function clearGlobalDashboardCache(): void {
  globalCache.clear();
}

export function memoizeDashboardQuery<T>(
  name: string,
  args: unknown[],
  compute: () => T,
): T {
  const key = buildCacheKey(name, args);
  const cache = dashboardQueryCacheStorage.getStore();

  // Layer 1: request-scoped cache (checked first for reference stability within a request)
  if (cache) {
    if (cache.has(key)) {
      return cache.get(key) as T;
    }
  }

  // Layer 2: global TTL cache (structuredClone to preserve reference isolation between requests)
  const globalEntry = globalCache.get(key);
  if (globalEntry && Date.now() < globalEntry.expiry) {
    const cloned = structuredClone(globalEntry.value) as T;
    if (cache) {
      cache.set(key, cloned);
    }
    return cloned;
  }

  const value = compute();

  // Store in both layers
  globalCache.set(key, { value, expiry: Date.now() + GLOBAL_TTL_MS });
  if (cache) {
    cache.set(key, value);
  }

  return value;
}