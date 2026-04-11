import { and, eq, gt } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  competitorSnapshots,
  heartbeatStates,
  humanInputs,
  outboundNotifications,
  scheduledJobRuns,
  threadPostResults,
  threadReplies,
} from "../../db/schema.js";

export interface HeartbeatDiff {
  newReplies: number;
  newEngagement: number;
  newCompetitorPosts: number;
  newErrors: number;
  newDirectives: number;
  newHumanInputs: number;
}

export interface DiffCollectorService {
  collectSinceLastHeartbeat(): Promise<HeartbeatDiff>;
}

export function createDiffCollectorService(): DiffCollectorService {
  async function collectSinceLastHeartbeat(): Promise<HeartbeatDiff> {
    // Get the last heartbeat time
    const hbState = db
      .select()
      .from(heartbeatStates)
      .where(eq(heartbeatStates.jobName, "hourly-heartbeat"))
      .all();

    const since =
      hbState.length > 0 && hbState[0].lastRunAt
        ? hbState[0].lastRunAt
        : new Date(0).toISOString();

    // Count new replies since last heartbeat
    const newReplies = db
      .select()
      .from(threadReplies)
      .where(gt(threadReplies.createdAt, since))
      .all().length;

    // Count posts with updated engagement metrics
    const newEngagement = db
      .select()
      .from(threadPostResults)
      .where(gt(threadPostResults.createdAt, since))
      .all().length;

    // Count new competitor snapshots
    const newCompetitorPosts = db
      .select()
      .from(competitorSnapshots)
      .where(gt(competitorSnapshots.createdAt, since))
      .all().length;

    // Count failed job runs as errors
    const newErrors = db
      .select()
      .from(scheduledJobRuns)
      .where(
        and(
          eq(scheduledJobRuns.status, "failed"),
          gt(scheduledJobRuns.createdAt, since),
        ),
      )
      .all().length;

    // Count new notifications as directives
    const newDirectives = db
      .select()
      .from(outboundNotifications)
      .where(gt(outboundNotifications.sentAt, since))
      .all().length;

    // Count unprocessed human inputs
    const newHumanInputs = db
      .select()
      .from(humanInputs)
      .where(
        and(eq(humanInputs.processed, 0), gt(humanInputs.createdAt, since)),
      )
      .all().length;

    return {
      newReplies,
      newEngagement,
      newCompetitorPosts,
      newErrors,
      newDirectives,
      newHumanInputs,
    };
  }

  return {
    collectSinceLastHeartbeat,
  };
}
