import { AppError, ExternalApiError } from "../../app/errors.js";
import { logger } from "../../app/logger.js";
import { loadEnv } from "../../config/env.js";
import { assertNoteMode, type NoteMode } from "../note-research/index.js";
import {
  buildPublishPayload,
  buildStructuredNoteContent,
} from "./html-builder.js";
import type {
  NoteContentContext,
  NoteIdentity,
  PublishPayload,
} from "./types.js";

const NOTE_API_BASE = "https://note.com/api/v3";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const NOTE_EDITOR_REFERER = "https://editor.note.com/";

export interface NoteArticleSummary {
  id: string;
  title: string;
  url: string;
  views: number;
  likes: number;
  comments?: number;
  publishedAt?: string;
}

export interface NoteApiClient {
  getCurrentUser(): Promise<{ urlname: string }>;
  publishArticle(
    title: string,
    body: string,
    options?: {
      tags?: string[];
      isPaid?: boolean;
      paidBoundary?: number;
    },
  ): Promise<{ noteId: string; url: string; publishedAt?: string }>;
  updateArticle(
    noteId: string,
    updates: {
      title?: string;
      body?: string;
      tags?: string[];
    },
  ): Promise<void>;
  getMyArticles(): Promise<NoteArticleSummary[]>;
  getArticleStats(noteId: string): Promise<{
    views: number;
    likes: number;
    comments: number;
    publishedAt?: string;
  }>;
}

interface NoteApiResponse {
  id?: string;
  noteId?: string;
  url?: string;
  noteUrl?: string;
  publishedAt?: string;
  data?: unknown;
  notes?: unknown;
}

function readCookieFromEnv(): string {
  const env = loadEnv();
  return env.NOTE_SESSION_COOKIE ?? "";
}

function authRequiredError(): AppError {
  return new AppError(
    "NOTE_SESSION_COOKIE が未設定。browser_assisted に切り替えるか、Cookie を設定して再実行して。",
    "NOTE_SESSION_COOKIE_MISSING",
    403,
  );
}

function safeJsonText(raw: string): unknown {
  const match = raw.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!match) {
    throw new Error("Response did not contain JSON");
  }
  return JSON.parse(match[0]);
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.data)) return record.data;
    if (Array.isArray(record.notes)) return record.notes;
    if (Array.isArray(record.items)) return record.items;
  }
  return [];
}

function parseArticleList(raw: unknown): NoteArticleSummary[] {
  const items: NoteArticleSummary[] = [];

  for (const item of asArray(raw)) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as Record<string, unknown>;
    const id = String(record.id ?? record.noteId ?? "");
    const title = String(record.title ?? record.name ?? record.subject ?? "");
    const url = String(
      record.url ?? record.noteUrl ?? (id ? `https://note.com/n/${id}` : ""),
    );
    const views = Number(record.views ?? 0);
    const likes = Number(record.likes ?? 0);
    const comments =
      record.comments !== undefined ? Number(record.comments) : undefined;
    const publishedAt = record.publishedAt
      ? String(record.publishedAt)
      : undefined;
    if (!id || !title || !url) {
      continue;
    }

    items.push({ id, title, url, views, likes, comments, publishedAt });
  }

  return items;
}

function parseStats(raw: unknown): {
  views: number;
  likes: number;
  comments: number;
  publishedAt?: string;
} {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid note stats response");
  }
  const record = raw as Record<string, unknown>;
  const source =
    record.data && typeof record.data === "object"
      ? (record.data as Record<string, unknown>)
      : record;
  return {
    views: Number(source.views ?? source.viewCount ?? 0),
    likes: Number(source.likes ?? source.likeCount ?? 0),
    comments: Number(source.comments ?? source.commentCount ?? 0),
    publishedAt: source.publishedAt ? String(source.publishedAt) : undefined,
  };
}

