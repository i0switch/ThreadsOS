import { z } from "zod";

export const replyDecisionSchema = z.object({
  id: z.string(),
  replyId: z.string(),
  decision: z.enum(["safe_auto_reply", "quarantine", "ignore"]),
  autoReplyBody: z.string().optional(),
});
export type ReplyDecision = z.infer<typeof replyDecisionSchema>;

export const scheduledJobRunSchema = z.object({
  id: z.string(),
  jobName: z.string(),
  status: z.enum(["running", "completed", "failed"]),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  dryRun: z.boolean(),
  resultSummary: z.string().optional(),
});
export type ScheduledJobRun = z.infer<typeof scheduledJobRunSchema>;
