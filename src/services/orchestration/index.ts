import { randomUUID } from "node:crypto";
import { eq, gte } from "drizzle-orm";
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
  researchItems,
  threadPostResults,
  topics,
} from "../../db/schema.js";
import { EngagementAnalysisServiceImpl } from "../engagement-analysis/index.js";
import { PostAuditServiceImpl } from "../post-audit/index.js";
import { PostGenerationServiceImpl } from "../post-generation/index.js";
import { ResearchServiceImpl } from "../research/index.js";
import { TopicSelectionServiceImpl } from "../topic-selection/index.js";

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
}

export class OrchestrationServiceImpl implements OrchestrationService {
  private topicService = new TopicSelectionServiceImpl();
  private researchService = new ResearchServiceImpl();
  private postGenService = new PostGenerationServiceImpl();
  private postAuditService = new PostAuditServiceImpl();
  private engagementService = new EngagementAnalysisServiceImpl();

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

  async runDailyThreadsPlan(
    llm: LlmClient,
    storage: StorageClient,
    dryRun = false,
  ): Promise<string> {
    logger.info({ dryRun }, "Starting daily threads plan");

    const topics = await this.topicService.selectDailyTopics(3);
    if (topics.length === 0) return "No active topics found.";

    let totalDrafts = 0;
    let passedDrafts = 0;
    const date = new Date().toISOString().split("T")[0];

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

      const drafts = await this.postGenService.generateDrafts(
        topic.id,
        topic.name,
        summary,
        5,
        llm,
      );
      totalDrafts += drafts.length;

      for (const draft of drafts) {
        const audit = await this.postAuditService.auditDraft(draft.id, llm);
        if (audit.verdict === "pass") passedDrafts++;

        await storage.saveFile(
          `data/threads/drafts/${date}/${draft.id}.md`,
          `# Draft: ${draft.hookType}\n\n${draft.body}\n\n---\nAudit: ${audit.verdict} (${audit.severity})`,
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

    const { NoteGenerationServiceImpl } = await import(
      "../note-generation/index.js"
    );
    const { NoteAuditServiceImpl } = await import("../note-audit/index.js");

    const noteGenService = new NoteGenerationServiceImpl();
    const noteAuditService = new NoteAuditServiceImpl();

    const topics = await this.topicService.selectDailyTopics(3);
    if (topics.length === 0) return "No topics available for note pipeline.";

    const date = new Date().toISOString().split("T")[0];
    let notesGenerated = 0;

    for (const topic of topics) {
      const idea = await noteGenService.createIdea(
        topic.name,
        `${topic.niche}に関心のある読者`,
        topic.id,
      );

      const titles = await noteGenService.generateTitleCandidates(idea.id, llm);
      if (titles.length === 0) continue;

      const outline = await noteGenService.generateOutline(
        idea.id,
        titles[0],
        llm,
      );
      const draft = await noteGenService.generateDraft(
        idea.id,
        titles[0],
        outline,
        llm,
      );
      notesGenerated++;

      const audit = await noteAuditService.auditDraft(draft.id, llm);
      const checklist = await noteGenService.generateChecklist(draft.id);

      await storage.saveFile(
        `data/note/drafts/${date}/${draft.id}.md`,
        `# ${draft.title}\n\n${draft.body}\n\n---\nAudit: ${audit.verdict} (Score: ${audit.score}/10)\n\n${checklist}`,
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
