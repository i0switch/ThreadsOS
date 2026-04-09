import { isAbsolute, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadEnv, resolveDatabaseUrl } from "../src/config/env.js";

describe("loadEnv", () => {
  beforeEach(() => {
    // Reset relevant env vars
    delete process.env.PORT;
    delete process.env.NODE_ENV;
    delete process.env.DATABASE_URL;
  });

  it("should return default values when no env vars set", () => {
    const env = loadEnv();
    expect(env.NODE_ENV).toBe("development");
    expect(env.PORT).toBe(3000);
    expect(env.DATABASE_URL).toBe(
      resolveDatabaseUrl("data/threads-note-os.db"),
    );
    expect(isAbsolute(env.DATABASE_URL)).toBe(true);
    expect(env.NOTE_MODE).toBe("browser_assisted");
  });

  it("should keep in-memory database urls unchanged", () => {
    process.env.DATABASE_URL = ":memory:";
    const env = loadEnv();
    expect(env.DATABASE_URL).toBe(":memory:");
  });

  it("should resolve relative database urls from the project root", () => {
    process.env.DATABASE_URL = "tmp/custom.db";
    const env = loadEnv();
    expect(env.DATABASE_URL).toBe(resolveDatabaseUrl("tmp/custom.db"));
    expect(isAbsolute(env.DATABASE_URL)).toBe(true);
  });

  it("should keep absolute database urls unchanged", () => {
    const absolutePath = resolve("tmp/absolute.db");
    process.env.DATABASE_URL = absolutePath;
    const env = loadEnv();
    expect(env.DATABASE_URL).toBe(absolutePath);
  });

  it("should parse PORT as number", () => {
    process.env.PORT = "4000";
    const env = loadEnv();
    expect(env.PORT).toBe(4000);
  });

  it("should accept valid NODE_ENV values", () => {
    process.env.NODE_ENV = "production";
    const env = loadEnv();
    expect(env.NODE_ENV).toBe("production");
  });

  it("should reject invalid NODE_ENV values", () => {
    process.env.NODE_ENV = "invalid";
    expect(() => loadEnv()).toThrow();
  });
});
