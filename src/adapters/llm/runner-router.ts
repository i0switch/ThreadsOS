import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { logger } from "../../app/logger.js";
import { loadEnv } from "../../config/env.js";
import { db } from "../../db/index.js";
import { runnerBudgets, runnerHealth } from "../../db/schema.js";
import { parseJsonArray, parseJsonObject } from "../../utils/llm-json.js";
import type { LlmTier } from "./index.js";

export type RunnerName = "claude" | "codex" | "copilot";
export type RunnerRole =
  | "executive"
  | "research"
  | "competitor"
  | "threads"
  | "note"
  | "auditor";
export type RunnerTaskType =
  | "funnel_advice"
  | "threads_generation"
  | "note_generation"
  | "reply_generation"
  | "audit"
  | "strategy_review"
  | "failure_analysis"
  | "rewrite";
export type RunnerConfidence = "low" | "medium" | "high";
type RunnerErrorKind =
  | "timeout"
  | "invalid_json"
  | "process_error"
  | "budget_exceeded"
  | "circuit_open";

export interface RunnerTask {
  prompt: string;
  systemPrompt?: string;
  tier: LlmTier;
  taskType: RunnerTaskType;
  role: RunnerRole;
  confidenceRequired: RunnerConfidence;
  jsonSchema?: Record<string, unknown>;
  maxTokens?: number;
  temperature?: number;
  label?: string;
  expectJson?: boolean;
  preferredRunner?: RunnerName;
  fallbackRunner?: RunnerName;
}

export interface RunnerResult {
  decision: Record<string, unknown>;
  confidence: number;
  reasons: string[];
  artifacts: {
    responseText: string;
    rawOutput: string;
  };
  nextActions: string[];
  runnerMeta: {
    runner: RunnerName;
    durationMs: number;
    retryCount: number;
    model: string;
    estimatedTokens: number;
  };
}

interface RawRunnerOutput {
  responseText: string;
  rawOutput: string;
  durationMs: number;
  model: string;
  estimatedTokens: number;
}

export interface LlmRunner {
  readonly name: RunnerName;
  run(task: RunnerTask): Promise<RawRunnerOutput>;
}

export interface RunnerHealthStore {
  canUse(runner: RunnerName): boolean;
  recordSuccess(
    runner: RunnerName,
    details: { durationMs: number; model: string },
  ): void;
  recordFailure(
    runner: RunnerName,
    details: { kind: RunnerErrorKind; message: string; model?: string },
  ): void;
}

export interface RunnerBudgetGovernor {
  canRun(runner: RunnerName, task: RunnerTask): boolean;
  recordUsage(runner: RunnerName, estimatedTokens: number): void;
}

class RoutedRunnerError extends Error {
  constructor(
    readonly runner: RunnerName,
    readonly kind: RunnerErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "RoutedRunnerError";
  }
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function inferCircuitStatus(
  samples: {
    consecutiveFailures: number;
    timeoutCount: number;
    invalidJsonCount: number;
    totalCalls: number;
  },
): "healthy" | "degraded" | "tripped" {
  const env = loadEnv();
  if (samples.consecutiveFailures >= env.LLM_RUNNER_CIRCUIT_FAILURE_THRESHOLD) {
    return "tripped";
  }
  if (samples.totalCalls >= env.LLM_RUNNER_CIRCUIT_MIN_SAMPLES) {
    const timeoutRate = samples.timeoutCount / samples.totalCalls;
    const invalidJsonRate = samples.invalidJsonCount / samples.totalCalls;
    if (
      timeoutRate >= env.LLM_RUNNER_CIRCUIT_TIMEOUT_RATE ||
      invalidJsonRate >= env.LLM_RUNNER_CIRCUIT_INVALID_JSON_RATE
    ) {
      return "tripped";
    }
  }
  return samples.consecutiveFailures > 0 ? "degraded" : "healthy";
}

class DbRunnerHealthStore implements RunnerHealthStore {
  canUse(runner: RunnerName): boolean {
    const state = db
      .select()
      .from(runnerHealth)
      .where(eq(runnerHealth.runner, runner))
      .get();
    return state?.status !== "tripped";
  }

