import { randomUUID } from "node:crypto";
import { desc, eq, gte } from "drizzle-orm";
import type { LlmClient } from "../../adapters/llm/index.js";
import {
  DryRunNoteResearchClient,
  NoteResearchClientImpl,
} from "../../adapters/note-research/index.js";
import type { StorageClient } from "../../adapters/storage/index.js";
import type { ThreadsApiClient } from "../../adapters/threads-api/index.js";
import { logger } from "../../app/logger.js";
import { db } from "../../db/index.js";
import {
  humanInputs,
  improvementInsights,
  researchItems,
  threadPostDrafts,
  threadPostResults,
  topics,
} from "../../db/schema.js";
import type { NoteAudit, NoteDraft } from "../../domain/note/index.js";
import type {
  ThreadPostAudit,
  ThreadPostDraft,
} from "../../domain/threads/index.js";
import { EngagementAnalysisServiceImpl } from "../engagement-analysis/index.js";
import { createMemoryService } from "../memory/index.js";
import { NoteAuditServiceImpl } from "../note-audit/index.js";
import { NoteGenerationServiceImpl } from "../note-generation/index.js";
import { PostAuditServiceImpl } from "../post-audit/index.js";
import { PostGenerationServiceImpl } from "../post-generation/index.js";
import { ResearchServiceImpl } from "../research/index.js";
import { createRetrievalService } from "../retrieval/index.js";
import { TopicSelectionServiceImpl } from "../topic-selection/index.js";

const MAX_THREAD_REVISION_ATTEMPTS = 2;
const MAX_NOTE_REVISION_ATTEMPTS = 2;

type NotePipelineTopic = {
  id: string;
  name: string;
  niche: string;
  priorityScore: number;
  status: string;
  performanceScore: number;
};

export interface OrchestrationService {
  runDailyTopicResearch(
    llm: LlmClient,
    storage: StorageClient,
    dryRun?: boolean,
  ): Promise<string>;
  runDailyThreadsPlan(
    llm: LlmClient,
    storage: StorageClient,
    dryRun?: boolean,
    noteThemeContext?: string,
  ): Promise<string>;
  runPostPublishFollowup(
    api: ThreadsApiClient,
    llm: LlmClient,
    dryRun?: boolean,
  ): Promise<string>;
  runNightlyNotePipeline(
    llm: LlmClient,
    storage: StorageClient,
    dryRun?: boolean,
  ): Promise<string>;
  runWeeklyRetro(
    llm: LlmClient,
    storage: StorageClient,
    dryRun?: boolean,
  ): Promise<string>;
  processHumanInputs(llm: LlmClient, storage: StorageClient): Promise<string>;
  runNoteResearch(
    llm: LlmClient,
    storage: StorageClient,
    dryRun?: boolean,
  ): Promise<string>;
  runThreadsResearch(
    llm: LlmClient,
    storage: StorageClient,
    dryRun?: boolean,
  ): Promise<string>;
}

export class OrchestrationServiceImpl implements OrchestrationService {
  private topicService = new TopicSelectionServiceImpl();
  private researchService = new ResearchServiceImpl();
  private postGenService = new PostGenerationServiceImpl();
  private postAuditService = new PostAuditServiceImpl();
  private noteGenService = new NoteGenerationServiceImpl();
  private noteAuditService = new NoteAuditServiceImpl();
  private engagementService = new EngagementAnalysisServiceImpl();
  private memoryService = createMemoryService();
  private retrievalService = createRetrievalService(this.memoryService);

  private buildTaskContext(query: string, scope: string): string {
    return this.retrievalService.buildContext(query, {
      scope,
      limit: 5,
    });
  }

  private buildThreadRevisionFeedback(audit: ThreadPostAudit): string {
    return [...audit.suggestions, ...audit.reasons]
      .map((item) => item.trim())
      .filter(Boolean)
      .join("\n");
  }

  private buildNoteRevisionFeedback(audit: NoteAudit): string {
    return [
      audit.weakestSection ? `弱い箇所: ${audit.weakestSection}` : "",
      audit.rewriteGuidance ?? "",
    ]
      .map((item) => item.trim())
      .filter(Boolean)
      .join("\n");
  }

