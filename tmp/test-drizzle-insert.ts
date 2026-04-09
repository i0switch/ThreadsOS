import { db } from "../src/db/index.js";
import { noteDrafts, noteAudits, humanReviewItems } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const now = new Date().toISOString();
const id = "test-drizzle-" + randomUUID();

try {
  // Step 1: insert noteDrafts (regenerateDraft)
  db.insert(noteDrafts).values({
    id,
    ideaId: "test-idea",
    title: "Test",
    body: "Test body",
    outline: null,
    cta: null,
    status: "draft",
    createdAt: now,
    updatedAt: now,
  }).run();
  console.log("1. noteDrafts insert: OK");

  // Step 2: insert noteAudits (auditDraft)
  const auditId = "test-audit-" + randomUUID();
  db.insert(noteAudits).values({
    id: auditId,
    draftId: id,
    verdict: "revise",
    strongestSection: "intro",
    weakestSection: "cta",
    rewriteGuidance: "fix cta",
    score: 6,
    createdAt: now,
  }).run();
  console.log("2. noteAudits insert: OK");

  // Step 3: update noteDrafts status (auditDraft)
  db.update(noteDrafts).set({
    status: "draft",
    publishReadinessScore: 6,
    updatedAt: now,
  }).where(eq(noteDrafts.id, id)).run();
  console.log("3. noteDrafts update: OK");

  // Step 4: insert humanReviewItems (auditDraft for low score)
  const reviewId = randomUUID();
  db.insert(humanReviewItems).values({
    id: reviewId,
    itemType: "note_draft",
    itemId: id,
    reason: "Score: 6/10. cta / fix cta",
    status: "pending",
    createdAt: now,
  }).run();
  console.log("4. humanReviewItems insert: OK");

  // Step 5: regenerateDraft (new draft, same idea)
  const id2 = "test-drizzle2-" + randomUUID();
  db.insert(noteDrafts).values({
    id: id2,
    ideaId: "test-idea",
    title: "Test Rewritten",
    body: "Rewritten body content here",
    outline: null,
    cta: null,
    status: "draft",
    createdAt: now,
    updatedAt: now,
  }).run();
  console.log("5. noteDrafts insert 2 (regenerate): OK");

  // Step 6: second auditDraft for new draft
  const auditId2 = "test-audit2-" + randomUUID();
  db.insert(noteAudits).values({
    id: auditId2,
    draftId: id2,
    verdict: "pass",
    strongestSection: "all",
    weakestSection: null,
    rewriteGuidance: null,
    score: 8,
    createdAt: now,
  }).run();
  console.log("6. noteAudits insert 2 (re-audit): OK");

  // Cleanup
  db.delete(noteAudits).where(eq(noteAudits.draftId, id)).run();
  db.delete(noteAudits).where(eq(noteAudits.draftId, id2)).run();
  db.delete(humanReviewItems).where(eq(humanReviewItems.id, reviewId)).run();
  db.delete(noteDrafts).where(eq(noteDrafts.id, id)).run();
  db.delete(noteDrafts).where(eq(noteDrafts.id, id2)).run();
  console.log("Cleanup: OK");
  console.log("\nAll 6 steps passed - Drizzle ORM is fine!");
} catch(e) {
  console.error("FAILED at step:", (e as Error).message);
}
