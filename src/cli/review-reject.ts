import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  humanReviewItems,
  noteDrafts,
  threadPostDrafts,
} from "../db/schema.js";

export function rejectReviewItem(reviewId: string, reviewerNote = ""): void {
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
      status: "rejected",
      reviewedAt: now,
      reviewerNote: reviewerNote || null,
    })
    .where(eq(humanReviewItems.id, reviewId))
    .run();

  if (item.itemType === "thread_draft") {
    db.update(threadPostDrafts)
      .set({ status: "rejected", updatedAt: now })
      .where(eq(threadPostDrafts.id, item.itemId))
      .run();
  }

  if (item.itemType === "note_draft") {
    db.update(noteDrafts)
      .set({ status: "rejected", updatedAt: now })
      .where(eq(noteDrafts.id, item.itemId))
      .run();
  }
}

const isCliEntry =
  import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}` ||
  import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`;

if (isCliEntry) {
  const reviewId = process.argv[2];
  if (!reviewId) {
    console.error("Usage: pnpm review:reject <review-item-id>");
    process.exit(1);
  }

  try {
    rejectReviewItem(reviewId, process.argv[3] ?? "");
    console.log(`Rejected: ${reviewId}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