  private async settleThreadDraft(
    draft: ThreadPostDraft,
    llm: LlmClient,
  ): Promise<{ draft: ThreadPostDraft; audit: ThreadPostAudit }> {
    let currentDraft = draft;
    let audit = await this.postAuditService.auditDraft(currentDraft.id, llm);

    for (
      let attempt = 0;
      attempt < MAX_THREAD_REVISION_ATTEMPTS && audit.verdict === "revise";
      attempt += 1
    ) {
      const feedback = this.buildThreadRevisionFeedback(audit);
      if (!feedback) {
        break;
      }

      currentDraft = await this.postGenService.regenerateDraft(
        currentDraft.id,
        feedback,
        llm,
      );
      audit = await this.postAuditService.auditDraft(currentDraft.id, llm);
    }

    return { draft: currentDraft, audit };
  }

  // TODO: P1-A POC不合格 (2026-04-13, verdict 86.7%/90%) によりロールバック。
  // 現状 未使用だがバッチ化の再設計ベースとして残置。再投入時は
  // バッチサイズ3 + プロンプト強化 (各draft独立判定の明示) を検討。
  private async settleThreadDraftsBatch(
    drafts: ThreadPostDraft[],
    llm: LlmClient,
  ): Promise<Array<{ draft: ThreadPostDraft; audit: ThreadPostAudit }>> {
    const completed = new Map<number, { draft: ThreadPostDraft; audit: ThreadPostAudit }>();
    let queue = drafts.map((draft, index) => ({ index, draft }));

    for (
      let attempt = 0;
      attempt <= MAX_THREAD_REVISION_ATTEMPTS && queue.length > 0;
      attempt += 1
    ) {
      const auditMap = await this.postAuditService.auditDraftsBatch(
        queue.map((item) => item.draft.id),
        llm,
      );
      const nextQueue: Array<{ index: number; draft: ThreadPostDraft }> = [];

      for (const item of queue) {
        const audit = auditMap.get(item.draft.id);
        if (!audit) {
          throw new Error(`Batch audit result missing for draft: ${item.draft.id}`);
        }

        if (
          audit.verdict !== "revise" ||
          attempt >= MAX_THREAD_REVISION_ATTEMPTS
        ) {
          completed.set(item.index, { draft: item.draft, audit });
          continue;
        }

        const feedback = this.buildThreadRevisionFeedback(audit);
        if (!feedback) {
          completed.set(item.index, { draft: item.draft, audit });
          continue;
        }

        const regenerated = await this.postGenService.regenerateDraft(
          item.draft.id,
          feedback,
          llm,
        );
        nextQueue.push({ index: item.index, draft: regenerated });
      }

      queue = nextQueue;
    }

    return drafts.map((_, index) => {
      const settled = completed.get(index);
      if (!settled) {
        throw new Error(`Thread draft settlement incomplete at index ${index}`);
      }
      return settled;
    });
  }

  private async settleNoteDraft(
    draft: NoteDraft,
    llm: LlmClient,
  ): Promise<{ draft: NoteDraft; audit: NoteAudit }> {
    let currentDraft = draft;
    let audit = await this.noteAuditService.auditDraft(currentDraft.id, llm);

    for (
      let attempt = 0;
      attempt < MAX_NOTE_REVISION_ATTEMPTS && audit.verdict === "revise";
      attempt += 1
    ) {
      const feedback = this.buildNoteRevisionFeedback(audit);
      if (!feedback) {
        break;
      }

      currentDraft = await this.noteGenService.regenerateDraft(
        currentDraft.id,
        feedback,
        llm,
      );
      audit = await this.noteAuditService.auditDraft(currentDraft.id, llm);
    }

    return { draft: currentDraft, audit };
  }

