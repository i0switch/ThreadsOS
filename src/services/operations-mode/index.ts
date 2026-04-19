import { and, desc, eq, gte } from "drizzle-orm";
import { loadEnv } from "../../config/env.js";
import { db } from "../../db/index.js";
import {
  anomalyEvents,
  type OPERATIONS_MODES,
  operationsModeState,
  runnerHealth,
  scheduledJobRuns,
  sessionHealth,
  systemControls,
} from "../../db/schema.js";
import type { ActionType } from "../content-scheduler/index.js";

export type OperationsMode = (typeof OPERATIONS_MODES)[number];

export interface OperationsModeEvidence {
  activeGlobalPause: boolean;
  noteSessionState:
    | "healthy"
    | "degraded"
    | "quarantined"
    | "recovered"
    | "missing";
  publishFailureSignals: number;
  recentHighSeverityAnomalies: number;
  recentFailedJobs: string[];
  trippedRunners: number;
  degradedRunners: number;
}

export interface OperationsModeEvaluation {
  mode: OperationsMode;
  reason: string;
  evidence: OperationsModeEvidence;
  previousMode: OperationsMode | null;
  changed: boolean;
}

export interface OperationsModeActionDecision {
  allowed: boolean;
  mode: OperationsMode;
  reason: string;
}

export interface OperationsModeService {
  evaluateMode(): Omit<OperationsModeEvaluation, "previousMode" | "changed">;
  reconcileMode(): OperationsModeEvaluation;
  getCurrentMode(): OperationsMode;
  getActionDecision(actionType: ActionType): OperationsModeActionDecision;
  isChannelWritable(channel: "threads" | "note"): boolean;
}

const MODE_SCOPE = "global";
const RECENT_WINDOW_MS = loadEnv().OPERATIONS_MODE_WINDOW_MS;
const NOTE_ACTIONS = new Set<ActionType>(["generate_note", "research_note"]);
const OBSERVE_ONLY_ACTIONS = new Set<ActionType>([
  "fetch_engagement",
  "notify",
  "process_human_inputs",
]);
const SAFE_FREEZE_ACTIONS = new Set<ActionType>(["notify"]);
const PUBLISH_FAILURE_JOB_NAMES = new Set([
  "hourly-heartbeat",
  "nightly-note-pipeline",
  "post-publish-followup",
]);
const BLOCKING_RUNNERS = new Set([
  "claude",
  "threads-metrics-sync",
  "note-metrics-sync",
]);

function nowIso(): string {
  return new Date().toISOString();
}

function toLowerHaystack(...values: Array<string | null | undefined>): string {
  return values.filter(Boolean).join(" ").toLowerCase();
}

function isHighSeverity(severity: string): boolean {
  return severity === "high" || severity === "critical";
}

function looksLikePublishFailure(text: string): boolean {
  return /(publish|outbox|adapter|session|threads|note|token|api|quota)/i.test(
    text,
  );
}

function buildDistinctAnomalyKey(category: string, message: string): string {
  return `${category}::${message}`;
}

function deriveNoteSessionState(): OperationsModeEvidence["noteSessionState"] {
  const rows = db
    .select()
    .from(sessionHealth)
    .orderBy(desc(sessionHealth.updatedAt))
    .all()
    .filter((row) => /note/i.test(toLowerHaystack(row.scope, row.provider)));

  if (rows.length === 0) {
    return "missing";
  }
  if (rows.some((row) => row.state === "quarantined")) {
    return "quarantined";
  }
  if (rows.some((row) => row.state === "degraded")) {
    return "degraded";
  }
  if (rows.some((row) => row.state === "recovered")) {
    return "recovered";
  }
  return "healthy";
}

