import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/db/index.js";
import { TopicSelectionServiceImpl } from "../src/services/topic-selection/index.js";

describe("TopicSelectionService", () => {
  const service = new TopicSelectionServiceImpl();

  beforeAll(() => {
    // Ensure table exists (test db)
    db.run(sql`CREATE TABLE IF NOT EXISTS topics (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      niche TEXT NOT NULL,
      priority_score INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
  });

  it("should create a topic", async () => {
    const topic = await service.createTopic("テスト恋愛", "恋愛", 80);
    expect(topic.id).toBeDefined();
    expect(topic.name).toBe("テスト恋愛");
    expect(topic.niche).toBe("恋愛");
    expect(topic.priorityScore).toBe(80);
    expect(topic.status).toBe("active");
  });

  it("should select daily topics by priority", async () => {
    await service.createTopic("高優先度", "ビジネス", 90);
    await service.createTopic("低優先度", "趣味", 10);

    const selected = await service.selectDailyTopics(2);
    expect(selected.length).toBeLessThanOrEqual(2);
    if (selected.length >= 2) {
      expect(selected[0].priorityScore).toBeGreaterThanOrEqual(
        selected[1].priorityScore,
      );
    }
  });

  it("should archive a topic", async () => {
    const topic = await service.createTopic("アーカイブ対象", "テスト", 50);
    await service.archiveTopic(topic.id);
    const all = await service.listTopics("archived");
    expect(all.some((t) => t.id === topic.id)).toBe(true);
  });
});
