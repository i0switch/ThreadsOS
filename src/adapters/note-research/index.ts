import { AppError } from "../../app/errors.js";
import { logger } from "../../app/logger.js";
import { loadEnv } from "../../config/env.js";

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

export class NoteResearchClientImpl implements NoteResearchClient {
  constructor() {
    // research_only または draft_assist でないと初期化自体を拒否
    assertNoteMode(["research_only", "draft_assist"]);
  }

  async fetchPublicPage(
    url: string,
  ): Promise<{ title: string; content: string; author: string }> {
    // research_only: 公開ページのHTMLを取得してパース
    // 実運用ではfetchでHTMLを取得し、パースする
    logger.info({ url }, "Fetching note public page");

    try {
      const response = await fetch(url);
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
      logger.error({ url, error }, "Failed to fetch note page");
      return { title: "Error", content: "", author: "Unknown" };
    }
  }

  async searchNotes(
    query: string,
  ): Promise<Array<{ title: string; url: string; snippet: string }>> {
    // note doesn't have a public search API
    // This is a placeholder for research_only mode
    // In production, could use web search API to find note articles
    logger.info({ query }, "Note search (placeholder - no public API)");
    return [];
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
