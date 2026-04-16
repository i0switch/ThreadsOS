import { z } from "zod";

export const topicSchema = z.object({
  id: z.string(),
  name: z.string(),
  niche: z.string(),
  priorityScore: z.number().min(0).max(100),
  status: z.enum(["active", "archived", "testing"]),
});
export type Topic = z.infer<typeof topicSchema>;

export const researchItemSchema = z.object({
  id: z.string(),
  topicId: z.string(),
  source: z.string(),
  content: z.string(),
  evidenceType: z.enum([
    "data",
    "anecdote",
    "expert",
    "trend",
    "market",
    "genre_insight",
  ]),
  confidence: z.enum(["high", "medium", "low"]),
});
export type ResearchItem = z.infer<typeof researchItemSchema>;

export const threadPostDraftSchema = z.object({
  id: z.string(),
  topicId: z.string(),
  body: z.string(),
  hookType: z.string(),
  ctaType: z.string(),
  noteTransition: z.string().optional(),
  status: z.enum(["draft", "audited", "approved", "published", "rejected"]),
});
export type ThreadPostDraft = z.infer<typeof threadPostDraftSchema>;

export const threadPostAuditSchema = z.object({
  id: z.string(),
  draftId: z.string(),
  verdict: z.enum(["pass", "revise", "reject"]),
  severity: z.enum(["low", "medium", "high"]),
  reasons: z.array(z.string()),
  suggestions: z.array(z.string()),
});
export type ThreadPostAudit = z.infer<typeof threadPostAuditSchema>;

export const threadPostResultSchema = z.object({
  id: z.string(),
  draftId: z.string(),
  threadsPostId: z.string(),
  impressions: z.number(),
  likes: z.number(),
  repliesCount: z.number(),
  shares: z.number(),
  publishedAt: z.string(),
});
export type ThreadPostResult = z.infer<typeof threadPostResultSchema>;

export const threadReplySchema = z.object({
  id: z.string(),
  postResultId: z.string(),
  threadsReplyId: z.string(),
  author: z.string(),
  body: z.string(),
  sentiment: z.enum(["positive", "negative", "neutral", "question"]).optional(),
});
export type ThreadReply = z.infer<typeof threadReplySchema>;
