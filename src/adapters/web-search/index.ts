import { logger } from "../../app/logger.js";
import { loadEnv } from "../../config/env.js";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchClient {
  search(query: string, options?: { count?: number }): Promise<WebSearchResult[]>;
}

export class JinaSearchClient implements WebSearchClient {
  private apiKey: string | undefined;
  private initialized = false;

  private ensureInit(): void {
    if (!this.initialized) {
      this.apiKey = loadEnv().JINA_API_KEY;
      this.initialized = true;
    }
  }

  async search(query: string, options?: { count?: number }): Promise<WebSearchResult[]> {
    this.ensureInit();

    const count = options?.count ?? 5;
    const url = `https://s.jina.ai/${encodeURIComponent(query)}`;

    try {
      const headers: Record<string, string> = {
        Accept: "application/json",
      };
      if (this.apiKey) {
        headers["Authorization"] = `Bearer ${this.apiKey}`;
      }

      const response = await fetch(url, { headers });

      if (!response.ok) {
        logger.error({ status: response.status, statusText: response.statusText }, "Jina Search API failed");
        return [];
      }

      const data = await response.json();
      interface JinaSearchResult {
        title?: string;
        url?: string;
        description?: string;
      }

      const results: JinaSearchResult[] = Array.isArray(data.data) ? data.data : (Array.isArray(data) ? data : []);

      return results.slice(0, count).map((r: JinaSearchResult) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: r.description ?? "",
      }));
    } catch (error) {
      logger.error({ error, query }, "Error executing web search");
      return [];
    }
  }
}

export class DryRunWebSearchClient implements WebSearchClient {
  async search(query: string, options?: { count?: number }): Promise<WebSearchResult[]> {
    logger.info({ query, options }, "[DRY-RUN] Web search");
    return [];
  }
}