  recordSuccess(
    runner: RunnerName,
    details: { durationMs: number; model: string },
  ): void {
    const now = new Date().toISOString();
    const existing = db
      .select()
      .from(runnerHealth)
      .where(eq(runnerHealth.runner, runner))
      .get();

    db.insert(runnerHealth)
      .values({
        runner,
        status: "healthy",
        consecutiveFailures: 0,
        timeoutCount: existing?.timeoutCount ?? 0,
        invalidJsonCount: existing?.invalidJsonCount ?? 0,
        totalCalls: (existing?.totalCalls ?? 0) + 1,
        lastModel: details.model,
        lastError: null,
        lastDurationMs: details.durationMs,
        lastSuccessAt: now,
        lastFailureAt: existing?.lastFailureAt ?? null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: runnerHealth.runner,
        set: {
          status: "healthy",
          consecutiveFailures: 0,
          totalCalls: (existing?.totalCalls ?? 0) + 1,
          lastModel: details.model,
          lastError: null,
          lastDurationMs: details.durationMs,
          lastSuccessAt: now,
          updatedAt: now,
        },
      })
      .run();
  }

  recordFailure(
    runner: RunnerName,
    details: { kind: RunnerErrorKind; message: string; model?: string },
  ): void {
    const now = new Date().toISOString();
    const existing = db
      .select()
      .from(runnerHealth)
      .where(eq(runnerHealth.runner, runner))
      .get();
    const consecutiveFailures = (existing?.consecutiveFailures ?? 0) + 1;
    const nextTimeoutCount =
      (existing?.timeoutCount ?? 0) + (details.kind === "timeout" ? 1 : 0);
    const nextInvalidJsonCount =
      (existing?.invalidJsonCount ?? 0) +
      (details.kind === "invalid_json" ? 1 : 0);
    const nextTotalCalls = (existing?.totalCalls ?? 0) + 1;
    const status = inferCircuitStatus({
      consecutiveFailures,
      timeoutCount: nextTimeoutCount,
      invalidJsonCount: nextInvalidJsonCount,
      totalCalls: nextTotalCalls,
    });

    db.insert(runnerHealth)
      .values({
        runner,
        status,
        consecutiveFailures,
        timeoutCount: nextTimeoutCount,
        invalidJsonCount: nextInvalidJsonCount,
        totalCalls: nextTotalCalls,
        lastModel: details.model ?? existing?.lastModel ?? null,
        lastError: details.message,
        lastDurationMs: existing?.lastDurationMs ?? null,
        lastSuccessAt: existing?.lastSuccessAt ?? null,
        lastFailureAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: runnerHealth.runner,
        set: {
          status,
          consecutiveFailures,
          timeoutCount: nextTimeoutCount,
          invalidJsonCount: nextInvalidJsonCount,
          totalCalls: nextTotalCalls,
          lastModel: details.model ?? existing?.lastModel ?? null,
          lastError: details.message,
          lastFailureAt: now,
          updatedAt: now,
        },
      })
      .run();
  }
}

type BudgetScope = "daily" | "hourly" | "5h" | "emergency";

function computeBudgetPeriodKey(scope: BudgetScope, now: Date): string {
  const iso = now.toISOString();
  switch (scope) {
    case "daily":
      return iso.slice(0, 10);
    case "hourly":
      return iso.slice(0, 13);
    case "5h": {
      const bucket = Math.floor(now.getUTCHours() / 5) * 5;
      return `${iso.slice(0, 10)}T${String(bucket).padStart(2, "0")}-5h`;
    }
    case "emergency":
      return iso.slice(0, 7);
  }
}

function resolveBudgetLimits(
  scope: BudgetScope,
  env: ReturnType<typeof loadEnv>,
): { tokensLimit: number; callsLimit: number } {
  switch (scope) {
    case "daily":
      return {
        tokensLimit: env.LLM_RUNNER_DAILY_TOKENS_LIMIT,
        callsLimit: env.LLM_RUNNER_DAILY_CALLS_LIMIT,
      };
    case "hourly":
      return {
        tokensLimit: env.LLM_RUNNER_HOURLY_TOKENS_LIMIT,
        callsLimit: env.LLM_RUNNER_HOURLY_CALLS_LIMIT,
      };
    case "5h":
      return {
        tokensLimit: env.LLM_RUNNER_5H_TOKENS_LIMIT,
        callsLimit: env.LLM_RUNNER_5H_CALLS_LIMIT,
      };
    case "emergency":
      return {
        tokensLimit: env.LLM_RUNNER_EMERGENCY_TOKENS_LIMIT,
        callsLimit: env.LLM_RUNNER_EMERGENCY_CALLS_LIMIT,
      };
  }
}

const BUDGET_SCOPES: BudgetScope[] = ["daily", "hourly", "5h", "emergency"];

class DbRunnerBudgetGovernor implements RunnerBudgetGovernor {
  private ensureBudgetRow(runner: RunnerName, scope: BudgetScope) {
    const env = loadEnv();
    const now = new Date();
    const periodKey = computeBudgetPeriodKey(scope, now);
    const nowIso = now.toISOString();
    const limits = resolveBudgetLimits(scope, env);
    db.insert(runnerBudgets)
      .values({
        id: randomUUID(),
        runner,
        periodKey,
        tokensUsed: 0,
        callsUsed: 0,
        tokensLimit: limits.tokensLimit,
        callsLimit: limits.callsLimit,
        createdAt: nowIso,
        updatedAt: nowIso,
      })
      .onConflictDoNothing()
      .run();

    return db
      .select()
      .from(runnerBudgets)
      .where(
        and(
          eq(runnerBudgets.runner, runner),
          eq(runnerBudgets.periodKey, periodKey),
        ),
      )
      .get();
  }