export function createOperationsModeService(): OperationsModeService {
  function evaluateMode(): Omit<
    OperationsModeEvaluation,
    "previousMode" | "changed"
  > {
    const since = new Date(Date.now() - RECENT_WINDOW_MS).toISOString();
    const activeGlobalPause = Boolean(
      db
        .select()
        .from(systemControls)
        .where(
          and(
            eq(systemControls.scope, MODE_SCOPE),
            eq(systemControls.action, "pause"),
            eq(systemControls.active, 1),
          ),
        )
        .get(),
    );

    const noteSessionState = deriveNoteSessionState();
    const recentAnomalies = db
      .select()
      .from(anomalyEvents)
      .where(gte(anomalyEvents.detectedAt, since))
      .orderBy(desc(anomalyEvents.detectedAt))
      .all();
    const recentHighSeverityAnomalies = recentAnomalies.filter((row) =>
      isHighSeverity(row.severity),
    );
    const distinctHighSeverityAnomalies = new Set(
      recentHighSeverityAnomalies.map((row) =>
        buildDistinctAnomalyKey(row.category, row.message),
      ),
    );
    const publishRelatedHighSeverityAnomalies =
      recentHighSeverityAnomalies.filter((row) =>
        looksLikePublishFailure(
          toLowerHaystack(row.category, row.message, row.metadataJson),
        ),
      );
    const recentJobRuns = db
      .select()
      .from(scheduledJobRuns)
      .where(gte(scheduledJobRuns.startedAt, since))
      .orderBy(desc(scheduledJobRuns.startedAt))
      .all()
      .filter(
        (row) =>
          !/^Stuck running for over|^Stale running cleaned up/i.test(
            row.resultSummary ?? "",
          ),
      );
    const latestPublishRuns = new Map<string, (typeof recentJobRuns)[number]>();
    for (const row of recentJobRuns) {
      if (
        PUBLISH_FAILURE_JOB_NAMES.has(row.jobName) &&
        !latestPublishRuns.has(row.jobName)
      ) {
        latestPublishRuns.set(row.jobName, row);
      }
    }
    const latestPublishFailures = Array.from(latestPublishRuns.values()).filter(
      (row) => row.status === "failed",
    );
    const recentFailedJobs = recentJobRuns.filter(
      (row) => row.status === "failed",
    );

    const publishFailureSignals =
      publishRelatedHighSeverityAnomalies.length + latestPublishFailures.length;

    const runners = db.select().from(runnerHealth).all();
    const blockingRunners = runners.filter((row) =>
      BLOCKING_RUNNERS.has(row.runner),
    );
    const trippedRunners = blockingRunners.filter(
      (row) => row.status === "tripped",
    ).length;
    const degradedRunners = blockingRunners.filter(
      (row) => row.status === "degraded",
    ).length;

    const evidence: OperationsModeEvidence = {
      activeGlobalPause,
      noteSessionState,
      publishFailureSignals,
      recentHighSeverityAnomalies: distinctHighSeverityAnomalies.size,
      recentFailedJobs: recentFailedJobs.map((row) => row.jobName),
      trippedRunners,
      degradedRunners,
    };

    if (
      activeGlobalPause ||
      trippedRunners >= 2 ||
      distinctHighSeverityAnomalies.size >= 3 ||
      (noteSessionState === "quarantined" && publishFailureSignals > 0)
    ) {
      return {
        mode: "safe_freeze",
        reason: activeGlobalPause
          ? "global pause is active"
          : "multiple critical failures detected",
        evidence,
      };
    }

    if (publishFailureSignals > 0 || trippedRunners >= 1) {
      return {
        mode: "observe_only",
        reason: "publishing adapters or runners are degraded",
        evidence,
      };
    }

    if (
      noteSessionState === "quarantined" ||
      noteSessionState === "degraded" ||
      noteSessionState === "missing"
    ) {
      return {
        mode: "threads_only",
        reason:
          noteSessionState === "missing"
            ? "note session is not configured — operating Threads-only until session is established"
            : "note session is unavailable",
        evidence,
      };
    }

    return {
      mode: "full_autonomy",
      reason: "all monitored systems are healthy",
      evidence,
    };
  }

  function reconcileMode(): OperationsModeEvaluation {
    const evaluated = evaluateMode();
    const existing = db
      .select()
      .from(operationsModeState)
      .where(eq(operationsModeState.scope, MODE_SCOPE))
      .get();
    const now = nowIso();
    const previousMode = (existing?.mode as OperationsMode | undefined) ?? null;
    const changed = previousMode !== evaluated.mode;

    if (!existing) {
      db.insert(operationsModeState)
        .values({
          scope: MODE_SCOPE,
          mode: evaluated.mode,
          reason: evaluated.reason,
          evidenceJson: JSON.stringify(evaluated.evidence),
          lastTransitionAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    } else {
      db.update(operationsModeState)
        .set({
          mode: evaluated.mode,
          reason: evaluated.reason,
          evidenceJson: JSON.stringify(evaluated.evidence),
          lastTransitionAt: changed ? now : existing.lastTransitionAt,
          updatedAt: now,
        })
        .where(eq(operationsModeState.scope, MODE_SCOPE))
        .run();
    }

    return {
      ...evaluated,
      previousMode,
      changed,
    };
  }

  function getCurrentMode(): OperationsMode {
    const row = db
      .select()
      .from(operationsModeState)
      .where(eq(operationsModeState.scope, MODE_SCOPE))
      .get();
    if (row?.mode) {
      return row.mode as OperationsMode;
    }
    return reconcileMode().mode;
  }

  function isChannelWritable(channel: "threads" | "note"): boolean {
    const mode = getCurrentMode();
    if (mode === "safe_freeze" || mode === "observe_only") {
      return false;
    }
    if (mode === "threads_only" && channel === "note") {
      return false;
    }
    return true;
  }

  function getActionDecision(
    actionType: ActionType,
  ): OperationsModeActionDecision {
    const mode = getCurrentMode();
    if (mode === "safe_freeze") {
      return {
        allowed: SAFE_FREEZE_ACTIONS.has(actionType),
        mode,
        reason: SAFE_FREEZE_ACTIONS.has(actionType)
          ? "safe freeze allows notification only"
          : "safe freeze blocks non-observation actions",
      };
    }

    if (mode === "observe_only") {
      return {
        allowed: OBSERVE_ONLY_ACTIONS.has(actionType),
        mode,
        reason: OBSERVE_ONLY_ACTIONS.has(actionType)
          ? "observe-only keeps measurement and notifications running"
          : "observe-only blocks new execution and experiments",
      };
    }

    if (mode === "threads_only" && NOTE_ACTIONS.has(actionType)) {
      return {
        allowed: false,
        mode,
        reason: "threads-only blocks note generation and note research",
      };
    }

    return {
      allowed: true,
      mode,
      reason: "mode allows this action",
    };
  }

  return {
    evaluateMode,
    reconcileMode,
    getCurrentMode,
    getActionDecision,
    isChannelWritable,
  };
}
