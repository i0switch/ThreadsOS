import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => {
  const selectGetMock = vi.fn();
  const insertRunMock = vi.fn(() => ({ changes: 1 }));
  const updateRunMock = vi.fn(() => ({ changes: 1 }));
  const selectBuilder = {
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        get: selectGetMock,
      })),
    })),
  };
  const insertBuilder = {
    values: vi.fn(() => ({
      onConflictDoUpdate: vi.fn(() => ({
        run: insertRunMock,
      })),
    })),
  };
  const updateBuilder = {
    set: vi.fn(() => ({
      where: vi.fn(() => ({
        run: updateRunMock,
      })),
    })),
  };

  return {
    selectGetMock,
    insertRunMock,
    updateRunMock,
    dbMock: {
      select: vi.fn(() => selectBuilder),
      insert: vi.fn(() => insertBuilder),
      update: vi.fn(() => updateBuilder),
    },
  };
});

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

vi.mock("../src/db/index.js", () => ({
  db: dbMocks.dbMock,
}));

import { spawnSync } from "node:child_process";
import {
  ClaudeCodeRunner,
  CodexCliRunner,
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

function createHealthyStore(
  overrides: Partial<{
    canUse: (name: "claude" | "codex" | "copilot") => boolean;
    tryAcquireCooldownProbe: (name: "claude" | "codex" | "copilot") => boolean;
  }> = {},
) {
  return {
    canUse: vi.fn(overrides.canUse ?? (() => true)),
    tryAcquireCooldownProbe: vi.fn(
      overrides.tryAcquireCooldownProbe ?? (() => true),
    ),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
  };
}

function staleTrip() {
  return {
    runner: "codex",
    status: "tripped",
    consecutiveFailures: 3,
    timeoutCount: 0,
    invalidJsonCount: 0,
    totalCalls: 5,
    lastError: null,
    lastFailureAt: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
  };
}

describe("runner-router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.selectGetMock.mockReset();
    dbMocks.insertRunMock.mockReset();
    dbMocks.updateRunMock.mockReset();
    process.env.LLM_DEFAULT_TIER = "standard";
    process.env.LLM_COPILOT_MODEL_STANDARD = "gpt-5.4-copilot-test";
  });

  it("passes the configured model and prompt via stdin to the copilot script", async () => {
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

    const [, args, options] = spawnSyncMock.mock.calls[0] as [
      string,
      string[],
      Record<string, unknown>,
    ];

    expect(args[0]).toMatch(/scripts[\\/]copilot-chat\.mjs$/);
    expect(args[2]).toBe("--stdin-prompt");
    expect(args.slice(-2)).toEqual(["--model", "gpt-5.4-copilot-test"]);
    expect(options).toMatchObject({
      encoding: "utf-8",
      input: "Say hello",
    });
  });

  it("does not put long prompts into the copilot argv list", async () => {
    spawnSyncMock.mockReturnValue({
      error: undefined,
      status: 0,
      stdout: "copilot response",
      stderr: "",
    } as never);

    const prompt = "A".repeat(20_000);
    const runner = new CopilotCliRunner();
    await runner.run({
      prompt,
      tier: "standard",
      taskType: "rewrite",
      role: "executive",
      confidenceRequired: "medium",
    });

    const [, args, options] = spawnSyncMock.mock.calls[0] as [
      string,
      string[],
      Record<string, unknown>,
    ];

    expect(args).not.toContain(prompt);
    expect(options).toMatchObject({ input: prompt });
  });

  it("passes Codex prompts via stdin instead of argv on Windows", async () => {
    spawnSyncMock.mockReturnValue({
      error: undefined,
      status: 0,
      stdout: '{"ok":true}',
      stderr: "",
    } as never);

    const runner = new CodexCliRunner();
    await runner.run({
      prompt: 'Return exactly {"ok":true}',
      tier: "standard",
      taskType: "rewrite",
      role: "executive",
      confidenceRequired: "medium",
    });

    const [, args, options] = spawnSyncMock.mock.calls[0] as [
      string,
      string[],
      Record<string, unknown>,
    ];

    expect(args).not.toContain('Return exactly {"ok":true}');
    expect(options).toMatchObject({
      input: 'Return exactly {"ok":true}',
    });
  });

  it("surfaces Claude CLI result errors instead of falling back to raw stdout", async () => {
    spawnSyncMock.mockReturnValue({
      error: undefined,
      status: 0,
      stdout: JSON.stringify([
        {
          type: "result",
          is_error: true,
          result:
            'API Error: 400 {"error":{"message":"Bad Request\\n","type":"error"}}',
        },
      ]),
      stderr: "",
    } as never);

    const runner = new ClaudeCodeRunner();

    await expect(
      runner.run({
        prompt: "Return JSON",
        tier: "standard",
        taskType: "rewrite",
        role: "executive",
        confidenceRequired: "medium",
      }),
    ).rejects.toThrow(/Claude CLI 結果エラー: API Error: 400/);
  });

  it("still falls back when Claude stdout is non-JSON text", async () => {
    spawnSyncMock.mockReturnValue({
      error: undefined,
      status: 0,
      stdout: "plain text response",
      stderr: "",
    } as never);

    const runner = new ClaudeCodeRunner();
    const result = await runner.run({
      prompt: "Return plain text",
      tier: "standard",
      taskType: "rewrite",
      role: "executive",
      confidenceRequired: "medium",
    });

    expect(result.responseText).toBe("plain text response");
    expect(result.rawOutput).toBe("plain text response");
  });

  it("falls back to the next runner when the primary runner fails", async () => {
    const healthStore = createHealthyStore();
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
      runners: { claude, codex },
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
      expect.objectContaining({ kind: "process_error" }),
    );
    expect(healthStore.recordSuccess).toHaveBeenCalledWith(
      "codex",
      expect.objectContaining({ model: "codex-model" }),
    );
  });

  it("retries once when a runner returns invalid JSON", async () => {
    let attempts = 0;
    const healthStore = createHealthyStore();
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
      runners: { claude },
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
    const healthStore = createHealthyStore({
      canUse: (name) => name !== "claude",
    });
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

  it("retries a stale tripped runner after cooldown", async () => {
    dbMocks.selectGetMock
      .mockReturnValueOnce(staleTrip())
      .mockReturnValueOnce(staleTrip())
      .mockReturnValueOnce(undefined);
    dbMocks.updateRunMock.mockReturnValueOnce({ changes: 1 });

    const budgetGovernor = {
      canRun: vi.fn(() => true),
      recordUsage: vi.fn(),
    };
    const codex = createFakeRunner("codex", async () => ({
      responseText: '{"ok":true}',
      rawOutput: '{"ok":true}',
      durationMs: 4,
      model: "codex-model",
      estimatedTokens: 2,
    }));

    const router = createRunnerRouter({
      runners: { codex },
      budgetGovernor,
    });

    const result = await router.run({
      prompt: "p",
      tier: "standard",
      taskType: "failure_analysis",
      role: "executive",
      confidenceRequired: "medium",
      expectJson: true,
      preferredRunner: "codex",
      fallbackRunner: "claude",
    });

    expect(codex.run).toHaveBeenCalledTimes(1);
    expect(result.runnerMeta.runner).toBe("codex");
    expect(dbMocks.updateRunMock).toHaveBeenCalledTimes(1);
    expect(dbMocks.insertRunMock).toHaveBeenCalled();
  });

  it("skips a cooldown-locked runner and falls back", async () => {
    const lockedTrip = {
      ...staleTrip(),
      lastError: `__cooldown_probe_pending__:${Date.now()}`,
    };
    dbMocks.selectGetMock
      .mockReturnValueOnce(lockedTrip)
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(undefined);

    const budgetGovernor = {
      canRun: vi.fn(() => true),
      recordUsage: vi.fn(),
    };
    const codex = createFakeRunner("codex", async () => ({
      responseText: '{"ok":true}',
      rawOutput: '{"ok":true}',
      durationMs: 4,
      model: "codex-model",
      estimatedTokens: 2,
    }));
    const claude = createFakeRunner("claude", async () => ({
      responseText: '{"fallback":"claude"}',
      rawOutput: '{"fallback":"claude"}',
      durationMs: 4,
      model: "claude-model",
      estimatedTokens: 2,
    }));

    const router = createRunnerRouter({
      runners: { codex, claude },
      budgetGovernor,
    });

    const result = await router.run({
      prompt: "p",
      tier: "standard",
      taskType: "failure_analysis",
      role: "executive",
      confidenceRequired: "medium",
      expectJson: true,
      preferredRunner: "codex",
      fallbackRunner: "claude",
    });

    expect(result.runnerMeta.runner).toBe("claude");
    expect(codex.run).not.toHaveBeenCalled();
  });

  it("re-acquires a cooldown probe after the old lock expires", async () => {
    const expiredLockTrip = {
      ...staleTrip(),
      lastError: `__cooldown_probe_pending__:${Date.now() - 31 * 60 * 1000}`,
    };
    dbMocks.selectGetMock
      .mockReturnValueOnce(expiredLockTrip)
      .mockReturnValueOnce(expiredLockTrip)
      .mockReturnValueOnce(undefined);
    dbMocks.updateRunMock
      .mockReturnValueOnce({ changes: 1 })
      .mockReturnValueOnce({ changes: 1 });

    const budgetGovernor = {
      canRun: vi.fn(() => true),
      recordUsage: vi.fn(),
    };
    const codex = createFakeRunner("codex", async () => ({
      responseText: '{"ok":true}',
      rawOutput: '{"ok":true}',
      durationMs: 4,
      model: "codex-model",
      estimatedTokens: 2,
    }));

    const router = createRunnerRouter({
      runners: { codex },
      budgetGovernor,
    });

    const result = await router.run({
      prompt: "p",
      tier: "standard",
      taskType: "failure_analysis",
      role: "executive",
      confidenceRequired: "medium",
      expectJson: true,
      preferredRunner: "codex",
      fallbackRunner: "claude",
    });

    expect(result.runnerMeta.runner).toBe("codex");
    expect(codex.run).toHaveBeenCalledTimes(1);
    expect(dbMocks.updateRunMock).toHaveBeenCalledTimes(2);
  });

  it("keeps copilot as tertiary fallback by default", async () => {
    const healthStore = createHealthyStore();
    const budgetGovernor = {
      canRun: vi.fn(() => true),
      recordUsage: vi.fn(),
    };
    const claude = createFakeRunner("claude", async () => {
      throw new Error("claude unavailable");
    });
    const codex = createFakeRunner("codex", async () => {
      throw new Error("codex unavailable");
    });
    const copilot = createFakeRunner("copilot", async () => ({
      responseText: '{"via":"copilot"}',
      rawOutput: '{"via":"copilot"}',
      durationMs: 5,
      model: "copilot-model",
      estimatedTokens: 2,
    }));

    const router = createRunnerRouter({
      runners: { claude, codex, copilot },
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
    });

    expect(result.runnerMeta.runner).toBe("copilot");
    expect(copilot.run).toHaveBeenCalledTimes(1);
  });

  it("does not consume the cooldown probe lock when budget rejects the runner", async () => {
    dbMocks.selectGetMock
      .mockReturnValueOnce(staleTrip())
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(undefined);

    const budgetGovernor = {
      canRun: vi.fn((name: "claude" | "codex" | "copilot") => name !== "codex"),
      recordUsage: vi.fn(),
    };
    const claude = createFakeRunner("claude", async () => ({
      responseText: '{"via":"claude"}',
      rawOutput: '{"via":"claude"}',
      durationMs: 5,
      model: "claude-model",
      estimatedTokens: 2,
    }));

    const router = createRunnerRouter({
      runners: { claude },
      budgetGovernor,
    });

    const result = await router.run({
      prompt: "p",
      tier: "standard",
      taskType: "failure_analysis",
      role: "executive",
      confidenceRequired: "medium",
      expectJson: true,
      preferredRunner: "codex",
      fallbackRunner: "claude",
    });

    expect(result.runnerMeta.runner).toBe("claude");
    expect(dbMocks.updateRunMock).not.toHaveBeenCalled();
  });

  it("skips a runner when budget is exceeded and falls through", async () => {
    const healthStore = createHealthyStore();
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
    const healthStore = createHealthyStore();
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