  private ensureAllScopes(runner: RunnerName) {
    return BUDGET_SCOPES.map((scope) => ({
      scope,
      row: this.ensureBudgetRow(runner, scope),
    }));
  }

  canRun(runner: RunnerName, task: RunnerTask): boolean {
    const budgets = this.ensureAllScopes(runner);
    const promptTokens = estimateTokens(task.prompt);
    for (const { row } of budgets) {
      if (!row) {
        return false;
      }
      if (row.tokensUsed + promptTokens > row.tokensLimit) {
        return false;
      }
      if (row.callsUsed + 1 > row.callsLimit) {
        return false;
      }
    }
    return true;
  }

  recordUsage(runner: RunnerName, estimatedTokens: number): void {
    const budgets = this.ensureAllScopes(runner);
    const nowIso = new Date().toISOString();
    for (const { row } of budgets) {
      if (!row) {
        continue;
      }
      db.update(runnerBudgets)
        .set({
          tokensUsed: row.tokensUsed + estimatedTokens,
          callsUsed: row.callsUsed + 1,
          updatedAt: nowIso,
        })
        .where(eq(runnerBudgets.id, row.id))
        .run();
    }
  }
}

export function buildClaudeSystemPrompt(
  systemPrompt?: string,
  options: Pick<RunnerTask, "maxTokens" | "temperature"> = {},
): string | undefined {
  const constraints: string[] = [];
  const maxTokens = options.maxTokens;

  if (Number.isFinite(maxTokens) && (maxTokens ?? 0) > 0) {
    constraints.push(
      `Keep the response within approximately ${Math.floor(maxTokens ?? 0)} tokens.`,
    );
  }

  if (typeof options.temperature === "number") {
    if (options.temperature <= 0.3) {
      constraints.push(
        "Be deterministic, concise, and avoid unnecessary variation.",
      );
    } else if (options.temperature >= 0.85) {
      constraints.push(
        "You may explore multiple phrasings, but stay precise and follow the requested format.",
      );
    }
  }

  const merged = [
    systemPrompt?.trim(),
    constraints.length > 0
      ? `Additional generation constraints:\n${constraints.map((item) => `- ${item}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n")
    .trim();

  return merged || undefined;
}

export function resolveClaudeCliModel(tier?: LlmTier): string {
  const env = loadEnv();
  const resolvedTier = tier ?? env.LLM_DEFAULT_TIER;
  switch (resolvedTier) {
    case "fast":
      return env.LLM_HEARTBEAT_MODEL_FAST;
    case "premium":
      return env.LLM_HEARTBEAT_MODEL_PREMIUM;
    default:
      return env.LLM_HEARTBEAT_MODEL_STANDARD;
  }
}

export function buildClaudeCliArgs(
  systemPrompt?: string,
  options: { tier?: LlmTier } = {},
): string[] {
  const args = [
    "--print",
    "--output-format",
    "json",
    "--model",
    resolveClaudeCliModel(options.tier),
  ];
  if (systemPrompt) {
    args.push("--system-prompt", systemPrompt);
  }
  return args;
}

function resolveCodexModel(tier?: LlmTier): string {
  const env = loadEnv();
  switch (tier ?? env.LLM_DEFAULT_TIER) {
    case "fast":
      return env.LLM_CODEX_MODEL_FAST;
    case "premium":
      return env.LLM_CODEX_MODEL_PREMIUM;
    default:
      return env.LLM_CODEX_MODEL_STANDARD;
  }
}

function resolveCopilotModel(tier?: LlmTier): string {
  const env = loadEnv();
  switch (tier ?? env.LLM_DEFAULT_TIER) {
    case "fast":
      return env.LLM_COPILOT_MODEL_FAST;
    case "premium":
      return env.LLM_COPILOT_MODEL_PREMIUM;
    default:
      return env.LLM_COPILOT_MODEL_STANDARD;
  }
}

function buildPromptEnvelope(task: RunnerTask): string {
  const sections = [
    task.systemPrompt?.trim()
      ? `System instructions:\n${task.systemPrompt.trim()}`
      : "",
    task.expectJson && task.jsonSchema
      ? `Return JSON matching this schema summary:\n${JSON.stringify(task.jsonSchema, null, 2)}`
      : "",
    task.prompt,
  ].filter(Boolean);

  return sections.join("\n\n").trim();
}

function parseClaudeJsonOutput(stdout: string): {
  responseText: string;
  estimatedTokens: number;
} {
  const parsed = JSON.parse(stdout) as unknown;
  const entries: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const resultEntry = entries.find(
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as { type?: string }).type === "result",
  );

  if (resultEntry) {
    if (resultEntry.is_error) {
      throw new Error(
        `Claude CLI 結果エラー: ${String(resultEntry.result ?? "unknown")}`,
      );
    }
    const responseText =
      typeof resultEntry.result === "string" ? resultEntry.result : "";
    const usage = resultEntry.usage as
      | {
          input_tokens?: number;
          output_tokens?: number;
        }
      | undefined;
    return {
      responseText,
      estimatedTokens:
        (usage?.input_tokens ?? 0) +
        (usage?.output_tokens ?? 0) +
        estimateTokens(responseText),
    };
  }

  return {
    responseText: stdout.trim(),
    estimatedTokens: estimateTokens(stdout),
  };
}

export class ClaudeCodeRunner implements LlmRunner {
  readonly name = "claude" as const;

