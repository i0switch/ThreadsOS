import { isAbsolute, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadEnv, resolveDatabaseUrl } from "../src/config/env.js";

describe("loadEnv", () => {
  beforeEach(() => {
    // Reset relevant env vars
    delete process.env.PORT;
    delete process.env.NODE_ENV;
    delete process.env.DATABASE_URL;
    delete process.env.LLM_DEFAULT_TIER;
    delete process.env.LLM_DIRECT_MODEL_FAST;
    delete process.env.LLM_DIRECT_MODEL_STANDARD;
    delete process.env.LLM_DIRECT_MODEL_PREMIUM;
    delete process.env.LLM_HEARTBEAT_MODEL_FAST;
    delete process.env.LLM_HEARTBEAT_MODEL_STANDARD;
    delete process.env.LLM_HEARTBEAT_MODEL_PREMIUM;
    delete process.env.LLM_CODEX_MODEL_FAST;
    delete process.env.LLM_CODEX_MODEL_STANDARD;
    delete process.env.LLM_CODEX_MODEL_PREMIUM;
    delete process.env.LLM_COPILOT_MODEL_FAST;
    delete process.env.LLM_COPILOT_MODEL_STANDARD;
    delete process.env.LLM_COPILOT_MODEL_PREMIUM;
    delete process.env.LLM_RUNNER_TIMEOUT_MS;
    delete process.env.LLM_RUNNER_DAILY_TOKENS_LIMIT;
    delete process.env.LLM_RUNNER_DAILY_CALLS_LIMIT;
    delete process.env.LLM_RUNNER_CIRCUIT_FAILURE_THRESHOLD;
    delete process.env.THREADS_ACCESS_TOKEN;
    delete process.env.THREADS_USER_ID;
    delete process.env.DASHBOARD_AUTH_TOKEN;
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
    expect(env.LLM_DEFAULT_TIER).toBe("standard");
    expect(env.LLM_DIRECT_MODEL_STANDARD).toBe("claude-sonnet-4-20250514");
    expect(env.LLM_HEARTBEAT_MODEL_STANDARD).toBe("sonnet");
    expect(env.LLM_CODEX_MODEL_STANDARD).toBe("gpt-5.4");
    expect(env.LLM_COPILOT_MODEL_STANDARD).toBe("gpt-5.4");
    expect(env.LLM_RUNNER_TIMEOUT_MS).toBe(8 * 60 * 1000);
    expect(env.LLM_RUNNER_DAILY_TOKENS_LIMIT).toBe(200000);
    expect(env.LLM_RUNNER_DAILY_CALLS_LIMIT).toBe(200);
    expect(env.LLM_RUNNER_CIRCUIT_FAILURE_THRESHOLD).toBe(3);
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

  it("should accept tier and tier-specific model overrides", () => {
    process.env.LLM_DEFAULT_TIER = "premium";
    process.env.LLM_DIRECT_MODEL_PREMIUM = "custom-direct-premium";
    process.env.LLM_HEARTBEAT_MODEL_PREMIUM = "custom-heartbeat-premium";
    process.env.LLM_CODEX_MODEL_PREMIUM = "custom-codex-premium";
    process.env.LLM_COPILOT_MODEL_PREMIUM = "custom-copilot-premium";
    process.env.LLM_RUNNER_TIMEOUT_MS = "12345";

    const env = loadEnv();

    expect(env.LLM_DEFAULT_TIER).toBe("premium");
    expect(env.LLM_DIRECT_MODEL_PREMIUM).toBe("custom-direct-premium");
    expect(env.LLM_HEARTBEAT_MODEL_PREMIUM).toBe("custom-heartbeat-premium");
    expect(env.LLM_CODEX_MODEL_PREMIUM).toBe("custom-codex-premium");
    expect(env.LLM_COPILOT_MODEL_PREMIUM).toBe("custom-copilot-premium");
    expect(env.LLM_RUNNER_TIMEOUT_MS).toBe(12345);
  });

  it("should accept valid NODE_ENV values", () => {
    process.env.NODE_ENV = "production";
    process.env.THREADS_ACCESS_TOKEN = "test-token";
    process.env.THREADS_USER_ID = "test-user";
    const env = loadEnv();
    expect(env.NODE_ENV).toBe("production");
  });

  it("should reject invalid NODE_ENV values", () => {
    process.env.NODE_ENV = "invalid";
    expect(() => loadEnv()).toThrow();
  });
});