function parseNoteIdentity(raw: unknown): NoteIdentity {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid note identity response");
  }

  const record = raw as Record<string, unknown>;
  const source =
    record.data && typeof record.data === "object"
      ? (record.data as Record<string, unknown>)
      : record;

  const id = Number(source.id);
  const key = String(source.key ?? "");
  const slug = String(source.slug ?? "");

  if (!Number.isFinite(id) || !key || !slug) {
    throw new Error("NOTE_IDENTITY_NOT_FOUND");
  }

  return { id, key, slug };
}

function parseUrlname(raw: unknown): { urlname: string } {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid current user response");
  }

  const record = raw as Record<string, unknown>;
  const source =
    record.data && typeof record.data === "object"
      ? (record.data as Record<string, unknown>)
      : record;
  const urlname = String(source.urlname ?? "");

  if (!urlname) {
    throw new Error("NOTE_URLNAME_NOT_FOUND");
  }

  return { urlname };
}

function parseNoteUrl(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const source =
    record.data && typeof record.data === "object"
      ? (record.data as Record<string, unknown>)
      : record;

  const url = source.note_url ?? source.noteUrl ?? source.url;
  return typeof url === "string" && url.length > 0 ? url : null;
}

function buildDraftContext(title: string, body: string): NoteContentContext {
  return {
    jobId: Date.now(),
    title,
    noteBody: body,
    freePreviewMarkdown: body,
    paidContentMarkdown: "",
    salesMode: "normal",
    transitionCtaText: "",
  };
}

export class NoteApiClientImpl implements NoteApiClient {
  private readonly mode: NoteMode;
  private readonly sessionCookie: string;

  constructor(mode?: NoteMode) {
    const env = loadEnv();
    this.mode = mode ?? env.NOTE_MODE;
    this.sessionCookie = readCookieFromEnv();
  }

  private getHeaders(init?: HeadersInit): Headers {
    const headers = new Headers(init);
    headers.set("Accept", "application/json, text/plain, */*");
    headers.set("Content-Type", "application/json");
    headers.set("User-Agent", BROWSER_UA);
    headers.set("x-requested-with", "XMLHttpRequest");
    headers.set("referer", NOTE_EDITOR_REFERER);
    if (this.sessionCookie) {
      headers.set("Cookie", this.sessionCookie);
    }
    return headers;
  }

  private requireWriteMode(): void {
    assertNoteMode(["draft_assist", "browser_assisted"], this.mode);
  }

  private requireCookie(): void {
    if (!this.sessionCookie) {
      throw authRequiredError();
    }
  }

  async getCurrentUser(): Promise<{ urlname: string }> {
    this.requireCookie();

    const response = await this.requestJson(
      "https://note.com/api/v2/current_user",
    );
    return parseUrlname(response);
  }