  async run(task: RunnerTask): Promise<RawRunnerOutput> {
    const timeoutMs = loadEnv().LLM_RUNNER_TIMEOUT_MS;
    const mergedSystemPrompt = buildClaudeSystemPrompt(task.systemPrompt, task);
    const args = buildClaudeCliArgs(mergedSystemPrompt, task);
    const start = Date.now();
    const result = spawnSync("claude", args, {
      input: task.prompt,
      encoding: "utf-8",
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, THREADOS_INTERNAL: "1" },
    });

    if (result.error) {
      const kind = result.error.message.includes("ETIMEDOUT")
        ? "timeout"
        : "process_error";
      throw new RoutedRunnerError(
        this.name,
        kind,
        `Claude CLI 起動失敗: ${result.error.message}`,
      );
    }

    const stdout = (result.stdout ?? "").trim();
    if (result.status !== 0 && !stdout) {
      throw new RoutedRunnerError(
        this.name,
        "process_error",
        `Claude CLI エラー (${result.status}): ${result.stderr?.trim() ?? ""}`,
      );
    }

    try {
      const parsed = parseClaudeJsonOutput(stdout);
      return {
        responseText: parsed.responseText,
        rawOutput: stdout,
        durationMs: Date.now() - start,
        model: resolveClaudeCliModel(task.tier),
        estimatedTokens: parsed.estimatedTokens,
      };
    } catch (error) {
      logger.warn(
        {
          error: error instanceof Error ? error.message : String(error),
          stdoutPreview: stdout.slice(0, 200),
        },
        "[RUNNER] Claude JSON parse fallback",
      );
      return {
        responseText: stdout,
        rawOutput: stdout,
        durationMs: Date.now() - start,
        model: resolveClaudeCliModel(task.tier),
        estimatedTokens: estimateTokens(stdout),
      };
    }
  }
}

