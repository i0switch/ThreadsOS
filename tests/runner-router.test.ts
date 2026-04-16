import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

vi.mock("../src/db/index.js", () => ({
  db: {},
}));

import { spawnSync } from "node:child_process";
import {
  CopilotCliRunner,
  createRunnerRouter,
} from "../src/adapters/llm/runner-router.js";

const spawnSyncMock = vi.mocked(spawnSync);

function createFakeRunner(
  name: "claude" | "codex" | "copilot",
  impl: () =>
    | Promise<{
        responseText: string;
        rawOutput: string;
        durationMs: number;
        model: string;
        estimatedTokens: number;
      }>
    | {
        responseText: string;
        rawOutput: string;
        durationMs: number;
        model: string;
        estimatedTokens: number;
      },
) {
  return {
    name,
    run: vi.fn(impl),
  };
}

describe("runner-router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.LLM_DEFAULT_TIER = "standard";
    process.env.LLM_COPILOT_MODEL_STANDARD = "gpt-5.4-copilot-test";
  });

  it("passes the configured model to the copilot script", async () => {
    spawnSyncMock.mockReturnValue({
      error: undefined,
      status: 0,
      stdout: "copilot response",
      stderr: "",
    } as never);

    const runner = new CopilotCliRunner();
    await runner.run({
      prompt: "Say hello",
      tier: "standard",
      taskType: "rewrite",
      role: "executive",
      confidenceRequired: "medium",
    });

    expect(spawnSyncMock).toHaveBeenCalledTimes(1);

    const [, args, options] = spawnSyncMock.mock.calls[0] as [
      string,
      string[],
      Record<string, unknown>,
    ];

    expect(args[0]).toMatch(/scripts[\\/]copilot-chat\.mjs$/);
    expect(args[2]).toBe("Say hello");
    expect(args.slice(-2)).toEqual(["--model", "gpt-5.4-copilot-test"]);
    expect(options).toMatchObject({
      encoding: "utf-8",
    });
  });

  it("falls back to the next runner when the primary runner fails", async () => {
    const healthStore = {
      canUse: vi.fn(() => true),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
    };
    const budgetGovernor = {
      canRun: vi.fn(() => true),
      recordUsage: vi.fn(),
    };
    const claude = createFakeRunner("claude", async () => {
      throw new Error("claude unavailable");
    });
    const codex = createFakeRunner("codex", async () => ({
      responseText: '{"winner":"codex"}',
      rawOutput: '{"winner":"codex"}',
      durationMs: 12,
      model: "codex-model",
      estimatedTokens: 4,
    }));

    const router = createRunnerRouter({
      runners: {
        claude,
        codex,
      },
      healthStore,
      budgetGovernor,
    });

    const result = await router.run({
      prompt: "Return JSON",
      tier: "standard",
      taskType: "failure_analysis",
      role: "executive",
      confidenceRequired: "medium",
      expectJson: true,
      preferredRunner: "claude",
      fallbackRunner: "codex",
    });

    expect(claude.run).toHaveBeenCalledTimes(1);
    expect(codex.run).toHaveBeenCalledTimes(1);
    expect(result.runnerMeta.runner).toBe("codex");
    expect(result.decision).toEqual({ winner: "codex" });
    expect(healthStore.recordFailure).toHaveBeenCalledWith(
      "claude",
      expect.objectContaining({
        kind: "process_error",
      }),
    );
    expect(healthStore.recordSuccess).toHaveBeenCalledWith(
      "codex",
      expect.objectContaining({
        model: "codex-model",
      }),
    );
  });

  it("retries once when a runner returns invalid JSON", async () => {
    let attempts = 0;
    const healthStore = {
      canUse: vi.fn(() => true),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
    };
    const budgetGovernor = {
      canRun: vi.fn(() => true),
      recordUsage: vi.fn(),
    };
    const claude = createFakeRunner("claude", async () => {
      attempts += 1;
      if (attempts === 1) {
        return {
          responseText: "not json",
          rawOutput: "not json",
          durationMs: 8,
          model: "claude-model",
          estimatedTokens: 2,
        };
      }

      return {
        responseText: '{"ok":true}',
        rawOutput: '{"ok":true}',
        durationMs: 9,
        model: "claude-model",
        estimatedTokens: 3,
      };
    });

    const router = createRunnerRouter({
      runners: {
        claude,
        codex: createFakeRunner("codex", async () => ({
          responseText: '{"unused":true}',
          rawOutput: '{"unused":true}',
          durationMs: 10,
          model: "codex-model",
          estimatedTokens: 2,
        })),
      },
      healthStore,
      budgetGovernor,
    });

    const result = await router.run({
      prompt: "Return JSON",
      tier: "standard",
      taskType: "rewrite",
      role: "executive",
      confidenceRequired: "medium",
      expectJson: true,
      preferredRunner: "claude",
      fallbackRunner: "codex",
    });

    expect(claude.run).toHaveBeenCalledTimes(2);
    expect(result.runnerMeta.runner).toBe("claude");
    expect(result.runnerMeta.retryCount).toBe(1);
    expect(result.decision).toEqual({ ok: true });
    expect(healthStore.recordSuccess).toHaveBeenCalledTimes(1);
    expect(healthStore.recordFailure).not.toHaveBeenCalled();
    expect(budgetGovernor.recordUsage).toHaveBeenCalledTimes(1);
  });

  it("skips a runner when circuit is open and falls through to the next", async () => {
    const healthStore = {
      canUse: vi.fn((name: "claude" | "codex" | "copilot") => name !== "claude"),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
    };
    const budgetGovernor = {
      canRun: vi.fn(() => true),
      recordUsage: vi.fn(),
    };
    const claude = createFakeRunner("claude", async () => {
      throw new Error("should not be called when circuit open");
    });
    const codex = createFakeRunner("codex", async () => ({
      responseText: '{"via":"codex"}',
      rawOutput: '{"via":"codex"}',
      durationMs: 5,
      model: "codex-model",
      estimatedTokens: 2,
    }));

    const router = createRunnerRouter({
      runners: { claude, codex },
      healthStore,
      budgetGovernor,
    });

    const result = await router.run({
      prompt: "p",
      tier: "standard",
      taskType: "rewrite",
      role: "executive",
      confidenceRequired: "medium",
      expectJson: true,
      preferredRunner: "claude",
      fallbackRunner: "codex",
    });

    expect(claude.run).not.toHaveBeenCalled();
    expect(codex.run).toHaveBeenCalledTimes(1);
    expect(result.runnerMeta.runner).toBe("codex");
    expect(healthStore.recordFailure).not.toHaveBeenCalled();
  });

  it("skips a runner when budget is exceeded and falls through", async () => {
    const healthStore = {
      canUse: vi.fn(() => true),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
    };
    const budgetGovernor = {
      canRun: vi.fn(
        (name: "claude" | "codex" | "copilot") => name !== "claude",
      ),
      recordUsage: vi.fn(),
    };
    const claude = createFakeRunner("claude", async () => {
      throw new Error("should not be called when budget exceeded");
    });
    const codex = createFakeRunner("codex", async () => ({
      responseText: '{"via":"codex"}',
      rawOutput: '{"via":"codex"}',
      durationMs: 5,
      model: "codex-model",
      estimatedTokens: 2,
    }));

    const router = createRunnerRouter({
      runners: { claude, codex },
      healthStore,
      budgetGovernor,
    });

    const result = await router.run({
      prompt: "p",
      tier: "standard",
      taskType: "rewrite",
      role: "executive",
      confidenceRequired: "medium",
      expectJson: true,
      preferredRunner: "claude",
      fallbackRunner: "codex",
    });

    expect(claude.run).not.toHaveBeenCalled();
    expect(codex.run).toHaveBeenCalledTimes(1);
    expect(result.runnerMeta.runner).toBe("codex");
  });

  it("records timeout failures with the correct kind", async () => {
    const healthStore = {
      canUse: vi.fn(() => true),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
    };
    const budgetGovernor = {
      canRun: vi.fn(() => true),
      recordUsage: vi.fn(),
    };
    const claude = createFakeRunner("claude", async () => {
      const err = new Error("spawn ETIMEDOUT");
      (err as Error & { name: string }).name = "Error";
      throw err;
    });
    const codex = createFakeRunner("codex", async () => ({
      responseText: '{"ok":true}',
      rawOutput: '{"ok":true}',
      durationMs: 3,
      model: "codex-model",
      estimatedTokens: 2,
    }));

    const router = createRunnerRouter({
      runners: { claude, codex },
      healthStore,
      budgetGovernor,
    });

    await router.run({
      prompt: "p",
      tier: "standard",
      taskType: "rewrite",
      role: "executive",
      confidenceRequired: "medium",
      expectJson: true,
      preferredRunner: "claude",
      fallbackRunner: "codex",
    });

    expect(healthStore.recordFailure).toHaveBeenCalledWith(
      "claude",
      expect.objectContaining({ kind: "process_error" }),
    );
  });
});