  private async requestJson(
    path: string,
    init: RequestInit = {},
  ): Promise<NoteApiResponse> {
    const target = path.startsWith("http") ? path : `${NOTE_API_BASE}${path}`;
    const response = await fetch(target, {
      ...init,
      headers: this.getHeaders(init.headers),
    });

    const raw = await response.text();
    if (!response.ok) {
      throw new ExternalApiError(
        "note.com API",
        `${response.status}: ${raw.slice(0, 500)}`,
      );
    }

    try {
      const parsed = raw ? safeJsonText(raw) : {};
      if (!parsed || typeof parsed !== "object") {
        throw new Error("Invalid JSON");
      }
      return parsed as NoteApiResponse;
    } catch (error) {
      throw new ExternalApiError(
        "note.com API",
        `JSON parse failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async requestJsonCandidates(
    paths: string[],
    init: RequestInit = {},
  ): Promise<NoteApiResponse> {
    const errors: string[] = [];
    for (const path of paths) {
      try {
        return await this.requestJson(path, init);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    throw new ExternalApiError("note.com API", errors.join(" | "));
  }

  async publishArticle(
    title: string,
    body: string,
    options?: {
      tags?: string[];
      isPaid?: boolean;
      paidBoundary?: number;
    },
  ): Promise<{ noteId: string; url: string; publishedAt?: string }> {
    this.requireWriteMode();
    this.requireCookie();

    logger.info({ title }, "Publishing note article");

    const user = await this.getCurrentUser();
    const noteResponse = await this.requestJson(
      "https://note.com/api/v1/text_notes",
      {
        method: "POST",
        body: JSON.stringify({ template_key: null }),
      },
    );
    const note = parseNoteIdentity(noteResponse);
    const contentContext = buildDraftContext(title, body);
    const structured = buildStructuredNoteContent(contentContext);
    const publishPayload = {
      ...buildPublishPayload(note, contentContext, structured),
      hashtags: options?.tags ?? [],
    } satisfies PublishPayload;

    await this.requestJson(
      `https://note.com/api/v1/text_notes/draft_save?id=${note.id}&is_temp_saved=true`,
      {
        method: "POST",
        body: JSON.stringify({
          body: structured.fullHtml,
          body_length: structured.bodyLength,
          name: title,
          index: false,
          is_lead_form: false,
          ...(structured.separator && structured.paidHtml.length > 0
            ? {
                free_body: structured.freeHtml,
                pay_body: structured.paidHtml,
                separator: structured.separator,
                limited: true,
              }
            : {}),
        }),
      },
    );

    const publishResponse = await this.requestJson(
      `https://note.com/api/v1/text_notes/${note.id}`,
      {
        method: "PUT",
        body: JSON.stringify(publishPayload),
      },
    );

    const url =
      parseNoteUrl(publishResponse) ??
      `https://note.com/${user.urlname}/n/${note.key}`;

    return {
      noteId: String(note.id),
      url,
      publishedAt:
        typeof publishResponse.publishedAt === "string"
          ? publishResponse.publishedAt
          : undefined,
    };
  }

  async updateArticle(
    noteId: string,
    updates: {
      title?: string;
      body?: string;
      tags?: string[];
    },
  ): Promise<void> {
    this.requireWriteMode();
    this.requireCookie();

    logger.info({ noteId }, "Updating note article");

    await this.requestJsonCandidates(
      [
        `/notes/${encodeURIComponent(noteId)}`,
        `/notes/${encodeURIComponent(noteId)}/update`,
      ],
      {
        method: "PUT",
        body: JSON.stringify({
          title: updates.title,
          body: updates.body,
          tags: updates.tags ?? [],
        }),
      },
    );
  }

  async getMyArticles(): Promise<NoteArticleSummary[]> {
    if (!this.sessionCookie) {
      logger.warn("NOTE_SESSION_COOKIE is missing, note article list may fail");
    }

    const response = await this.requestJsonCandidates([
      "/notes?mine=true",
      "/notes?is_mine=true",
      "/users/me/notes",
    ]);

    return parseArticleList(response);
  }

  async getArticleStats(noteId: string): Promise<{
    views: number;
    likes: number;
    comments: number;
    publishedAt?: string;
  }> {
    const response = await this.requestJsonCandidates([
      `/notes/${encodeURIComponent(noteId)}/stats`,
      `/notes/${encodeURIComponent(noteId)}`,
    ]);
    return parseStats(response);
  }
}

export class DryRunNoteApiClient implements NoteApiClient {
  async getCurrentUser(): Promise<{ urlname: string }> {
    return { urlname: "dry-run" };
  }

  async publishArticle(
    title: string,
    _body: string,
    _options?: {
      tags?: string[];
      isPaid?: boolean;
      paidBoundary?: number;
    },
  ): Promise<{ noteId: string; url: string; publishedAt?: string }> {
    logger.info({ title }, "[DRY-RUN] Would publish note");
    return {
      noteId: `dry-run-${Date.now()}`,
      url: "https://note.com/dry-run",
      publishedAt: new Date().toISOString(),
    };
  }

  async updateArticle(
    noteId: string,
    _updates: {
      title?: string;
      body?: string;
      tags?: string[];
    },
  ): Promise<void> {
    logger.info({ noteId }, "[DRY-RUN] Would update note");
  }

  async getMyArticles(): Promise<NoteArticleSummary[]> {
    return [];
  }

  async getArticleStats(_noteId: string): Promise<{
    views: number;
    likes: number;
    comments: number;
    publishedAt?: string;
  }> {
    return { views: 0, likes: 0, comments: 0 };
  }
}