export class CodexCliRunner implements LlmRunner {
  readonly name = "codex" as const;

  async run(task: RunnerTask): Promise<RawRunnerOutput> {
    const timeoutMs = loadEnv().LLM_RUNNER_TIMEOUT_MS;
    const outputPath = join(tmpdir(), `threadsos-codex-${randomUUID()}.txt`);
    const start = Date.now();
    const prompt = buildPromptEnvelope(task);
    const args = [
      "exec",
      prompt,
      "--model",
      resolveCodexModel(task.tier),
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "-C",
      process.cwd(),
      "-o",
      outputPath,
      "--ephemeral",
    ];

    const result = spawnSync("codex", args, {
      encoding: "utf-8",
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, THREADOS_INTERNAL: "1" },
    });

    if (result.error) {
      const kind = result.error.message.includes("ETIMEDOUT")
        ? "timeout"
        : "process_error";
      throw new RoutedRunnerError(
        this.name,
        kind,
        `Codex CLI 起動失敗: ${result.error.message}`,
      );
    }

    const rawOutput = readFileSync(outputPath, "utf-8").trim();
    rmSync(outputPath, { force: true });

    if (result.status !== 0 && !rawOutput) {
      throw new RoutedRunnerError(
        this.name,
        "process_error",
        `Codex CLI エラー (${result.status}): ${result.stderr?.trim() ?? ""}`,
      );
    }

    return {
      responseText: rawOutput,
      rawOutput,
      durationMs: Date.now() - start,
      model: resolveCodexModel(task.tier),
      estimatedTokens: estimateTokens(prompt) + estimateTokens(rawOutput),
    };
  }
}

export class CopilotCliRunner implements LlmRunner {
  readonly name = "copilot" as const;

  async run(task: RunnerTask): Promise<RawRunnerOutput> {
    const timeoutMs = loadEnv().LLM_RUNNER_TIMEOUT_MS;
    const scriptPath = join(process.cwd(), "scripts", "copilot-chat.mjs");
    const prompt = buildPromptEnvelope(task);
    const start = Date.now();
    const result = spawnSync(
      "node",
      [
        scriptPath,
        randomUUID(),
        prompt,
        "--model",
        resolveCopilotModel(task.tier),
      ],
      {
        encoding: "utf-8",
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, THREADOS_INTERNAL: "1" },
      },
    );

    if (result.error) {
      const kind = result.error.message.includes("ETIMEDOUT")
        ? "timeout"
        : "process_error";
      throw new RoutedRunnerError(
        this.name,
        kind,
        `Copilot CLI 起動失敗: ${result.error.message}`,
      );
    }

    const stdout = (result.stdout ?? "").trim();
    if (result.status !== 0 && !stdout) {
      throw new RoutedRunnerError(
        this.name,
        "process_error",
        `Copilot CLI エラー (${result.status}): ${result.stderr?.trim() ?? ""}`,
      );
    }

    return {
      responseText: stdout,
      rawOutput: stdout,
      durationMs: Date.now() - start,
      model: resolveCopilotModel(task.tier),
      estimatedTokens: estimateTokens(prompt) + estimateTokens(stdout),
    };
  }
}

function buildDecisionPayload(responseText: string): Record<string, unknown> {
  const objectPayload = parseJsonObject<Record<string, unknown>>(responseText);
  if (objectPayload) {
    return objectPayload;
  }

  const arrayPayload = parseJsonArray<unknown>(responseText);
  if (arrayPayload) {
    return { items: arrayPayload };
  }

  return { text: responseText };
}

function validateJsonExpectation(responseText: string): boolean {
  return (
    parseJsonObject<Record<string, unknown>>(responseText) !== null ||
    parseJsonArray<unknown>(responseText) !== null
  );
}

function pickRunnerOrder(task: RunnerTask): RunnerName[] {
  const preferred =
    task.preferredRunner ??
    (() => {
      switch (task.taskType) {
        case "failure_analysis":
        case "strategy_review":
          return "codex" as const;
        case "audit":
          return "claude" as const;
        default:
          return "claude" as const;
      }
    })();

  const fallback =
    task.fallbackRunner ?? (preferred === "claude" ? "codex" : "claude");

  return Array.from(new Set<RunnerName>([preferred, fallback, "copilot"]));
}