  private async selectNotePipelineTopics(
    limit: number,
  ): Promise<NotePipelineTopic[]> {
    const activeTopics = db
      .select()
      .from(topics)
      .where(eq(topics.status, "active"))
      .all();
    const activeTopicMap = new Map(
      activeTopics.map((topic) => [topic.id, topic]),
    );

    const draftTopicMap = new Map(
      db
        .select()
        .from(threadPostDrafts)
        .all()
        .map((draft) => [draft.id, draft.topicId]),
    );
    const recentSince = new Date(
      Date.now() - 14 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const topicScores = new Map<
      string,
      { totalRate: number; totalImpressions: number; count: number }
    >();

    const recentResults = db
      .select()
      .from(threadPostResults)
      .where(gte(threadPostResults.publishedAt, recentSince))
      .all();

    for (const result of recentResults) {
      const topicId = draftTopicMap.get(result.draftId);
      if (!topicId || !activeTopicMap.has(topicId)) {
        continue;
      }

      const current = topicScores.get(topicId) ?? {
        totalRate: 0,
        totalImpressions: 0,
        count: 0,
      };
      current.totalRate +=
        (result.likes + result.repliesCount + result.shares) /
        Math.max(result.impressions, 1);
      current.totalImpressions += result.impressions;
      current.count += 1;
      topicScores.set(topicId, current);
    }

    const ranked: NotePipelineTopic[] = [...topicScores.entries()]
      .map(([topicId, score]) => {
        const topic = activeTopicMap.get(topicId);
        if (!topic) {
          return null;
        }

        return {
          id: topic.id,
          name: topic.name,
          niche: topic.niche,
          priorityScore: topic.priorityScore,
          status: topic.status,
          performanceScore:
            score.totalRate / Math.max(score.count, 1) +
            Math.min(score.totalImpressions / 10_000, 0.2),
        };
      })
      .filter((topic): topic is NotePipelineTopic => Boolean(topic))
      .sort((left, right) => {
        if (right.performanceScore !== left.performanceScore) {
          return right.performanceScore - left.performanceScore;
        }
        return right.priorityScore - left.priorityScore;
      })
      .slice(0, limit);

    if (ranked.length >= limit) {
      return ranked;
    }

    const fallback = await this.topicService.selectDailyTopics(limit * 2);
    const selected = [...ranked];
    for (const topic of fallback) {
      if (selected.some((item) => item.id === topic.id)) {
        continue;
      }
      selected.push({
        ...topic,
        performanceScore: 0,
      });
      if (selected.length >= limit) {
        break;
      }
    }

    return selected;
  }

  private async buildThreadsStrategyFromNoteThemes(
    limit = 3,
  ): Promise<string> {
    const noteTopics = await this.selectNotePipelineTopics(limit);
    if (noteTopics.length === 0) {
      return "";
    }

    return [
      "## note起点の集客テーマ",
      ...noteTopics.map(
        (topic, index) =>
          `${index + 1}. ${topic.name} (${topic.niche}) / priority=${topic.priorityScore} / performance=${topic.performanceScore.toFixed(3)}`,
      ),
      "Threads投稿は上記テーマの記事化と収益化につながる導線を優先すること。",
    ].join("\n");
  }

  async processHumanInputs(
    _llm: LlmClient,
    storage: StorageClient,
  ): Promise<string> {
    const pendingInputs = db
      .select()
      .from(humanInputs)
      .where(eq(humanInputs.processed, 0))
      .all();

    if (pendingInputs.length === 0) {
      return "No pending human inputs.";
    }

    const now = new Date().toISOString();
    const activeTopics = db
      .select()
      .from(topics)
      .where(eq(topics.status, "active"))
      .all();

    let createdTopics = 0;
    let researchAdded = 0;

    for (const input of pendingInputs) {
      if (input.inputType === "directive") {
        const existingTopic = activeTopics.find(
          (topic) => topic.name === input.content,
        );
        if (!existingTopic) {
          const createdTopic = await this.topicService.createTopic(
            input.content,
            input.content,
          );
          activeTopics.push({
            id: createdTopic.id,
            name: createdTopic.name,
            niche: createdTopic.niche,
            priorityScore: createdTopic.priorityScore,
            status: createdTopic.status,
            createdAt: now,
            updatedAt: now,
          });
          createdTopics++;
        }
      } else {
        const targetTopic = activeTopics[0];
        if (targetTopic) {
          db.insert(researchItems)
            .values({
              id: randomUUID(),
              topicId: targetTopic.id,
              source: "manual_input",
              content: `[${input.inputType}] ${input.content}`,
              evidenceType:
                input.inputType === "research" ? "data" : "anecdote",
              confidence: input.inputType === "research" ? "high" : "medium",
              createdAt: now,
            })
            .run();
          researchAdded++;
        }
      }

      db.update(humanInputs)
        .set({
          processed: 1,
          processedAt: now,
        })
        .where(eq(humanInputs.id, input.id))
        .run();
    }

    await storage.saveFile(
      `docs/inputs/processed-${now.replace(/[:.]/g, "-")}.md`,
      pendingInputs
        .map((input) => `- ${input.inputType}: ${input.content}`)
        .join("\n"),
    );

    return `Processed ${pendingInputs.length} human inputs. Created ${createdTopics} topics and added ${researchAdded} research items.`;
  }

  async runNoteResearch(
    _llm: LlmClient,
    storage: StorageClient,
    dryRun = false,
  ): Promise<string> {
    logger.info({ dryRun }, "Starting note research");

    const selectedTopics = await this.topicService.selectDailyTopics(3);
    if (selectedTopics.length === 0) {
      return "No active topics found for note research.";
    }

    const client = dryRun
      ? new DryRunNoteResearchClient()
      : new NoteResearchClientImpl();
    const results: string[] = [];

    for (const topic of selectedTopics) {
      const notes = await client.searchNotes(topic.name);
      await this.researchService.saveCompetitorSnapshot(
        `note_search:${topic.name}`,
        JSON.stringify(notes),
      );
      results.push(`## ${topic.name}\nFound ${notes.length} competitor notes`);
    }

    const date = new Date().toISOString().split("T")[0];
    await storage.saveFile(
      `docs/research/note-competitor-research-${date}.md`,
      `# Note Competitor Research - ${date}\n\n${results.join("\n\n")}`,
    );

    return `Researched note competitors for ${selectedTopics.length} topics. ${dryRun ? "(dry-run)" : ""}`;
  }

  async runThreadsResearch(
    llm: LlmClient,
    storage: StorageClient,
    dryRun = false,
  ): Promise<string> {
    logger.info({ dryRun }, "Starting Threads competitor research");

    const selectedTopics = await this.topicService.selectDailyTopics(3);
    if (selectedTopics.length === 0) {
      return "No active topics found for Threads research.";
    }

    const results: string[] = [];

    for (const topic of selectedTopics) {
      if (dryRun) {
        results.push(`[DRY-RUN] Would research Threads competitors for: ${topic.name}`);
        continue;
      }

      // Web検索でThreads上の競合投稿・アカウントを調査
      const items = await this.researchService.researchTopic(
        topic.id,
        `${topic.name} Threads投稿 人気 バズ`,
        llm,
      );

      // 競合スナップショットとして保存 (threads_search: prefix で Threads 専用識別)
      await this.researchService.saveCompetitorSnapshot(
        `threads_search:${topic.name}`,
        JSON.stringify(
          items.map((i) => ({
            source: i.source,
            content: i.content,
            evidenceType: i.evidenceType,
          })),
        ),
      );

      results.push(
        `## ${topic.name}\nFound ${items.length} Threads competitor insights`,
      );
    }

    // 競合分析を実行 (channel=threads で絞り込み)
    const analysis = await this.researchService.analyzeCompetitorSnapshots(
      llm,
      "threads",
    );

    const date = new Date().toISOString().split("T")[0];
    await storage.saveFile(
      `docs/research/threads-competitor-research-${date}.md`,
      `# Threads Competitor Research - ${date}\n\n${results.join("\n\n")}\n\n## Analysis\n${analysis.summary}`,
    );

    return `Researched Threads competitors for ${selectedTopics.length} topics, found ${analysis.winningPatterns.length} winning patterns. ${dryRun ? "(dry-run)" : ""}`;
  }

  async runDailyTopicResearch(
    llm: LlmClient,
    storage: StorageClient,
    dryRun = false,
  ): Promise<string> {
    logger.info({ dryRun }, "Starting daily topic research");

    const topics = await this.topicService.selectDailyTopics(3);
    if (topics.length === 0) {
      return "No active topics found. Create topics first.";
    }

    const results: string[] = [];
    for (const topic of topics) {
      if (dryRun) {
        results.push(`[DRY-RUN] Would research: ${topic.name}`);
        continue;
      }
      const items = await this.researchService.researchTopic(
        topic.id,
        topic.name,
        llm,
      );
      const summary = await this.researchService.summarizeResearch(items);
      results.push(`## ${topic.name}\n${summary}`);
    }

    const date = new Date().toISOString().split("T")[0];
    const report = `# Daily Topic Research - ${date}\n\n${results.join("\n\n")}`;

    if (!dryRun) {
      await storage.saveFile(
        `docs/research/daily-topic-research-${date}.md`,
        report,
      );
    }

    return `Researched ${topics.length} topics. ${dryRun ? "(dry-run)" : ""}`;
  }

  private getImprovementInsightsSummary(): string {
    const priorityOrder: Record<string, number> = {
      high: 3,
      medium: 2,
      low: 1,
    };

    const retroInsights = db
      .select()
      .from(improvementInsights)
      .where(eq(improvementInsights.sourceType, "retro"))
      .orderBy(desc(improvementInsights.createdAt))
      .limit(10)
      .all()
      .sort(
        (a, b) =>
          (priorityOrder[b.priority] ?? 0) - (priorityOrder[a.priority] ?? 0),
      )
      .slice(0, 3);

    const postInsights = db
      .select()
      .from(improvementInsights)
      .where(eq(improvementInsights.sourceType, "thread_post"))
      .orderBy(desc(improvementInsights.createdAt))
      .limit(10)
      .all()
      .sort(
        (a, b) =>
          (priorityOrder[b.priority] ?? 0) - (priorityOrder[a.priority] ?? 0),
      )
      .slice(0, 3);

    const allInsights = [...retroInsights, ...postInsights];
    if (allInsights.length === 0) return "";

    return allInsights
      .map((i) => `- [${i.priority}] ${i.insight} -> ${i.action}`)
      .join("\n");
  }

  async runDailyThreadsPlan(
    llm: LlmClient,
    storage: StorageClient,
    dryRun = false,
    noteThemeContext?: string,
  ): Promise<string> {
    logger.info({ dryRun }, "Starting daily threads plan");

    const topics = await this.topicService.selectDailyTopics(3);
    if (topics.length === 0) return "No active topics found.";

    let totalDrafts = 0;
    let passedDrafts = 0;
    const date = new Date().toISOString().split("T")[0];

    const insightsSummary = this.getImprovementInsightsSummary();
    const resolvedNoteThemeContext =
      noteThemeContext ??
      (await this.buildThreadsStrategyFromNoteThemes(3));

    for (const topic of topics) {
      if (dryRun) {
        logger.info(`[DRY-RUN] Would generate drafts for: ${topic.name}`);
        continue;
      }

      const researchItems = await this.researchService.getResearchForTopic(
        topic.id,
      );
      const summary =
        await this.researchService.summarizeResearch(researchItems);
      const retrievalContext = this.buildTaskContext(topic.name, "threads");
      const mergedSummary = [summary, retrievalContext]
        .map((item) => item.trim())
        .filter(Boolean)
        .join("\n");

      const drafts = await this.postGenService.generateDrafts(
        topic.id,
        topic.name,
        mergedSummary,
        5,
        llm,
        insightsSummary,
        resolvedNoteThemeContext,
      );
      totalDrafts += drafts.length;

      // P1-A POC不合格 (verdict 86.7% < 90%) によりバッチ版から単発版へロールバック
      // 不一致パターン: 単発=revise/medium → バッチ=pass/low (バッチが甘く判定)
      for (const draft of drafts) {
        const settled = await this.settleThreadDraft(draft, llm);
        if (settled.audit.verdict === "pass") passedDrafts++;

        await storage.saveFile(
          `data/threads/drafts/${date}/${settled.draft.id}.md`,
          `# Draft: ${settled.draft.hookType}\n\n${settled.draft.body}\n\n---\nAudit: ${settled.audit.verdict} (${settled.audit.severity})`,
        );
      }
    }

    return `Generated ${totalDrafts} drafts, ${passedDrafts} passed audit. ${dryRun ? "(dry-run)" : ""}`;
  }

  async runPostPublishFollowup(
    api: ThreadsApiClient,
    llm: LlmClient,
    dryRun = false,
  ): Promise<string> {
    logger.info({ dryRun }, "Starting post publish followup");

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const recentPosts = db
      .select()
      .from(threadPostResults)
      .where(gte(threadPostResults.publishedAt, since))
      .all();

    if (recentPosts.length === 0) {
      return "No posts found for followup in the last 24 hours.";
    }

    if (dryRun) {
      return `Would process ${recentPosts.length} recent posts for followup.`;
    }

    for (const postResult of recentPosts) {
      await this.engagementService.refreshPostMetrics(postResult.id, api);
      await this.engagementService.fetchAndClassifyReplies(
        postResult.id,
        api,
        llm,
      );
      await this.engagementService.analyzePostPerformance(postResult.id, llm);
    }

    return `Processed ${recentPosts.length} posts for post publish followup.`;
  }

  async runNightlyNotePipeline(
    llm: LlmClient,
    storage: StorageClient,
    dryRun = false,
  ): Promise<string> {
    logger.info({ dryRun }, "Starting nightly note pipeline");

    if (dryRun)
      return "[DRY-RUN] Would generate note drafts from winning themes.";

    const topics = await this.selectNotePipelineTopics(3);
    if (topics.length === 0) return "No topics available for note pipeline.";

    const date = new Date().toISOString().split("T")[0];
    let notesGenerated = 0;

    for (const topic of topics) {
      const idea = await this.noteGenService.createIdea(
        topic.name,
        `${topic.niche}に関心のある読者`,
        topic.id,
      );
      const retrievalContext = this.buildTaskContext(topic.name, "note");

      const titles = await this.noteGenService.generateTitleCandidates(
        idea.id,
        llm,
      );
      if (titles.length === 0) continue;

      const outline = await this.noteGenService.generateOutline(
        idea.id,
        titles[0],
        retrievalContext,
        llm,
      );
      const draft = await this.noteGenService.generateDraft(
        idea.id,
        titles[0],
        outline,
        retrievalContext,
        llm,
      );
      notesGenerated++;

      const settled = await this.settleNoteDraft(draft, llm);
      const checklist = await this.noteGenService.generateChecklist(
        settled.draft.id,
      );

      await storage.saveFile(
        `data/note/drafts/${date}/${settled.draft.id}.md`,
        `# ${settled.draft.title}\n\n${settled.draft.body}\n\n---\nAudit: ${settled.audit.verdict} (Score: ${settled.audit.score}/10)\n\n${checklist}`,
      );
    }

    return `Generated ${notesGenerated} note drafts.`;
  }

  async runWeeklyRetro(
    llm: LlmClient,
    storage: StorageClient,
    dryRun = false,
  ): Promise<string> {
    logger.info({ dryRun }, "Starting weekly retro");

    if (dryRun) return "[DRY-RUN] Would generate weekly retrospective.";

    const report = await this.engagementService.generateWeeklyReport(llm);
    this.memoryService.set(
      "department_summary",
      "threads",
      "weekly-retro",
      report,
    );

    const now = new Date();
    const weekNum = Math.ceil(
      (now.getDate() +
        new Date(now.getFullYear(), now.getMonth(), 1).getDay()) /
        7,
    );
    const fileName = `docs/retros/weekly-${now.getFullYear()}-W${String(weekNum).padStart(2, "0")}.md`;

    await storage.saveFile(fileName, `# Weekly Retro\n\n${report}`);

    return "Weekly retro completed.";
  }
}
