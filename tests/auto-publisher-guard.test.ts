import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../src/db/schema.js";

vi.mock("../src/db/index.js", () => {
  const sqlite = new Database(":memory:");
  const mockDb = drizzle(sqlite, { schema });
  return { db: mockDb };
});

import { ensureAutonomyTables } from "../src/db/bootstrap.js";
import type { NoteApiClient } from "../src/adapters/note-api/index.js";
import type { ThreadsApiClient } from "../src/adapters/threads-api/index.js";
import { AutoPublisherServiceImpl } from "../src/services/auto-publisher/index.js";

describe("auto-publisher operations-mode guard", () => {
  beforeEach(() => {
    ensureAutonomyTables();
  });

  it("blocks Threads publication when channel is not writable", async () => {
    const operationsMode = {
      isChannelWritable: vi.fn((channel: "threads" | "note") =>
        channel === "note",
      ),
    };
    const publisher = new AutoPublisherServiceImpl({
      dryRun: true,
      operationsMode,
    });
    const mockApi = {} as ThreadsApiClient;

    const result = await publisher.publishApprovedThreadDrafts(mockApi);

    expect(result).toEqual([]);
    expect(operationsMode.isChannelWritable).toHaveBeenCalledWith("threads");
  });

  it("blocks note publication when channel is not writable", async () => {
    const operationsMode = {
      isChannelWritable: vi.fn((channel: "threads" | "note") =>
        channel === "threads",
      ),
    };
    const publisher = new AutoPublisherServiceImpl({
      dryRun: true,
      operationsMode,
    });
    const mockNoteApi = {} as NoteApiClient;

    const result = await publisher.publishApprovedNoteDrafts(mockNoteApi);

    expect(result).toEqual([]);
    expect(operationsMode.isChannelWritable).toHaveBeenCalledWith("note");
  });

  it("blocks reply send when threads channel is not writable", async () => {
    const operationsMode = {
      isChannelWritable: vi.fn(() => false),
    };
    const publisher = new AutoPublisherServiceImpl({
      dryRun: true,
      operationsMode,
    });
    const mockApi = {} as ThreadsApiClient;

    const count = await publisher.sendSafeReplies(mockApi);

    expect(count).toBe(0);
  });

  it("allows publication when no guard is configured (backward compatible)", async () => {
    const publisher = new AutoPublisherServiceImpl({ dryRun: true });
    const mockApi = {} as ThreadsApiClient;

    // With dryRun + no eligible slots the result is empty but not blocked
    const result = await publisher.publishApprovedThreadDrafts(mockApi);
    expect(Array.isArray(result)).toBe(true);
  });
});
