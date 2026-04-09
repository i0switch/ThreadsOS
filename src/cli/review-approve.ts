import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  humanReviewItems,
  noteDrafts,
  threadPostDrafts,
} from "../db/schema.js";

export function approveReviewItem(reviewId: string, reviewerNote = "") {
  const item = db
    .select()
    .from(humanReviewItems)
    .where(eq(humanReviewItems.id, reviewId))
    .get();

  if (!item) {
    throw new Error(`Review item not found: ${reviewId}`);
  }

  const now = new Date().toISOString();

  db.update(humanReviewItems)
    .set({
      status: "approved",
      reviewedAt: now,
      reviewerNote: reviewerNote || null,
    })
    .where(eq(humanReviewItems.id, reviewId))
    .run();

  if (item.itemType === "thread_draft") {
    db.update(threadPostDrafts)
      .set({ status: "audited", updatedAt: now })
      .where(eq(threadPostDrafts.id, item.itemId))
      .run();
  }

  if (item.itemType === "note_draft") {
    const draft = db
      .select()
      .from(noteDrafts)
      .where(eq(noteDrafts.id, item.itemId))
      .get();

    db.update(noteDrafts)
      .set({
        status: "audited",
        publishReadinessScore: Math.max(draft?.publishReadinessScore ?? 0, 7),
        updatedAt: now,
      })
      .where(eq(noteDrafts.id, item.itemId))
      .run();
  }

  return item;
}

const isCliEntry =
  fileURLToPath(import.meta.url).replace(/\\/g, "/") ===
  (process.argv[1] ?? "").replace(/\\/g, "/");
const reviewId = process.argv[2];
if (isCliEntry && reviewId) {
  try {
    approveReviewItem(reviewId, process.argv[3] ?? "");
    console.log(`Approved: ${reviewId}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
} else if (isCliEntry) {
  console.error("Usage: pnpm review:approve <review-item-id>");
  process.exit(1);
}
