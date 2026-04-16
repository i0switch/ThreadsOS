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

    // ── 複数クエリで市場動向・ジャンル理解も収集 ──
    const queries = [
      `${topicName} Threads 投稿 コツ`,
      `${topicName} 市場動向 トレンド ${new Date().getFullYear()}`,
      `${topicName} 需要 競争 ニッチ`,
    ];
    let webResultsStr = "";
    const sourceUrls: string[] = [];

    for (const query of queries) {
      try {
        const searchResults = await this.webSearchClient.search(query, {
          count: 2,
        });
        if (searchResults.length > 0) {
          webResultsStr += `\n## Web検索結果 (${query})\n${searchResults.map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n内容: ${r.snippet}`).join("\n\n")}\n`;
          sourceUrls.push(...searchResults.map((r) => r.url));
        }
      } catch (e) {
        logger.warn(
          { error: e, query },
          "Web search failed in researchTopic, falling back to LLM only",
        );
      }
    }

    const searchInstruction = webResultsStr
      ? "以下のWeb検索結果と既存知識を組み合わせてリサーチを行ってください。"
      : "既存知識を活用してリサーチを行ってください。";

    const prompt = `以下のトピックについて、Threads投稿とnote記事に使えるリサーチを行ってください。
${searchInstruction}
${profileSection}${retrievalSection}${webResultsStr}
## トピック
${topicName}

## リサーチ観点
1. コンテンツ素材: 投稿やnote記事のネタになる具体的な情報・データ・事例
2. 市場動向: このジャンルの最新トレンド、需要の変化、競争密度
3. ジャンル理解: このジャンル特有の文化・用語・ユーザー心理・成功パターン

以下の形式でJSON配列を返してください:
[
  {
    "source": "情報源の種類 (URLがわかる場合はURLを記載)",
    "content": "発見した情報・インサイト",
    "evidenceType": "data" | "anecdote" | "expert" | "trend" | "market" | "genre_insight",
    "confidence": "high" | "medium" | "low"
  }
]

8〜12件の有用なリサーチ結果を返してください（コンテンツ素材5件、市場動向2-3件、ジャンル理解1-2件を目安に）。`;

    const raw = await llm.generate(prompt, {
      label: "research-daily-topic",
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

    // ── 市場動向・ジャンル理解の専用メモリ蓄積 ──
    const marketInsights = items.filter(
      (i) => i.evidenceType === "market" || i.evidenceType === "trend",
    );
    if (marketInsights.length > 0) {
      const marketSummary = marketInsights
        .map((i) => `- ${i.content}`)
        .join("\n");
      this.memoryService.set(
        "persistent_policy",
        "external-research",
        `market_trend:${topicId}`,
        marketSummary,
      );
    }

    const genreInsights = items.filter(
      (i) => i.evidenceType === "genre_insight",
    );
    if (genreInsights.length > 0) {
      const genreSummary = genreInsights
        .map((i) => `- ${i.content}`)
        .join("\n");
      this.memoryService.set(
        "persistent_policy",
        "external-research",
        `genre_understanding:${topicId}`,
        genreSummary,
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
      for (const dept of [
        "threads",
        "note",
        "competitive-analysis",
        "command",
      ] as const) {
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
      return {
        analysisCount: 0,
        winningPatterns: [],
        summary: "競合スナップショットなし",
      };
    }

    const snapshotSummary = snapshots
      .map(
        (s, i) =>
          `[${i + 1}] source: ${s.source}\ndata: ${s.data.slice(0, 500)}`,
      )
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
      label: "research-competitor-analysis",
      temperature: 0.3,
      tier: "standard",
    });

    const parsed = parseJsonObject<{
      themes: string[];
      hooks: string[];
      engagementPatterns: string;
      winningPatterns: Array<{
        pattern: string;
        frequency: string;
        estimatedEngagement: string;
      }>;
    }>(raw);

    if (!parsed) {
      logger.warn("Failed to parse competitor analysis");
      return {
        analysisCount: 0,
        winningPatterns: [],
        summary: "分析パース失敗",
      };
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
