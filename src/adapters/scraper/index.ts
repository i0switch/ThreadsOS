import { logger } from "../../app/logger.js";
import { loadEnv } from "../../config/env.js";
import {
  assertSafePublicUrl,
  waitForRateLimit,
} from "../../utils/network-policy.js";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRIES = 2;

export interface ScrapedThreadsPost {
  url: string;
  author: string;
  body: string;
  snippet: string;
  scrapedAt: string;
}

export interface ScrapedNoteArticle {
  url: string;
  title: string;
  author: string;
  snippet: string;
  scrapedAt: string;
}

export interface ScraperClient {
  scrapeThreadsProfile(username: string): Promise<ScrapedThreadsPost[]>;
  scrapeNoteAuthor(authorUrl: string): Promise<ScrapedNoteArticle[]>;
  scrapeNoteSearch(query: string): Promise<ScrapedNoteArticle[]>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeBasicEntities(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function stripHtml(value: string): string {
  return decodeBasicEntities(
    value
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function extractMeta(html: string, key: string): string | undefined {
  const pattern = new RegExp(
    `<meta[^>]+(?:property|name)=["']${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]+content=["']([^"']+)["'][^>]*>`,
    "i",
  );
  const match = html.match(pattern);
  return match?.[1] ? decodeBasicEntities(match[1]) : undefined;
}

function extractSnippet(html: string, anchor: string, radius = 280): string {
  const index = html.indexOf(anchor);
  if (index < 0) {
    return "";
  }
  return stripHtml(
    html.slice(
      Math.max(0, index - radius),
      Math.min(html.length, index + anchor.length + radius),
    ),
  );
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].filter(Boolean);
}

function collectUrls(html: string, pattern: RegExp): string[] {
  const urls = Array.from(html.matchAll(pattern), (match) => match[0]);
  return uniqueSorted(urls);
}

async function fetchHtml(
  url: string,
  retries = DEFAULT_RETRIES,
): Promise<string> {
  const rateLimitMs = loadEnv().SCRAPER_RATE_LIMIT_MS;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    try {
      await waitForRateLimit("scraper", rateLimitMs);
      const response = await fetch(url, {
        headers: {
          "User-Agent": BROWSER_UA,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "ja,en;q=0.9",
        },
        signal: controller.signal,
      });

      if (response.ok) {
        return await response.text();
      }

      const body = await response.text().catch(() => "");
      if (
        (response.status === 429 || response.status >= 500) &&
        attempt < retries
      ) {
        logger.warn({ url, status: response.status, attempt }, "Scrape retry");
        await sleep(2_000 * (attempt + 1));
        continue;
      }

      throw new Error(`HTTP ${response.status}: ${body.slice(0, 300)}`);
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        logger.warn({ url, attempt, error }, "Scrape retry after failure");
        await sleep(2_000 * (attempt + 1));
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to fetch HTML");
}

async function fetchHtmlDryRun(url: string): Promise<string> {
  logger.info({ url }, "[DRY-RUN] Would scrape URL");
  return "";
}

export class ScraperClientImpl implements ScraperClient {
  constructor(private readonly dryRun = false) {}

  private async loadHtml(url: string): Promise<string> {
    return this.dryRun ? fetchHtmlDryRun(url) : fetchHtml(url);
  }

  async scrapeThreadsProfile(username: string): Promise<ScrapedThreadsPost[]> {
    const url = `https://www.threads.net/@${username}`;
    const html = await this.loadHtml(url);
    if (!html) {
      return [];
    }

    const scrapedAt = new Date().toISOString();
    const title = extractMeta(html, "og:title") ?? `${username} on Threads`;
    const candidateUrls = collectUrls(
      html,
      /https:\/\/www\.threads\.net\/@[^"' <]+\/post\/[^"' <]+/g,
    );

    return candidateUrls.map((postUrl) => ({
      url: postUrl,
      author: username,
      body: stripHtml(extractSnippet(html, postUrl)) || title,
      snippet: stripHtml(extractSnippet(html, postUrl, 120)) || title,
      scrapedAt,
    }));
  }

  async scrapeNoteAuthor(authorUrl: string): Promise<ScrapedNoteArticle[]> {
    const safeUrl = assertSafePublicUrl(authorUrl, {
      allowSubdomainsOf: ["note.com"],
      requireHttps: true,
    });
    const html = await this.loadHtml(safeUrl.toString());
    if (!html) {
      return [];
    }

    const scrapedAt = new Date().toISOString();
    const title = extractMeta(html, "og:title") ?? "note author page";
    const author =
      extractMeta(html, "author") ??
      safeUrl
        .toString()
        .replace(/^https?:\/\/note\.com\//, "")
        .replace(/\/.*$/, "");
    const candidateUrls = collectUrls(
      html,
      /https:\/\/note\.com\/[^"' <]+\/[^"' <]+/g,
    );

    return candidateUrls.map((articleUrl) => ({
      url: articleUrl,
      title: stripHtml(extractSnippet(html, articleUrl, 80)) || title,
      author,
      snippet: stripHtml(extractSnippet(html, articleUrl, 160)) || title,
      scrapedAt,
    }));
  }

  async scrapeNoteSearch(query: string): Promise<ScrapedNoteArticle[]> {
    const searchUrl = `https://note.com/search?q=${encodeURIComponent(query)}`;
    const html = await this.loadHtml(searchUrl);
    if (!html) {
      return [];
    }

    const scrapedAt = new Date().toISOString();
    const title = extractMeta(html, "og:title") ?? `note search: ${query}`;
    const candidateUrls = collectUrls(
      html,
      /https:\/\/note\.com\/[^"' <]+\/[^"' <]+/g,
    );

    return candidateUrls.map((articleUrl) => ({
      url: articleUrl,
      title: stripHtml(extractSnippet(html, articleUrl, 80)) || title,
      author: "unknown",
      snippet: stripHtml(extractSnippet(html, articleUrl, 160)) || title,
      scrapedAt,
    }));
  }
}

export class DryRunScraperClient implements ScraperClient {
  async scrapeThreadsProfile(username: string): Promise<ScrapedThreadsPost[]> {
    logger.info({ username }, "[DRY-RUN] Would scrape Threads profile");
    return [];
  }

  async scrapeNoteAuthor(authorUrl: string): Promise<ScrapedNoteArticle[]> {
    logger.info({ authorUrl }, "[DRY-RUN] Would scrape note author page");
    return [];
  }

  async scrapeNoteSearch(query: string): Promise<ScrapedNoteArticle[]> {
    logger.info({ query }, "[DRY-RUN] Would scrape note search");
    return [];
  }
}
