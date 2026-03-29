import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  humanReviewItems,
  noteDrafts,
  threadPostDrafts,
} from "../db/schema.js";

const reviewId = process.argv[2];
if (!reviewId) {
  console.error("Usage: pnpm review:reject <review-item-id>");
  process.exit(1);
}

const item = db
  .select()
  .from(humanReviewItems)
  .where(eq(humanReviewItems.id, reviewId))
  .get();

if (!item) {
  console.error(`Review item not found: ${reviewId}`);
  process.exit(1);
}

const now = new Date().toISOString();
const note = process.argv[3] ?? "";

db.update(humanReviewItems)
  .set({ status: "rejected", reviewedAt: now, reviewerNote: note || null })
  .where(eq(humanReviewItems.id, reviewId))
  .run();

if (item.itemType === "thread_draft") {
  db.update(threadPostDrafts)
    .set({ status: "rejected", updatedAt: now })
    .where(eq(threadPostDrafts.id, item.itemId))
    .run();
}

// If it's a note draft, update the draft status
if (item.itemType === "note_draft") {
  db.update(noteDrafts)
    .set({ status: "rejected", updatedAt: now })
    .where(eq(noteDrafts.id, item.itemId))
    .run();
}

console.log(`Rejected: ${reviewId}`);
