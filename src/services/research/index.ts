import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { LlmClient } from "../../adapters/llm/index.js";
import {
  JinaSearchClient,
  type WebSearchClient,
} from "../../adapters/web-search/index.js";
import { logger } from "../../app/logger.js";
import { db } from "../../db/index.js";
import { competitorSnapshots, researchItems } from "../../db/schema.js";
import type { ResearchItem } from "../../domain/threads/index.js";
import { parseJsonArray } from "../../utils/llm-json.js";
import { createMemoryService } from "../memory/index.js";
import { ProfileContextServiceImpl } from "../profile-context/index.js";
import { createRetrievalService } from "../retrieval/index.js";

export interface ResearchService {
  researchTopic(
    topicId: string,
    topicName: string,
    llm: LlmClient,
  ): Promise<ResearchItem[]>;
  getResearchForTopic(topicId: string): Promise<ResearchItem[]>;
  summarizeResearch(items: ResearchItem[]): Promise<string>;
  saveCompetitorSnapshot(source: string, data: string): Promise<void>;
  getRecentSnapshots(
    limit?: number,
  ): Promise<
    Array<{ id: string; source: string; data: string; snapshotDate: string }>
  >;
}

export class ResearchServiceImpl implements ResearchService {
  private profileService = new ProfileContextServiceImpl();
  private webSearchClient: WebSearchClient;
  private retrievalService = createRetrievalService();
  private memoryService = createMemoryService();

  constructor(webSearchClient?: WebSearchClient) {
    this.webSearchClient = webSearchClient ?? new JinaSearchClient();
  }

  async researchTopic(
    topicId: string,
    topicName: string,
    llm: LlmClient,
  ): Promise<ResearchItem[]> {
    const profileText = this.profileService.formatForPrompt();
    const profileSection = profileText
      ? `\n## 運用者プロフィール\n${profileText}\n(このジャンル・トーンに特化したリサーチを行ってください。)`
      : "";
    const retrievalContext = this.retrievalService.buildContext(topicName, {
      scope: "research",
      limit: 6,
    });
    const retrievalSection = retrievalContext
      ? `\n## 既存メモリ/RAG参照\n${retrievalContext}\n`
      : "";

    const query = `${topicName} Threads 投稿 コツ`;
    let webResultsStr = "";
    const sourceUrls: string[] = [];

    try {
      const searchResults = await this.webSearchClient.search(query, {
        count: 3,
      });
      if (searchResults.length > 0) {
        webResultsStr = `\n## Web検索結果\n${searchResults.map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n内容: ${r.snippet}`).join("\n\n")}\n`;
        sourceUrls.push(...searchResults.map((r) => r.url));
      }
    } catch (e) {
      logger.warn(
        { error: e },
        "Web search failed in researchTopic, falling back to LLM only",
      );
    }

    const searchInstruction = webResultsStr
      ? "以下のWeb検索結果と既存知識を組み合わせてリサーチを行ってください。"
      : "既存知識を活用してリサーチを行ってください。";

    const prompt = `以下のトピックについて、Threads投稿とnote記事に使えるリサーチを行ってください。
${searchInstruction}
${profileSection}${retrievalSection}${webResultsStr}
## トピック
${topicName}

以下の形式でJSON配列を返してください:
[
  {
    "source": "情報源の種類 (URLがわかる場合はURLを記載)",
    "content": "発見した情報・インサイト",
    "evidenceType": "data" | "anecdote" | "expert" | "trend",
    "confidence": "high" | "medium" | "low"
  }
]

5〜8件の有用なリサーチ結果を返してください。`;

    const raw = await llm.generate(prompt, {
      temperature: 0.5,
      tier: "standard",
    });

    let parsed: Array<{
      source: string;
      content: string;
      evidenceType: string;
      confidence: string;
    }>;
    parsed =
      parseJsonArray<{
        source: string;
        content: string;
        evidenceType: string;
        confidence: string;
      }>(raw) ?? [];
    if (parsed.length === 0) {
      logger.warn("Failed to parse research results");
    }

    const items: ResearchItem[] = [];
    const now = new Date().toISOString();

    for (const p of parsed) {
      let finalSource = p.source;
      if (
        sourceUrls.length > 0 &&
        p.source.includes("Web") &&
        !p.source.includes("http")
      ) {
        finalSource = `Web検索 (${sourceUrls[0]})`;
      }

      const id = randomUUID();
      db.insert(researchItems)
        .values({
          id,
          topicId,
          source: finalSource,
          content: p.content,
          evidenceType: p.evidenceType,
          confidence: p.confidence,
          createdAt: now,
        })
        .run();

      items.push({
        id,
        topicId,
        source: finalSource,
        content: p.content,
        evidenceType: p.evidenceType as ResearchItem["evidenceType"],
        confidence: p.confidence as ResearchItem["confidence"],
      });
    }

    const summaryForMemory = items
      .slice(0, 5)
      .map(
        (item) => `- [${item.evidenceType}/${item.confidence}] ${item.content}`,
      )
      .join("\n");
    if (summaryForMemory) {
      this.memoryService.set(
        "department_summary",
        "research",
        `topic:${topicId}`,
        summaryForMemory,
      );
      this.memoryService.set(
        "working_memory",
        "research",
        `topic:${topicId}:latest`,
        summaryForMemory,
        {
          expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
        },
      );
    }

    logger.info({ topicId, count: items.length }, "Research completed");
    return items;
  }

  async getResearchForTopic(topicId: string): Promise<ResearchItem[]> {
    return db
      .select()
      .from(researchItems)
      .where(eq(researchItems.topicId, topicId))
      .all()
      .map((r) => ({
        id: r.id,
        topicId: r.topicId,
        source: r.source,
        content: r.content,
        evidenceType: r.evidenceType as ResearchItem["evidenceType"],
        confidence: r.confidence as ResearchItem["confidence"],
      }));
  }

  async summarizeResearch(items: ResearchItem[]): Promise<string> {
    return items
      .map((i) => `- [${i.evidenceType}/${i.confidence}] ${i.content}`)
      .join("\n");
  }

  async saveCompetitorSnapshot(source: string, data: string): Promise<void> {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.insert(competitorSnapshots)
      .values({
        id,
        source,
        data,
        snapshotDate: now.split("T")[0],
        createdAt: now,
      })
      .run();
    logger.info({ source }, "Competitor snapshot saved");
  }

  async getRecentSnapshots(
    limit = 10,
  ): Promise<
    Array<{ id: string; source: string; data: string; snapshotDate: string }>
  > {
    return db
      .select()
      .from(competitorSnapshots)
      .orderBy(desc(competitorSnapshots.createdAt))
      .limit(limit)
      .all();
  }
}
