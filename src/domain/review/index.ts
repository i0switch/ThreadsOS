import { z } from "zod";

export const replyDecisionSchema = z.object({
  id: z.string(),
  replyId: z.string(),
  decision: z.enum(["safe_auto_reply", "human_review", "ignore"]),
  autoReplyBody: z.string().optional(),
});
export type ReplyDecision = z.infer<typeof replyDecisionSchema>;

export const humanReviewItemSchema = z.object({
  id: z.string(),
  itemType: z.enum([
    "thread_draft",
    "thread_reply",
    "note_draft",
    "auto_reply",
  ]),
  itemId: z.string(),
  reason: z.string(),
  status: z.enum(["pending", "approved", "rejected"]),
  reviewedAt: z.string().optional(),
  reviewerNote: z.string().optional(),
});
export type HumanReviewItem = z.infer<typeof humanReviewItemSchema>;

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
