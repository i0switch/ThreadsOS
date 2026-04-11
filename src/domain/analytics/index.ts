import { z } from "zod";

export const improvementInsightSchema = z.object({
  id: z.string(),
  sourceType: z.enum(["thread_post", "note", "retro", "reply_effect"]),
  sourceId: z.string(),
  insight: z.string(),
  action: z.string(),
  priority: z.enum(["high", "medium", "low"]),
});
export type ImprovementInsight = z.infer<typeof improvementInsightSchema>;

export const competitorSnapshotSchema = z.object({
  id: z.string(),
  source: z.string(),
  data: z.string(),
  snapshotDate: z.string(),
});
export type CompetitorSnapshot = z.infer<typeof competitorSnapshotSchema>;
