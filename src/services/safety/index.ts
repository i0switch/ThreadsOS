import { desc, eq, gte } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  budgetTracking,
  scheduledJobRuns,
  threadPostDrafts,
  threadPostResults,
} from "../../db/schema.js";
import type { ScheduledAction } from "../content-scheduler/index.js";

export interface SafetyService {
  checkDuplicatePost(body: string): boolean;
  checkAutoApproval(action: ScheduledAction): boolean;
  checkCostDegradation(): "normal" | "degraded" | "emergency";
  shouldForceStop(): boolean;
}

/**
 * Auto-approvable action types: routine posts, engagement fetches, replies,
 * notifications, and schedule optimization are safe to run without human review.
 * Large-scope changes (weekly retro, research) require review in some contexts,
 * but for now we treat them as auto-approvable since the executive already gates them.
 */
const AUTO_APPROVABLE_ACTIONS: Set<string> = new Set([
  "generate_and_post",
  "generate_note",
  "fetch_engagement",
  "reply_safe",
  "optimize_schedule",
  "notify",
  "research_threads",
  "research_note",
]);

/**
 * Actions that represent major strategy changes and should NOT be auto-approved.
 */
const REQUIRES_REVIEW_ACTIONS: Set<string> = new Set(["weekly_retro"]);

export function createSafetyService(): SafetyService {
  /**
   * Check whether the given post body duplicates a post published in the last 24 hours.
   * Returns true if a duplicate is found.
   */
  function checkDuplicatePost(body: string): boolean {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // Get recent post results
    const recentResults = db
      .select()
      .from(threadPostResults)
      .where(gte(threadPostResults.publishedAt, since))
      .all();

    if (recentResults.length === 0) return false;

    // Get the draft bodies for those results
    const recentDraftIds = recentResults.map((r) => r.draftId);
    const recentDrafts = db
      .select()
      .from(threadPostDrafts)
      .all()
      .filter((d) => recentDraftIds.includes(d.id));

    const normalizedBody = normalizeText(body);

    for (const draft of recentDrafts) {
      const normalizedDraft = normalizeText(draft.body);
      if (normalizedBody === normalizedDraft) return true;
      if (similarity(normalizedBody, normalizedDraft) > 0.85) return true;
    }

    return false;
  }

  /**
   * Check whether the given action can be auto-approved.
   * Returns true if auto-approval is allowed.
   */
  function checkAutoApproval(action: ScheduledAction): boolean {
    if (REQUIRES_REVIEW_ACTIONS.has(action.type)) return false;
    return AUTO_APPROVABLE_ACTIONS.has(action.type);
  }

  /**
   * Check cost degradation level based on budget consumption.
   * - emergency: any scope has used >= 95% of budget
   * - degraded: any scope has used >= 80% of budget
   * - normal: otherwise
   */
  function checkCostDegradation(): "normal" | "degraded" | "emergency" {
    const budgets = db.select().from(budgetTracking).all();
    if (budgets.length === 0) return "normal";

    let maxTokenRatio = 0;
    let maxCallRatio = 0;

    for (const budget of budgets) {
      if (budget.tokensLimit > 0) {
        maxTokenRatio = Math.max(
          maxTokenRatio,
          budget.tokensUsed / budget.tokensLimit,
        );
      }
      if (budget.callsLimit > 0) {
        maxCallRatio = Math.max(
          maxCallRatio,
          budget.callsUsed / budget.callsLimit,
        );
      }
    }

    const maxRatio = Math.max(maxTokenRatio, maxCallRatio);
    if (maxRatio >= 0.95) return "emergency";
    if (maxRatio >= 0.8) return "degraded";
    return "normal";
  }

  /**
   * Check whether the system should force-stop.
   * Returns true if the last 5 consecutive job runs all failed.
   */
  function shouldForceStop(): boolean {
    const recentRuns = db
      .select()
      .from(scheduledJobRuns)
      .where(eq(scheduledJobRuns.jobName, "hourly-heartbeat"))
      .orderBy(desc(scheduledJobRuns.startedAt))
      .limit(5)
      .all();

    if (recentRuns.length < 5) return false;
    return recentRuns.every((run) => run.status === "failed");
  }

  return {
    checkDuplicatePost,
    checkAutoApproval,
    checkCostDegradation,
    shouldForceStop,
  };
}

// ── Internal helpers ────────────────────────────────────────────────

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Simple bigram similarity (Dice coefficient).
 */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const bigramsA = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const bigram = a.slice(i, i + 2);
    bigramsA.set(bigram, (bigramsA.get(bigram) ?? 0) + 1);
  }

  let intersectionSize = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const bigram = b.slice(i, i + 2);
    const count = bigramsA.get(bigram);
    if (count && count > 0) {
      bigramsA.set(bigram, count - 1);
      intersectionSize++;
    }
  }

  return (2 * intersectionSize) / (a.length - 1 + (b.length - 1));
}
