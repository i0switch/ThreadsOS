import { spawnSync } from "node:child_process";
import { ExternalApiError } from "../../app/errors.js";
import { logger } from "../../app/logger.js";
import { loadEnv } from "../../config/env.js";
import { parseJsonObject } from "../../utils/llm-json.js";
import { logTokenUsage } from "./token-logger.js";
import { getCurrentHeartbeatId } from "../../app/heartbeat-context.js";

export type LlmTier = "fast" | "standard" | "premium";

export interface LlmGenerateOptions {
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  tier?: LlmTier;
  label?: string;
}

export interface LlmClient {
  generate(prompt: string, options?: LlmGenerateOptions): Promise<string>;
  audit(
    content: string,
    criteria: string[],
    options?: LlmGenerateOptions,
  ): Promise<{
    verdict: "pass" | "revise" | "reject" | "human_review";
    severity: "low" | "medium" | "high";
    reasons: string[];
    suggestions: string[];
    score: number;
  }>;
}

function resolveLlmTier(requestedTier?: LlmTier): LlmTier {
  return requestedTier ?? loadEnv().LLM_DEFAULT_TIER;
}

// Get heartbeatId from hourly-heartbeat module
function getHeartbeatId(): string | null {
  return getCurrentHeartbeatId();
}

function resolveDirectModelForTier(tier: LlmTier): string {
  const env = loadEnv();
  switch (tier) {
    case "fast":
      return env.LLM_DIRECT_MODEL_FAST;
    case "premium":
      return env.LLM_DIRECT_MODEL_PREMIUM;
    default:
      return env.LLM_DIRECT_MODEL_STANDARD;
  }
}

export class ClaudeLlmClient implements LlmClient {
  private apiKey: string;
  private baseUrl = "https://api.anthropic.com/v1/messages";
  private timeoutMs = 60_000;

  constructor() {
    const env = loadEnv();
    this.apiKey = env.LLM_API_KEY ?? "";
  }

