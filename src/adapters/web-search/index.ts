import { logger } from "../../app/logger.js";
import { loadEnv } from "../../config/env.js";
import { createCacheService } from "../../services/cache/index.js";
import { waitForRateLimit } from "../../utils/network-policy.js";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchClient {
  search(
    query: string,
    options?: { count?: number },
  ): Promise<WebSearchResult[]>;
}

export class JinaSearchClient implements WebSearchClient {
  private apiKey: string | undefined;
  private initialized = false;
  private cache = createCacheService();

  private ensureInit(): void {
    if (!this.initialized) {
      this.apiKey = loadEnv().JINA_API_KEY;
      this.initialized = true;
    }
  }

  async search(
    query: string,
    options?: { count?: number },
  ): Promise<WebSearchResult[]> {
    this.ensureInit();

    const count = options?.count ?? 5;
    const cacheKey = `${query}::${count}`;
    const url = `https://s.jina.ai/${encodeURIComponent(query)}`;
    const rateLimitMs = loadEnv().SCRAPER_RATE_LIMIT_MS;

    try {
      const cached = this.cache.getJson<WebSearchResult[]>(
        "web-search",
        cacheKey,
      );
      if (cached) {
        return cached.slice(0, count);
      }

      const headers: Record<string, string> = {
        Accept: "application/json",
      };
      if (this.apiKey) {
        headers.Authorization = `Bearer ${this.apiKey}`;
      }

      await waitForRateLimit("jina-search", rateLimitMs);
      const response = await fetch(url, { headers });

      if (!response.ok) {
        logger.error(
          { status: response.status, statusText: response.statusText },
          "Jina Search API failed",
        );
        return [];
      }

      const data = await response.json();
      interface JinaSearchResult {
        title?: string;
        url?: string;
        description?: string;
      }

      const results: JinaSearchResult[] = Array.isArray(data.data)
        ? data.data
        : Array.isArray(data)
          ? data
          : [];

      const normalized = results.slice(0, count).map((r: JinaSearchResult) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: r.description ?? "",
      }));
      this.cache.setJson("web-search", cacheKey, normalized, 6 * 60 * 60);
      return normalized;
    } catch (error) {
      logger.error({ error, query }, "Error executing web search");
      return [];
    }
  }
}

export class DryRunWebSearchClient implements WebSearchClient {
  async search(
    query: string,
    options?: { count?: number },
  ): Promise<WebSearchResult[]> {
    logger.info({ query, options }, "[DRY-RUN] Web search");
    return [];
  }
}
