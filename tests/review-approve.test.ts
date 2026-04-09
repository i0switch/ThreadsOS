import { sql } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = ":memory:";

type Db = typeof import("../src/db/index.js")["db"];
type SchemaModule = typeof import("../src/db/schema.js");
type ApproveReviewItem =
  typeof import("../src/cli/review-approve.js")["approveReviewItem"];

let db: Db;
let schema: SchemaModule;
let approveReviewItem: ApproveReviewItem;

beforeAll(async () => {
  vi.resetModules();
  ({ db } = await import("../src/db/index.js"));
  schema = await import("../src/db/schema.js");
  const bootstrap = await import("../src/db/bootstrap.js");
  bootstrap.ensureAutonomyTables();
  ({ approveReviewItem } = await import("../src/cli/review-approve.js"));
});

afterEach(() => {
  db.run(sql`DELETE FROM human_review_items`);
  db.run(sql`DELETE FROM note_drafts`);
});

describe("approveReviewItem", () => {
  it("restores approved note drafts to an auditable publishable state", () => {
    const now = new Date().toISOString();

    db.insert(schema.noteDrafts)
      .values({
        id: "note-draft-approve-1",
        ideaId: "idea-1",
        title: "タイトル",
        body: "本文",
        outline: null,
        cta: null,
        publishReadinessScore: 5,
        status: "draft",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    db.insert(schema.humanReviewItems)
      .values({
        id: "review-1",
        itemType: "note_draft",
        itemId: "note-draft-approve-1",
        reason: "manual review",
        status: "pending",
        createdAt: now,
      })
      .run();

    approveReviewItem("review-1", "looks good");

    const draft = db
      .select()
      .from(schema.noteDrafts)
      .where(sql`${schema.noteDrafts.id} = 'note-draft-approve-1'`)
      .get();
    const review = db
      .select()
      .from(schema.humanReviewItems)
      .where(sql`${schema.humanReviewItems.id} = 'review-1'`)
      .get();

    expect(draft?.status).toBe("audited");
    expect(draft?.publishReadinessScore).toBe(7);
    expect(review?.status).toBe("approved");
    expect(review?.reviewerNote).toBe("looks good");
  });
});