export function createRunnerTask(input: {
  prompt: string;
  systemPrompt?: string;
  tier?: LlmTier;
  taskType?: RunnerTaskType;
  role?: RunnerRole;
  confidenceRequired?: RunnerConfidence;
  jsonSchema?: Record<string, unknown>;
  maxTokens?: number;
  temperature?: number;
  label?: string;
  expectJson?: boolean;
  preferredRunner?: RunnerName;
  fallbackRunner?: RunnerName;
}): RunnerTask {
  return {
    prompt: input.prompt,
    systemPrompt: input.systemPrompt,
    tier: input.tier ?? loadEnv().LLM_DEFAULT_TIER,
    taskType: input.taskType ?? "rewrite",
    role: input.role ?? "executive",
    confidenceRequired: input.confidenceRequired ?? "medium",
    jsonSchema: input.jsonSchema,
    maxTokens: input.maxTokens,
    temperature: input.temperature,
    label: input.label,
    expectJson: input.expectJson,
    preferredRunner: input.preferredRunner,
    fallbackRunner: input.fallbackRunner,
  };
}

export function createRunnerRouter(options?: {
  runners?: Partial<Record<RunnerName, LlmRunner>>;
  healthStore?: RunnerHealthStore;
  budgetGovernor?: RunnerBudgetGovernor;
}) {
  const healthStore = options?.healthStore ?? new DbRunnerHealthStore();
  const budgetGovernor =
    options?.budgetGovernor ?? new DbRunnerBudgetGovernor();
  const runners: Partial<Record<RunnerName, LlmRunner>> = {
    claude: new ClaudeCodeRunner(),
    codex: new CodexCliRunner(),
    copilot: new CopilotCliRunner(),
    ...options?.runners,
  };

  return {
    async run(task: RunnerTask): Promise<RunnerResult> {
      const order = pickRunnerOrder(task);
      let lastError: Error | null = null;

      for (const runnerName of order) {
        const runner = runners[runnerName];
        if (!runner) {
          continue;
        }
        if (!healthStore.canUse(runnerName)) {
          lastError = new RoutedRunnerError(
            runnerName,
            "circuit_open",
            `${runnerName} runner is circuit-open`,
          );
          continue;
        }
        if (!budgetGovernor.canRun(runnerName, task)) {
          lastError = new RoutedRunnerError(
            runnerName,
            "budget_exceeded",
            `${runnerName} runner budget exceeded`,
          );
          continue;
        }

        let retryCount = 0;
        while (retryCount < 2) {
          try {
            const output = await runner.run(task);
            if (
              task.expectJson &&
              !validateJsonExpectation(output.responseText)
            ) {
              retryCount += 1;
              if (retryCount >= 2) {
                throw new RoutedRunnerError(
                  runnerName,
                  "invalid_json",
                  `${runnerName} runner returned invalid JSON`,
                );
              }
              continue;
            }

            healthStore.recordSuccess(runnerName, {
              durationMs: output.durationMs,
              model: output.model,
            });
            budgetGovernor.recordUsage(runnerName, output.estimatedTokens);

            return {
              decision: buildDecisionPayload(output.responseText),
              confidence: 1,
              reasons: [`${runnerName} runner completed ${task.taskType}`],
              artifacts: {
                responseText: output.responseText,
                rawOutput: output.rawOutput,
              },
              nextActions: [],
              runnerMeta: {
                runner: runnerName,
                durationMs: output.durationMs,
                retryCount,
                model: output.model,
                estimatedTokens: output.estimatedTokens,
              },
            };
          } catch (error) {
            lastError =
              error instanceof Error ? error : new Error(String(error));
            const routed =
              error instanceof RoutedRunnerError
                ? error
                : new RoutedRunnerError(
                    runnerName,
                    "process_error",
                    error instanceof Error ? error.message : String(error),
                  );
            healthStore.recordFailure(runnerName, {
              kind: routed.kind,
              message: routed.message,
              model: undefined,
            });
            if (routed.kind === "invalid_json" || retryCount > 0) {
              break;
            }
            break;
          }
        }
      }

      throw lastError ?? new Error("No available LLM runner");
    },
  };
}
