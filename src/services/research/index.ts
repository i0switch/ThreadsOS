import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { LlmClient } from "../../adapters/llm/index.js";
import { logger } from "../../app/logger.js";
import { db } from "../../db/index.js";
import { competitorSnapshots, researchItems } from "../../db/schema.js";
import type { ResearchItem } from "../../domain/threads/index.js";

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
  async researchTopic(
    topicId: string,
    topicName: string,
    llm: LlmClient,
  ): Promise<ResearchItem[]> {
    const prompt = `以下のトピックについて、Threads投稿とnote記事に使えるリサーチを行ってください。

トピック: ${topicName}

以下の形式でJSON配列を返してください:
[
  {
    "source": "情報源の種類",
    "content": "発見した情報・インサイト",
    "evidenceType": "data" | "anecdote" | "expert" | "trend",
    "confidence": "high" | "medium" | "low"
  }
]

5〜8件の有用なリサーチ結果を返してください。`;

    const raw = await llm.generate(prompt, { temperature: 0.5 });

    let parsed: Array<{
      source: string;
      content: string;
      evidenceType: string;
      confidence: string;
    }>;
    try {
      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    } catch {
      logger.warn("Failed to parse research results");
      parsed = [];
    }

    const items: ResearchItem[] = [];
    const now = new Date().toISOString();

    for (const p of parsed) {
      const id = randomUUID();
      db.insert(researchItems)
        .values({
          id,
          topicId,
          source: p.source,
          content: p.content,
          evidenceType: p.evidenceType,
          confidence: p.confidence,
          createdAt: now,
        })
        .run();

      items.push({
        id,
        topicId,
        source: p.source,
        content: p.content,
        evidenceType: p.evidenceType as ResearchItem["evidenceType"],
        confidence: p.confidence as ResearchItem["confidence"],
      });
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
