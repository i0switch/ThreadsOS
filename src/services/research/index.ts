import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { LlmClient } from "../../adapters/llm/index.js";
import {
  JinaSearchClient,
  type WebSearchClient,
} from "../../adapters/web-search/index.js";
import { logger } from "../../app/logger.js";
import { db } from "../../db/index.js";
import {
  competitorAnalyses,
  competitorSnapshots,
  departmentNotifications,
  researchItems,
} from "../../db/schema.js";
import type { ResearchItem } from "../../domain/threads/index.js";
import { parseJsonArray, parseJsonObject } from "../../utils/llm-json.js";
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
  analyzeCompetitorSnapshots(
    llm: LlmClient,
    channel: "threads" | "note",
  ): Promise<{
    analysisCount: number;
    winningPatterns: string[];
    summary: string;
  }>;
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
      scope: "external-research",
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
        "external-research",
        `topic:${topicId}`,
        summaryForMemory,
      );
      this.memoryService.set(
        "working_memory",
        "external-research",
        `topic:${topicId}:latest`,
        summaryForMemory,
        {
          expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
        },
      );
    }

    // Push notification to relevant departments
    if (items.length > 0) {
      const notification = {
        topicId,
        topicName,
        itemCount: items.length,
        highlights: items.slice(0, 3).map((i) => i.content.slice(0, 100)),
      };
      const notifNow = new Date().toISOString();
      for (const dept of ["threads", "note", "competitive-analysis"] as const) {
        db.insert(departmentNotifications)
          .values({
            id: randomUUID(),
            fromDepartment: "external-research",
            toDepartment: dept,
            notificationType: "research_update",
            content: JSON.stringify(notification),
            readAt: null,
            createdAt: notifNow,
          })
          .run();
      }
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

  async analyzeCompetitorSnapshots(
    llm: LlmClient,
    channel: "threads" | "note",
  ): Promise<{
    analysisCount: number;
    winningPatterns: string[];
    summary: string;
  }> {
    const snapshots = db
      .select()
      .from(competitorSnapshots)
      .orderBy(desc(competitorSnapshots.createdAt))
      .limit(20)
      .all();

    if (snapshots.length === 0) {
      return { analysisCount: 0, winningPatterns: [], summary: "競合スナップショットなし" };
    }

    const snapshotSummary = snapshots
      .map((s, i) => `[${i + 1}] source: ${s.source}\ndata: ${s.data.slice(0, 500)}`)
      .join("\n\n");

    const prompt = `以下の競合スナップショットを分析してください。
チャネル: ${channel}

## スナップショット
${snapshotSummary}

以下の形式でJSON1つだけ返してください:
{
  "themes": ["テーマ1", "テーマ2"],
  "hooks": ["フック手法1", "フック手法2"],
  "engagementPatterns": "エンゲージメントパターンの要約",
  "winningPatterns": [
    {"pattern": "パターン名", "frequency": "high|medium|low", "estimatedEngagement": "high|medium|low"}
  ]
}`;

    const raw = await llm.generate(prompt, {
      temperature: 0.3,
      tier: "standard",
    });

    const parsed = parseJsonObject<{
      themes: string[];
      hooks: string[];
      engagementPatterns: string;
      winningPatterns: Array<{ pattern: string; frequency: string; estimatedEngagement: string }>;
    }>(raw);

    if (!parsed) {
      logger.warn("Failed to parse competitor analysis");
      return { analysisCount: 0, winningPatterns: [], summary: "分析パース失敗" };
    }

    // Save each analysis
    for (const snapshot of snapshots) {
      db.insert(competitorAnalyses)
        .values({
          id: randomUUID(),
          snapshotId: snapshot.id,
          channel,
          themes: JSON.stringify(parsed.themes),
          hooks: JSON.stringify(parsed.hooks),
          engagementPatterns: parsed.engagementPatterns,
          winningPatterns: JSON.stringify(parsed.winningPatterns),
          rawAnalysis: raw,
          createdAt: new Date().toISOString(),
        })
        .onConflictDoNothing()
        .run();
    }

    const winningPatternNames = parsed.winningPatterns.map((p) => p.pattern);
    const summary = `競合分析完了: ${snapshots.length}件のスナップショットからテーマ${parsed.themes.length}件、勝ちパターン${winningPatternNames.length}件を抽出`;

    return {
      analysisCount: snapshots.length,
      winningPatterns: winningPatternNames,
      summary,
    };
  }
}
