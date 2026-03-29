import { z } from "zod";

export const noteIdeaSchema = z.object({
  id: z.string(),
  sourceTopicId: z.string().optional(),
  angle: z.string(),
  targetReader: z.string(),
  priorityScore: z.number().min(0).max(100),
  status: z.enum([
    "idea",
    "drafting",
    "drafted",
    "audited",
    "ready",
    "published",
  ]),
});
export type NoteIdea = z.infer<typeof noteIdeaSchema>;

export const noteDraftSchema = z.object({
  id: z.string(),
  ideaId: z.string(),
  title: z.string(),
  body: z.string(),
  outline: z.string().optional(),
  cta: z.string().optional(),
  publishReadinessScore: z.number().min(0).max(10).optional(),
  status: z.enum(["draft", "audited", "approved", "published", "rejected"]),
});
export type NoteDraft = z.infer<typeof noteDraftSchema>;

export const noteAuditSchema = z.object({
  id: z.string(),
  draftId: z.string(),
  verdict: z.enum(["pass", "revise", "reject", "human_review"]),
  strongestSection: z.string().optional(),
  weakestSection: z.string().optional(),
  rewriteGuidance: z.string().optional(),
  score: z.number().min(0).max(10),
});
export type NoteAudit = z.infer<typeof noteAuditSchema>;
