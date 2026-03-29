import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { humanReviewItems } from "../db/schema.js";

const status = process.argv[2] ?? "pending";
const items = db
  .select()
  .from(humanReviewItems)
  .where(eq(humanReviewItems.status, status))
  .all();

if (items.length === 0) {
  console.log(`No ${status} review items.`);
} else {
  console.log(
    `\n=== ${status.toUpperCase()} Review Items (${items.length}) ===\n`,
  );
  for (const item of items) {
    console.log(`ID: ${item.id}`);
    console.log(`Type: ${item.itemType}`);
    console.log(`Item ID: ${item.itemId}`);
    console.log(`Reason: ${item.reason}`);
    console.log(`Created: ${item.createdAt}`);
    console.log("---");
  }
}