  async generate(
    prompt: string,
    options?: LlmGenerateOptions,
  ): Promise<string> {
    const {
      maxTokens = 4096,
      temperature = 0.7,
      systemPrompt,
      tier,
      label,
    } = options ?? {};
    const resolvedTier = resolveLlmTier(tier);

    logger.debug(
      { promptLength: prompt.length, tier: resolvedTier },
      "LLM generate request",
    );

    const body: Record<string, unknown> = {
      model: resolveDirectModelForTier(resolvedTier),
      max_tokens: maxTokens,
      temperature,
      messages: [{ role: "user", content: prompt }],
    };
    if (systemPrompt) {
      body.system = systemPrompt;
    }

    const startTime = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(this.baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new ExternalApiError(
          "Claude API",
          `request timed out after ${this.timeoutMs}ms`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw new ExternalApiError(
        "Claude API",
        `${response.status}: ${errorBody}`,
      );
    }

    const result = (await response.json()) as {
      content: Array<{ type: string; text: string }>;
      usage?: {
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
    };
    // Log token usage
    const durationMs = Date.now() - startTime;
    if (result.usage) {
      logTokenUsage({
        timestamp: new Date().toISOString(),
        heartbeatId: getHeartbeatId(),
        callSite: label ?? "unknown",
        tier: resolvedTier,
        inputTokens: result.usage.input_tokens ?? 0,
        outputTokens: result.usage.output_tokens ?? 0,
        cacheCreationTokens: result.usage.cache_creation_input_tokens,
        cacheReadTokens: result.usage.cache_read_input_tokens,
        durationMs,
      });
    }

    return result.content?.[0]?.text ?? "";
  }

  async audit(
    content: string,
    criteria: string[],
    options?: LlmGenerateOptions,
  ): Promise<{
    verdict: "pass" | "revise" | "reject" | "human_review";
    severity: "low" | "medium" | "high";
    reasons: string[];
    suggestions: string[];
    score: number;
  }> {
    // P1-C ロールバック (2026-04-14): 順序変更で cost +11%, cache hit率向上はゼロ、
    // judgment厳しく revise +33% 副作用。実測で cache は元から最大化済みと判明
    const prompt = `以下のコンテンツを監査してください。

## コンテンツ
${content}

## 監査基準
${criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}

## 回答形式 (JSONのみ)
{
  "verdict": "pass" | "revise" | "reject" | "human_review",
  "severity": "low" | "medium" | "high",
  "reasons": ["理由1", "理由2"],
  "suggestions": ["改善案1", "改善案2"],
  "score": 0-10
}`;

    const raw = await this.generate(prompt, {
      label: options?.label ?? "audit",
      temperature: 0.3,
      systemPrompt: "You are a content auditor. Return ONLY valid JSON.",
      tier: "premium",
    });

    const parsed = parseJsonObject<{
      verdict: "pass" | "revise" | "reject" | "human_review";
      severity: "low" | "medium" | "high";
      reasons: string[];
      suggestions: string[];
      score: number;
    }>(raw);

    if (!parsed) {
      logger.warn({ raw }, "Failed to parse audit response as JSON");
      // Fix-2 (2026-04-14): パース失敗は自動 revise でリトライに回す (human_reviewに降らない)。
      // ExternalApiError等の本当のAPI障害は throw で上位伝播するので、ここに来るのはJSON破損のみ。
      // リビジョン上限 (MAX_*_REVISION_ATTEMPTS=2) を超えた場合は settle 側で最終判断される。
      return {
        verdict: "revise",
        severity: "low",
        reasons: ["LLM応答のパース失敗 (自動再生成)"],
        suggestions: ["JSON形式を維持して再生成する"],
        score: 5,
      };
    }

    return parsed;
  }
}

// Heartbeat LLM client（ローカル Claude Code 経由・インプロセス直接実行）
const CLAUDE_TIMEOUT_MS = 8 * 60 * 1000;

function resolveHeartbeatModel(tier?: LlmTier): string {
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

function buildSystemPrompt(
  systemPrompt?: string,
  options?: LlmGenerateOptions,
): string | undefined {
  const constraints: string[] = [];
  const maxTokens = options?.maxTokens;

  if (Number.isFinite(maxTokens) && (maxTokens ?? 0) > 0) {
    constraints.push(
      `Keep the response within approximately ${Math.floor(maxTokens ?? 0)} tokens.`,
    );
  }

  if (typeof options?.temperature === "number") {
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

function callClaudeCli(
  prompt: string,
  systemPrompt?: string,
  options?: LlmGenerateOptions,
): string {
  const mergedSystemPrompt = buildSystemPrompt(systemPrompt, options);
  const resolvedTier = resolveLlmTier(options?.tier);
  const args = [
    "--print",
    "--output-format",
    "json",
    "--model",
    resolveHeartbeatModel(options?.tier),
  ];
  if (mergedSystemPrompt) {
    args.push("--system-prompt", mergedSystemPrompt);
  }

  logger.info(
    { promptLength: prompt.length, tier: options?.tier },
    "[HEARTBEAT] Calling Claude CLI",
  );

  const startTime = Date.now();
  const result = spawnSync("claude", args, {
    input: prompt,
    encoding: "utf-8",
    timeout: CLAUDE_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, THREADOS_INTERNAL: "1" },
  });

  if (result.error) {
    throw new Error(`Claude CLI 起動失敗: ${result.error.message}`);
  }

  const stdout = (result.stdout ?? "").trim();

  if (result.status !== 0 && !stdout) {
    const stderr = result.stderr?.trim() ?? "";
    throw new Error(`Claude CLI エラー (${result.status}): ${stderr}`);
  }

  // Parse JSON output (stream-json array) and extract result + usage
  let responseText = "";
  try {
    const parsed = JSON.parse(stdout);
    const entries: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    const resultEntry = entries.find(
      (e): e is Record<string, unknown> =>
        typeof e === "object" && e !== null && (e as { type?: string }).type === "result",
    );

    if (resultEntry) {
      if (resultEntry.is_error) {
        throw new Error(
          `Claude CLI 結果エラー: ${String(resultEntry.result ?? "unknown")}`,
        );
      }
      responseText =
        typeof resultEntry.result === "string" ? resultEntry.result : "";

      const usage = resultEntry.usage as
        | {
            input_tokens?: number;
            output_tokens?: number;
            cache_creation_input_tokens?: number;
            cache_read_input_tokens?: number;
          }
        | undefined;
      if (usage) {
        const durationMs = Date.now() - startTime;
        logTokenUsage({
          timestamp: new Date().toISOString(),
          heartbeatId: getHeartbeatId(),
          callSite: options?.label ?? "unknown",
          tier: resolvedTier,
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          cacheCreationTokens: usage.cache_creation_input_tokens,
          cacheReadTokens: usage.cache_read_input_tokens,
          costUsd:
            typeof resultEntry.total_cost_usd === "number"
              ? resultEntry.total_cost_usd
              : undefined,
          durationMs:
            typeof resultEntry.duration_ms === "number"
              ? resultEntry.duration_ms
              : durationMs,
        });
      }
    } else {
      logger.warn(
        { stdoutPreview: stdout.slice(0, 200) },
        "[HEARTBEAT] No result entry in CLI JSON output, using raw stdout",
      );
      responseText = stdout;
    }
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        stdoutPreview: stdout.slice(0, 200),
      },
      "[HEARTBEAT] Failed to parse CLI JSON output, falling back to raw stdout",
    );
    responseText = stdout;
  }

  if (
    responseText.includes("out of extra usage") ||
    responseText.includes("out of usage")
  ) {
    throw new Error(`Claude 使用量制限: ${responseText.slice(0, 100)}`);
  }

  logger.info(
    { responseLength: responseText.length },
    "[HEARTBEAT] Claude CLI response received",
  );

  return responseText;
}

export class HeartbeatLlmClient implements LlmClient {
  async generate(
    prompt: string,
    options?: LlmGenerateOptions,
  ): Promise<string> {
    return callClaudeCli(prompt, options?.systemPrompt, options);
  }

  async audit(
    content: string,
    criteria: string[],
    options?: LlmGenerateOptions,
  ): Promise<{
    verdict: "pass" | "revise" | "reject" | "human_review";
    severity: "low" | "medium" | "high";
    reasons: string[];
    suggestions: string[];
    score: number;
  }> {
    // P1-C ロールバック (2026-04-14): 順序変更で cost +11%, cache hit率向上はゼロ、
    // judgment厳しく revise +33% 副作用。実測で cache は元から最大化済みと判明
    const prompt = `以下のコンテンツを監査してください。

## コンテンツ
${content}

## 監査基準
${criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}

## 回答形式 (JSONのみ)
{
  "verdict": "pass" | "revise" | "reject" | "human_review",
  "severity": "low" | "medium" | "high",
  "reasons": ["理由1", "理由2"],
  "suggestions": ["改善案1", "改善案2"],
  "score": 0-10
}`;

    const raw = await this.generate(prompt, {
      label: options?.label ?? "audit",
      temperature: 0.3,
      systemPrompt: "You are a content auditor. Return ONLY valid JSON.",
      tier: "premium",
    });

    const parsed = parseJsonObject<{
      verdict: "pass" | "revise" | "reject" | "human_review";
      severity: "low" | "medium" | "high";
      reasons: string[];
      suggestions: string[];
      score: number;
    }>(raw);

    if (!parsed) {
      logger.warn({ raw }, "Failed to parse heartbeat audit response as JSON");
      // Fix-2 (2026-04-14): パース失敗は自動 revise でリトライに回す (human_reviewに降らない)。
      // ExternalApiError等の本当のAPI障害は throw で上位伝播するので、ここに来るのはJSON破損のみ。
      // リビジョン上限 (MAX_*_REVISION_ATTEMPTS=2) を超えた場合は settle 側で最終判断される。
      return {
        verdict: "revise",
        severity: "low",
        reasons: ["LLM応答のパース失敗 (自動再生成)"],
        suggestions: ["JSON形式を維持して再生成する"],
        score: 5,
      };
    }

    return parsed;
  }
}

// Dry-run LLM client
export class DryRunLlmClient implements LlmClient {
  async generate(prompt: string): Promise<string> {
    logger.info({ promptLength: prompt.length }, "[DRY-RUN] Would call LLM");
    return "[DRY-RUN] LLM response placeholder";
  }

  async audit(
    _content: string,
    _criteria: string[],
    _options?: LlmGenerateOptions,
  ): Promise<{
    verdict: "pass" | "revise" | "reject" | "human_review";
    severity: "low" | "medium" | "high";
    reasons: string[];
    suggestions: string[];
    score: number;
  }> {
    return {
      verdict: "pass",
      severity: "low",
      reasons: ["dry-run"],
      suggestions: [],
      score: 8,
    };
  }
}

export function createLlmClient(): LlmClient {
  const env = loadEnv();
  switch (env.LLM_MODE) {
    case "direct":
      return new ClaudeLlmClient();
    case "dry-run":
      return new DryRunLlmClient();
    default:
      return new HeartbeatLlmClient();
  }
}
