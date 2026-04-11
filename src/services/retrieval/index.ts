import { desc } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  competitorSnapshots,
  departmentSummaries,
  improvementInsights,
  researchItems,
} from "../../db/schema.js";
import { createMemoryService, type MemoryService } from "../memory/index.js";

type RetrievalSource = {
  sourceType: string;
  sourceId: string;
  scope: string;
  content: string;
  createdAt: string;
};

export interface RetrievalMatch {
  sourceType: string;
  sourceId: string;
  scope: string;
  content: string;
  createdAt: string;
  score: number;
}

export interface RetrievalService {
  search(
    query: string,
    options?: { scope?: string; limit?: number },
  ): RetrievalMatch[];
  buildContext(
    query: string,
    options?: { scope?: string; limit?: number },
  ): string;
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s、。,.!?:;()[\]{}"'`]+/u)
    .map((token) => token.trim())
    .filter(Boolean);
}

function scoreCandidate(query: string, candidate: string): number {
  const haystack = candidate.toLowerCase();
  const tokens = tokenize(query);
  let score = haystack.includes(query.toLowerCase()) ? 5 : 0;

  for (const token of tokens) {
    if (haystack.includes(token)) {
      score += 2;
    }
  }

  return score;
}

function clip(content: string, maxLength = 220): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}…`;
}

export function createRetrievalService(
  memoryService: MemoryService = createMemoryService(),
): RetrievalService {
  function collectSources(scope?: string): RetrievalSource[] {
    const memoryRows = memoryService
      .listByLayer("persistent_policy")
      .concat(memoryService.listByLayer("department_summary"))
      .concat(memoryService.listByLayer("working_memory"));

    const scopedMemoryRows = scope
      ? memoryRows.filter(
          (row) => row.scope === scope || row.scope === "global",
        )
      : memoryRows;

    const summaryRows = db
      .select()
      .from(departmentSummaries)
      .orderBy(desc(departmentSummaries.updatedAt))
      .limit(30)
      .all()
      .filter((row) => !scope || row.department === scope);

    const researchRows = db
      .select()
      .from(researchItems)
      .orderBy(desc(researchItems.createdAt))
      .limit(40)
      .all();

    const insightRows = db
      .select()
      .from(improvementInsights)
      .orderBy(desc(improvementInsights.createdAt))
      .limit(30)
      .all()
      .filter(
        (row) =>
          !scope || row.sourceType === scope || row.sourceType === "note",
      );

    const competitorRows = db
      .select()
      .from(competitorSnapshots)
      .orderBy(desc(competitorSnapshots.createdAt))
      .limit(15)
      .all();

    return [
      ...scopedMemoryRows.map((row) => ({
        sourceType: row.layer,
        sourceId: row.id,
        scope: row.scope,
        content: `${row.key}: ${row.value}`,
        createdAt: row.updatedAt,
      })),
      ...summaryRows.map((row) => ({
        sourceType: "department_summary",
        sourceId: row.id,
        scope: row.department,
        content: row.content,
        createdAt: row.updatedAt,
      })),
      ...researchRows.map((row) => ({
        sourceType: "research_item",
        sourceId: row.id,
        scope: row.topicId,
        content: `${row.source}: ${row.content}`,
        createdAt: row.createdAt,
      })),
      ...insightRows.map((row) => ({
        sourceType: "improvement_insight",
        sourceId: row.id,
        scope: row.sourceType,
        content: `${row.insight} -> ${row.action}`,
        createdAt: row.createdAt,
      })),
      ...competitorRows.map((row) => ({
        sourceType: "competitor_snapshot",
        sourceId: row.id,
        scope: row.source,
        content: `${row.source}: ${clip(row.data, 260)}`,
        createdAt: row.createdAt,
      })),
    ];
  }

  function search(
    query: string,
    options?: { scope?: string; limit?: number },
  ): RetrievalMatch[] {
    const limit = options?.limit ?? 6;
    return collectSources(options?.scope)
      .map((source) => ({
        ...source,
        score: scoreCandidate(query, source.content),
      }))
      .filter((row) => row.score > 0)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return (
          new Date(right.createdAt).getTime() -
          new Date(left.createdAt).getTime()
        );
      })
      .slice(0, limit)
      .map((row) => ({
        ...row,
        content: clip(row.content),
      }));
  }

  function buildContext(
    query: string,
    options?: { scope?: string; limit?: number },
  ): string {
    const matches = search(query, options);
    if (matches.length === 0) {
      return "";
    }

    return matches
      .map(
        (match, index) =>
          `[${index + 1}] (${match.sourceType}/${match.scope}) ${match.content}`,
      )
      .join("\n");
  }

  return {
    search,
    buildContext,
  };
}
