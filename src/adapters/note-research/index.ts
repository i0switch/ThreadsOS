import { AppError } from "../../app/errors.js";
import { logger } from "../../app/logger.js";
import { loadEnv } from "../../config/env.js";
import { createCacheService } from "../../services/cache/index.js";
import {
  assertSafePublicUrl,
  waitForRateLimit,
} from "../../utils/network-policy.js";
import { JinaSearchClient, type WebSearchClient } from "../web-search/index.js";

export type NoteMode = "research_only" | "draft_assist" | "browser_assisted";

/**
 * NOTE_MODE の強制境界。
 * この関数を通さない限り note への書き込み系操作は実行不可。
 * adapter 層でガチガチに閉じることで、将来の修正で抜けるのを防ぐ。
 */
export function assertNoteMode(required: NoteMode[], current?: NoteMode): void {
  const env = loadEnv();
  const mode = current ?? env.NOTE_MODE;
  if (!required.includes(mode)) {
    throw new AppError(
      `NOTE_MODE="${mode}" ではこの操作は許可されていません。必要: ${required.join(" | ")}`,
      "NOTE_MODE_VIOLATION",
      403,
    );
  }
}

export interface NoteResearchClient {
  fetchPublicPage(
    url: string,
  ): Promise<{ title: string; content: string; author: string }>;
  searchNotes(
    query: string,
  ): Promise<Array<{ title: string; url: string; snippet: string }>>;
}

export class JinaReaderClient {
  private apiKey: string | undefined;
  private initialized = false;
  private cache = createCacheService();

  private ensureInit(): void {
    if (!this.initialized) {
      this.apiKey = loadEnv().JINA_API_KEY;
      this.initialized = true;
    }
  }

  async read(
    url: string,
  ): Promise<{ title: string; content: string; author: string } | null> {
    this.ensureInit();
    const env = loadEnv();
    const safeUrl = assertSafePublicUrl(url, {
      allowSubdomainsOf: ["note.com"],
      requireHttps: true,
    });
    const endpoint = `https://r.jina.ai/${safeUrl.toString()}`;

    try {
      const cached = this.cache.getJson<{
        title: string;
        content: string;
        author: string;
      }>("note-reader", safeUrl.toString());
      if (cached) {
        return cached;
      }

      const headers: Record<string, string> = {
        Accept: "application/json",
      };
      if (this.apiKey) {
        headers.Authorization = `Bearer ${this.apiKey}`;
      }

      await waitForRateLimit("jina-reader", env.SCRAPER_RATE_LIMIT_MS);
      const response = await fetch(endpoint, { headers });

      if (!response.ok) {
        logger.error(
          { status: response.status, statusText: response.statusText },
          "Jina Reader API failed",
        );
        return null;
      }

      const data = await response.json();
      const jinaData = data.data ?? data;

      const normalized = {
        title: jinaData.title ?? "Unknown",
        content: jinaData.content ?? "",
        author: jinaData.author ?? "Unknown",
      };
      this.cache.setJson(
        "note-reader",
        safeUrl.toString(),
        normalized,
        12 * 60 * 60,
      );
      return normalized;
    } catch (error) {
      logger.error({ error, url }, "Error executing Jina Reader");
      return null;
    }
  }
}

export class NoteResearchClientImpl implements NoteResearchClient {
  private webSearchClient: WebSearchClient;
  private jinaReaderClient = new JinaReaderClient();
  private cache = createCacheService();

  constructor(webSearchClient?: WebSearchClient) {
    // リサーチは全モードで許可（書き込みガードは各write操作で行う）
    assertNoteMode(["research_only", "draft_assist", "browser_assisted"]);
    this.webSearchClient = webSearchClient ?? new JinaSearchClient();
  }

  async fetchPublicPage(
    url: string,
  ): Promise<{ title: string; content: string; author: string }> {
    const env = loadEnv();
    const safeUrl = assertSafePublicUrl(url, {
      allowSubdomainsOf: ["note.com"],
      requireHttps: true,
    });

    logger.info(
      { url: safeUrl.toString() },
      "Fetching note public page via Jina Reader",
    );

    try {
      const jinaResult = await this.jinaReaderClient.read(safeUrl.toString());
      if (jinaResult?.content) {
        return jinaResult;
      }
    } catch (e) {
      logger.warn(
        { url: safeUrl.toString(), error: e },
        "Jina Reader failed, falling back to basic fetch",
      );
    }

    // fallback
    logger.info(
      { url: safeUrl.toString() },
      "Fetching note public page via basic fetch",
    );
    try {
      await waitForRateLimit("note-public-fetch", env.SCRAPER_RATE_LIMIT_MS);
      const response = await fetch(safeUrl.toString());
      if (!response.ok) {
        throw new Error(`Failed to fetch: ${response.status}`);
      }
      const html = await response.text();

      // Simple HTML parsing (production should use a proper parser)
      const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
      const title =
        titleMatch?.[1]?.replace(/ \| note.*$/, "").trim() ?? "Unknown";

      // Extract og:description or meta description as snippet
      const descMatch = html.match(
        /<meta\s+(?:name="description"|property="og:description")\s+content="([^"]*?)"/i,
      );
      const content = descMatch?.[1] ?? "";

      // Extract author from og or page
      const authorMatch = html.match(
        /<meta\s+(?:name="author"|property="article:author")\s+content="([^"]*?)"/i,
      );
      const author = authorMatch?.[1] ?? "Unknown";

      return { title, content, author };
    } catch (error) {
      logger.error(
        { url: safeUrl.toString(), error },
        "Failed to fetch note page",
      );
      return { title: "Error", content: "", author: "Unknown" };
    }
  }

  async searchNotes(
    query: string,
  ): Promise<Array<{ title: string; url: string; snippet: string }>> {
    logger.info({ query }, "Note search using Web Search");
    const searchQuery = `site:note.com ${query}`;
    try {
      const cached = this.cache.getJson<
        Array<{ title: string; url: string; snippet: string }>
      >("note-search", searchQuery);
      if (cached) {
        return cached;
      }

      const results = await this.webSearchClient.search(searchQuery, {
        count: 10,
      });
      const filtered = results.filter((r) => {
        try {
          const url = new URL(r.url);
          return url.hostname.endsWith("note.com");
        } catch {
          return false;
        }
      });
      this.cache.setJson("note-search", searchQuery, filtered, 6 * 60 * 60);
      return filtered;
    } catch (error) {
      logger.error({ error, query }, "Failed to search notes via Web Search");
      return [];
    }
  }
}

// Dry-run client
export class DryRunNoteResearchClient implements NoteResearchClient {
  async fetchPublicPage(
    _url: string,
  ): Promise<{ title: string; content: string; author: string }> {
    return {
      title: "[DRY-RUN] Sample Note",
      content: "Sample content",
      author: "test-author",
    };
  }

  async searchNotes(
    _query: string,
  ): Promise<Array<{ title: string; url: string; snippet: string }>> {
    return [];
  }
}
