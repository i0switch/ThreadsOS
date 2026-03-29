import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { logger } from "../../app/logger.js";
import { db } from "../../db/index.js";
import { topics } from "../../db/schema.js";
import type { Topic } from "../../domain/threads/index.js";

export interface TopicSelectionService {
  createTopic(
    name: string,
    niche: string,
    priorityScore?: number,
  ): Promise<Topic>;
  selectDailyTopics(count: number): Promise<Topic[]>;
  scoreTopic(topicId: string, score: number): Promise<void>;
  listTopics(status?: string): Promise<Topic[]>;
  archiveTopic(topicId: string): Promise<void>;
}

export class TopicSelectionServiceImpl implements TopicSelectionService {
  async createTopic(
    name: string,
    niche: string,
    priorityScore = 50,
  ): Promise<Topic> {
    const id = randomUUID();
    const now = new Date().toISOString();

    db.insert(topics)
      .values({
        id,
        name,
        niche,
        priorityScore,
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    logger.info({ id, name, niche }, "Topic created");

    return {
      id,
      name,
      niche,
      priorityScore,
      status: "active",
    };
  }

  async selectDailyTopics(count: number): Promise<Topic[]> {
    const rows = db
      .select()
      .from(topics)
      .where(eq(topics.status, "active"))
      .orderBy(desc(topics.priorityScore))
      .limit(count)
      .all();

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      niche: r.niche,
      priorityScore: r.priorityScore,
      status: r.status as Topic["status"],
    }));
  }

  async scoreTopic(topicId: string, score: number): Promise<void> {
    db.update(topics)
      .set({ priorityScore: score, updatedAt: new Date().toISOString() })
      .where(eq(topics.id, topicId))
      .run();
  }

  async listTopics(status?: string): Promise<Topic[]> {
    const query = status
      ? db.select().from(topics).where(eq(topics.status, status))
      : db.select().from(topics);

    return query.all().map((r) => ({
      id: r.id,
      name: r.name,
      niche: r.niche,
      priorityScore: r.priorityScore,
      status: r.status as Topic["status"],
    }));
  }

  async archiveTopic(topicId: string): Promise<void> {
    db.update(topics)
      .set({ status: "archived", updatedAt: new Date().toISOString() })
      .where(eq(topics.id, topicId))
      .run();
  }
}
