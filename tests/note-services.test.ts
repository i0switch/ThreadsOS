import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/db/index.js";
import { NoteGenerationServiceImpl } from "../src/services/note-generation/index.js";

describe("NoteGenerationService", () => {
  const service = new NoteGenerationServiceImpl();

  beforeAll(() => {
    db.run(sql`CREATE TABLE IF NOT EXISTS note_ideas (
      id TEXT PRIMARY KEY,
      source_topic_id TEXT,
      angle TEXT NOT NULL,
      target_reader TEXT NOT NULL,
      priority_score INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'idea',
      created_at TEXT NOT NULL
    )`);
    db.run(sql`CREATE TABLE IF NOT EXISTS note_drafts (
      id TEXT PRIMARY KEY,
      idea_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      outline TEXT,
      cta TEXT,
      publish_readiness_score REAL,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
  });

  it("should create a note idea", async () => {
    const idea = await service.createIdea(
      "自己理解 × 恋愛の失敗パターン",
      "20代の恋愛に悩む女性",
    );
    expect(idea.id).toBeDefined();
    expect(idea.angle).toBe("自己理解 × 恋愛の失敗パターン");
    expect(idea.status).toBe("idea");
  });

  it("should list ideas", async () => {
    const ideas = await service.listIdeas();
    expect(ideas.length).toBeGreaterThanOrEqual(1);
  });

  it("should generate a checklist", async () => {
    const idea = await service.createIdea("テスト角度", "テスト読者");
    // Create a mock draft directly in DB
    const draftId = `test-draft-${Date.now()}`;
    db.run(
      sql`INSERT INTO note_drafts (id, idea_id, title, body, status, created_at, updated_at) VALUES (${draftId}, ${idea.id}, 'テストタイトル', 'テスト本文', 'draft', datetime('now'), datetime('now'))`,
    );

    const checklist = await service.generateChecklist(draftId);
    expect(checklist).toContain("手動公開チェックリスト");
    expect(checklist).toContain("テストタイトル");
  });
});
