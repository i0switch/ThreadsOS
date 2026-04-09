/**
 * note.com Playwright クライアント
 *
 * 記事自動生成プロジェクトの note-save-adapters.ts の Playwright アダプターを
 * ThreadsOS 向けにポーティング。
 *
 * storageState（ブラウザセッション JSON）を使って note.com API を認証付きで呼び出す。
 * Cookie の手動設定不要。NOTE_STORAGE_STATE_PATH にセッションを保存・再利用する。
 */

import fs from "node:fs/promises";
import {
  chromium,
  request as playwrightRequest,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { logger } from "../../app/logger.js";
import {
  buildPublishPayload,
  buildStructuredNoteContent,
} from "./html-builder.js";
import type { NoteContentContext, NoteIdentity } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type NotePublishOptions = {
  title: string;
  body: string;
  freePreviewMarkdown?: string;
  paidContentMarkdown?: string;
  priceYen?: number;
  isPaid?: boolean;
  transitionCtaText?: string;
  targetState?: "draft" | "published";
};

export type NotePublishResult = {
  noteUrl: string;
  noteId: string;
  draftUrl: string;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const NOTE_REQUEST_HEADERS = {
  "x-requested-with": "XMLHttpRequest",
  referer: "https://editor.note.com/",
  "content-type": "application/json",
} as const;

const closeSafely = async (
  label: string,
  close: () => Promise<unknown>,
): Promise<void> => {
  try {
    await close();
  } catch (err) {
    logger.warn(
      { label, err: err instanceof Error ? err.message : String(err) },
      "[PLAYWRIGHT] cleanup failed",
    );
  }
};

// ---------------------------------------------------------------------------
// Inner API client（Playwright request context 経由）
// ---------------------------------------------------------------------------

class NoteInnerApiClient {
  constructor(private readonly api: APIRequestContext) {}

  async dispose(): Promise<void> {
    await this.api.dispose();
  }

  async getCurrentUser(): Promise<{ urlname: string }> {
    const res = await this.api.get("https://note.com/api/v2/current_user");
    if (!res.ok()) throw new Error(`NOTE_CURRENT_USER_FAILED_${res.status()}`);
    const data = (await res.json()) as { data?: { urlname?: string } };
    const urlname = data.data?.urlname;
    if (!urlname) throw new Error("NOTE_URLNAME_NOT_FOUND");
    return { urlname };
  }

  async createTextNote(): Promise<NoteIdentity> {
    const res = await this.api.post("https://note.com/api/v1/text_notes", {
      data: { template_key: null },
    });
    if (!res.ok()) throw new Error(`NOTE_CREATE_FAILED_${res.status()}`);
    const data = (await res.json()) as {
      data?: { id?: number; key?: string; slug?: string };
    };
    const d = data.data;
    if (!d?.id || !d.key || !d.slug) {
      throw new Error("NOTE_CREATE_RESPONSE_INVALID");
    }
    return { id: d.id, key: d.key, slug: d.slug };
  }

  async getArticleStats(noteId: string): Promise<{
    views: number;
    likes: number;
    comments: number;
    publishedAt?: string;
  }> {
    // Try stats endpoint first, fall back to note detail
    const candidates = [
      `https://note.com/api/v2/notes/${encodeURIComponent(noteId)}/stats`,
      `https://note.com/api/v3/notes/${encodeURIComponent(noteId)}`,
      `https://note.com/api/v1/notes/${encodeURIComponent(noteId)}`,
    ];

    for (const url of candidates) {
      const res = await this.api.get(url);
      if (!res.ok()) continue;

      const data = (await res.json()) as Record<string, unknown>;
      const source =
        data.data && typeof data.data === "object"
          ? (data.data as Record<string, unknown>)
          : data;

      return {
        views: Number(source.readCount ?? source.views ?? source.viewCount ?? 0),
        likes: Number(source.likeCount ?? source.likes ?? 0),
        comments: Number(
          source.commentCount ?? source.comments ?? source.commentsCount ?? 0,
        ),
        publishedAt: source.publishAt
          ? String(source.publishAt)
          : source.publishedAt
            ? String(source.publishedAt)
            : undefined,
      };
    }

    logger.warn({ noteId }, "[PLAYWRIGHT] All stats endpoints failed, returning zeros");
    return { views: 0, likes: 0, comments: 0 };
  }

  async getMyArticles(): Promise<
    Array<{
      id: string;
      title: string;
      url: string;
      views: number;
      likes: number;
      comments?: number;
      publishedAt?: string;
    }>
  > {
    const user = await this.getCurrentUser();
    const candidates = [
      `https://note.com/api/v2/creators/${user.urlname}/contents?kind=note&page=1&per=20`,
      `https://note.com/api/v2/creators/${user.urlname}/notes?page=1&per=20`,
    ];

    for (const url of candidates) {
      const res = await this.api.get(url);
      if (!res.ok()) continue;

      const data = (await res.json()) as Record<string, unknown>;
      const rawItems: unknown[] = (() => {
        if (Array.isArray(data.data)) return data.data;
        if (Array.isArray((data as any).contents)) return (data as any).contents;
        if (Array.isArray((data as any).notes)) return (data as any).notes;
        // data.data がオブジェクトで中に contents/notes がある場合
        if (data.data && typeof data.data === "object" && !Array.isArray(data.data)) {
          const inner = data.data as Record<string, unknown>;
          if (Array.isArray(inner.contents)) return inner.contents;
          if (Array.isArray(inner.notes)) return inner.notes;
        }
        return [];
      })();

      const result: Array<{
        id: string;
        title: string;
        url: string;
        views: number;
        likes: number;
        comments?: number;
        publishedAt?: string;
      }> = [];

      for (const item of rawItems) {
        if (!item || typeof item !== "object") continue;
        const record = item as Record<string, unknown>;
        const id = String(record.id ?? record.key ?? "");
        const title = String(record.name ?? record.title ?? "");
        const noteUrl = String(
          record.noteUrl ??
            record.note_url ??
            (record.key
              ? `https://note.com/${user.urlname}/n/${record.key}`
              : ""),
        );
        if (!id || !title) continue;

        result.push({
          id,
          title,
          url: noteUrl,
          views: Number(record.readCount ?? record.views ?? 0),
          likes: Number(record.likeCount ?? record.likes ?? 0),
          comments:
            record.commentCount !== undefined
              ? Number(record.commentCount)
              : record.comments !== undefined
                ? Number(record.comments)
                : undefined,
          publishedAt: record.publishAt
            ? String(record.publishAt)
            : record.publishedAt
              ? String(record.publishedAt)
              : undefined,
        });
      }

      return result;
    }

    logger.warn("[PLAYWRIGHT] All article list endpoints failed, returning empty");
    return [];
  }

  async saveDraft(
    note: NoteIdentity,
    context: NoteContentContext & { priceYen?: number },
    structured: ReturnType<typeof buildStructuredNoteContent>,
  ): Promise<void> {
    const saleSettingRequested =
      context.salesMode === "free_paid" &&
      Boolean(structured.separator) &&
      structured.paidHtml.length > 0;

    const payload: Record<string, unknown> = {
      body: structured.fullHtml,
      body_length: structured.bodyLength,
      name: context.title,
      index: false,
      is_lead_form: false,
    };

    if (saleSettingRequested) {
      payload.free_body = structured.freeHtml;
      payload.pay_body = structured.paidHtml;
      payload.separator = structured.separator;
      payload.limited = true;
      payload.price = context.priceYen ?? 300;
    }

    const res = await this.api.post(
      `https://note.com/api/v1/text_notes/draft_save?id=${note.id}&is_temp_saved=true`,
      { data: payload },
    );
    if (!res.ok()) throw new Error(`NOTE_DRAFT_SAVE_FAILED_${res.status()}`);
  }

  async publishNote(
    note: NoteIdentity,
    payload: ReturnType<typeof buildPublishPayload>,
  ): Promise<{ noteUrl: string | null }> {
    const res = await this.api.put(
      `https://note.com/api/v1/text_notes/${note.id}`,
      { data: payload },
    );
    if (!res.ok()) {
      const body = await res.text();
      throw new Error(`NOTE_PUBLISH_FAILED_${res.status()}_${body}`);
    }
    const data = (await res.json()) as { data?: { note_url?: string } };
    return { noteUrl: data.data?.note_url ?? null };
  }
}

// ---------------------------------------------------------------------------
// Browser automation helper
// ---------------------------------------------------------------------------

class NoteBrowserAutomation {
  constructor(private readonly storageStatePath: string) {}

  async checkLogin(page: Page): Promise<void> {
    await page.goto("https://note.com/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    const isLoggedOut = await page
      .locator('a[href="/login"]')
      .isVisible({ timeout: 3000 })
      .catch(() => false);
    if (isLoggedOut) {
      throw new Error(
        "NOTE_SESSION_EXPIRED: /note-login スキルでセッションを更新してください",
      );
    }
  }

  async createApiClient(page: Page): Promise<NoteInnerApiClient> {
    const storageState = await page
      .context()
      .storageState({ path: this.storageStatePath });
    const api = await playwrightRequest.newContext({
      storageState,
      extraHTTPHeaders: NOTE_REQUEST_HEADERS,
    });
    return new NoteInnerApiClient(api);
  }
}

// ---------------------------------------------------------------------------
// Playwright browser runner
// ---------------------------------------------------------------------------

class NotePlaywrightRunner {
  constructor(
    private readonly storageStatePath: string,
    private readonly headless: boolean,
  ) {}

  async run<T>(task: (page: Page) => Promise<T>): Promise<T> {
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;

    try {
      const contextOptions: import("playwright").BrowserContextOptions = {
        viewport: { width: 1440, height: 960 },
      };
      try {
        await fs.access(this.storageStatePath);
        contextOptions.storageState = this.storageStatePath;
      } catch {
        // 初回はstorageStateなし
      }

      browser = await chromium.launch({ headless: this.headless });
      context = await browser.newContext(contextOptions);
      const page = await context.newPage();
      return await task(page);
    } finally {
      if (context) {
        const ctx = context;
        await closeSafely("storageState save", () =>
          ctx.storageState({ path: this.storageStatePath }),
        );
        await closeSafely("context close", () => ctx.close());
      }
      if (browser) {
        const br = browser;
        await closeSafely("browser close", () => br.close());
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public client
// ---------------------------------------------------------------------------

export class PlaywrightNoteClient {
  private readonly storageStatePath: string;
  private readonly runner: NotePlaywrightRunner;

  constructor(storageStatePath: string, headless = true) {
    this.storageStatePath = storageStatePath;
    this.runner = new NotePlaywrightRunner(storageStatePath, headless);
  }

  async publishArticle(options: NotePublishOptions): Promise<NotePublishResult> {
    const {
      title,
      body,
      freePreviewMarkdown = body,
      paidContentMarkdown = "",
      priceYen = 300,
      isPaid = false,
      transitionCtaText = "",
      targetState = "published",
    } = options;

    return this.runner.run(async (page) => {
      const automation = new NoteBrowserAutomation(this.storageStatePath);
      await automation.checkLogin(page);
      const api = await automation.createApiClient(page);

      try {
        const user = await api.getCurrentUser();
        const note = await api.createTextNote();

        const context: NoteContentContext & { priceYen?: number } = {
          jobId: Date.now(),
          title,
          noteBody: body,
          freePreviewMarkdown,
          paidContentMarkdown,
          salesMode:
            isPaid && paidContentMarkdown.trim().length > 0
              ? "free_paid"
              : "normal",
          transitionCtaText,
          priceYen,
        };

        const structured = buildStructuredNoteContent(context);
        await api.saveDraft(note, context, structured);

        if (targetState === "draft") {
          logger.info({ noteKey: note.key }, "[PLAYWRIGHT] Draft saved");
          return {
            noteUrl: `https://note.com/${user.urlname}/n/${note.key}`,
            noteId: note.key,
            draftUrl: `https://editor.note.com/notes/${note.key}/edit/`,
          };
        }

        const payload = buildPublishPayload(note, context, structured);
        const result = await api.publishNote(note, payload);
        const noteUrl =
          result.noteUrl ?? `https://note.com/${user.urlname}/n/${note.key}`;

        logger.info({ noteUrl }, "[PLAYWRIGHT] Note published");
        return {
          noteUrl,
          noteId: note.key,
          draftUrl: `https://editor.note.com/notes/${note.key}/edit/`,
        };
      } finally {
        await api.dispose();
      }
    });
  }

  async getArticleStats(noteId: string): Promise<{
    views: number;
    likes: number;
    comments: number;
    publishedAt?: string;
  }> {
    return this.runner.run(async (page) => {
      const automation = new NoteBrowserAutomation(this.storageStatePath);
      await automation.checkLogin(page);
      const api = await automation.createApiClient(page);

      try {
        const res = await api.getArticleStats(noteId);
        return res;
      } finally {
        await api.dispose();
      }
    });
  }

  async getMyArticles(): Promise<
    Array<{
      id: string;
      title: string;
      url: string;
      views: number;
      likes: number;
      comments?: number;
      publishedAt?: string;
    }>
  > {
    return this.runner.run(async (page) => {
      const automation = new NoteBrowserAutomation(this.storageStatePath);
      await automation.checkLogin(page);
      const api = await automation.createApiClient(page);

      try {
        const res = await api.getMyArticles();
        return res;
      } finally {
        await api.dispose();
      }
    });
  }

  async verifySession(): Promise<{ ok: boolean; detail: string }> {
    try {
      await fs.access(this.storageStatePath);
    } catch {
      return {
        ok: false,
        detail:
          "storageState ファイルが存在しません。/note-login を実行してください",
      };
    }

    try {
      return await this.runner.run(async (page) => {
        const automation = new NoteBrowserAutomation(this.storageStatePath);
        await automation.checkLogin(page);
        return { ok: true, detail: "セッション有効" };
      });
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
