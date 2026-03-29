import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FileSystemStorageClient } from "../src/adapters/storage/index.js";

const TEST_DIR = join(process.cwd(), "data", "test-storage");

describe("FileSystemStorageClient", () => {
  const storage = new FileSystemStorageClient();

  afterAll(() => {
    try {
      rmSync(TEST_DIR, { recursive: true });
    } catch {}
  });

  it("should save and read a file", async () => {
    const path = "data/test-storage/test-file.txt";
    await storage.saveFile(path, "hello world");
    const content = await storage.readFile(path);
    expect(content).toBe("hello world");
  });

  it("should list files in a directory", async () => {
    await storage.saveFile("data/test-storage/a.txt", "a");
    await storage.saveFile("data/test-storage/b.txt", "b");
    const files = await storage.listFiles("data/test-storage");
    expect(files.length).toBeGreaterThanOrEqual(2);
  });

  it("should check if file exists", async () => {
    expect(await storage.exists("data/test-storage/a.txt")).toBe(true);
    expect(await storage.exists("data/test-storage/nonexistent.txt")).toBe(
      false,
    );
  });
});
