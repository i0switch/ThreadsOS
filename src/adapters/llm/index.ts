import { logger } from "../../app/logger.js";
import { loadEnv } from "../../config/env.js";
import { parseJsonObject } from "../../utils/llm-json.js";
import {
  createRunnerRouter,
  createRunnerTask,
  type RunnerConfidence,
  type RunnerName,
  type RunnerRole,
  type RunnerTaskType,
} from "./runner-router.js";

export type LlmTier = "fast" | "standard" | "premium";

export interface LlmGenerateOptions {
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  tier?: LlmTier;
  label?: string;
  taskType?: RunnerTaskType;
  role?: RunnerRole;
  confidenceRequired?: RunnerConfidence;
  preferredRunner?: RunnerName;
  fallbackRunner?: RunnerName;
  expectJson?: boolean;
}

export interface LlmClient {
  generate(prompt: string, options?: LlmGenerateOptions): Promise<string>;
  audit(
    content: string,
    criteria: string[],
    options?: LlmGenerateOptions,
  ): Promise<{
    verdict: "pass" | "revise" | "reject";
    severity: "low" | "medium" | "high";
    reasons: string[];
    suggestions: string[];
    score: number;
  }>;
}

function resolveLlmTier(requestedTier?: LlmTier): LlmTier {
  return requestedTier ?? loadEnv().LLM_DEFAULT_TIER;
}

const runnerRouter = createRunnerRouter();

function inferTaskType(options?: LlmGenerateOptions): RunnerTaskType {
  if (options?.taskType) {
    return options.taskType;
  }

  const label = (options?.label ?? "").toLowerCase();
  if (label.includes("audit")) return "audit";
  if (label.includes("reply")) return "reply_generation";
  if (label.includes("note")) return "note_generation";
  if (label.includes("threads") || label.includes("post")) {
    return "threads_generation";
  }
  if (label.includes("strategy")) return "strategy_review";
  if (label.includes("failure")) return "failure_analysis";
  return "rewrite";
}

function inferRole(options?: LlmGenerateOptions): RunnerRole {
  if (options?.role) {
    return options.role;
  }

  const label = (options?.label ?? "").toLowerCase();
  if (label.includes("audit")) return "auditor";
  if (label.includes("research")) return "research";
  if (label.includes("competitor")) return "competitor";
  if (label.includes("note")) return "note";
  if (
    label.includes("threads") ||
    label.includes("reply") ||
    label.includes("post")
  ) {
    return "threads";
  }
  return "executive";
}

function inferExpectJson(
  prompt: string,
  options?: LlmGenerateOptions,
): boolean {
  if (typeof options?.expectJson === "boolean") {
    return options.expectJson;
  }

  const combined = `${options?.systemPrompt ?? ""}\n${prompt}`.toLowerCase();
  return combined.includes("json");
}

export class HeartbeatLlmClient implements LlmClient {
  async generate(
    prompt: string,
    options?: LlmGenerateOptions,
  ): Promise<string> {
    const task = createRunnerTask({
      prompt,
      systemPrompt: options?.systemPrompt,
      tier: resolveLlmTier(options?.tier),
      taskType: inferTaskType(options),
      role: inferRole(options),
      confidenceRequired: options?.confidenceRequired ?? "medium",
      maxTokens: options?.maxTokens,
      temperature: options?.temperature,
      label: options?.label,
      expectJson: inferExpectJson(prompt, options),
      preferredRunner: options?.preferredRunner,
      fallbackRunner: options?.fallbackRunner,
    });
    const result = await runnerRouter.run(task);
    return result.artifacts.responseText;
  }

  async audit(
    content: string,
    criteria: string[],
    options?: LlmGenerateOptions,
  ): Promise<{
    verdict: "pass" | "revise" | "reject";
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
  "verdict": "pass" | "revise" | "reject",
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
      taskType: "audit",
      role: "auditor",
      confidenceRequired: "high",
      preferredRunner: "claude",
      fallbackRunner: "codex",
      expectJson: true,
    });

    const parsed = parseJsonObject<{
      verdict: "pass" | "revise" | "reject";
      severity: "low" | "medium" | "high";
      reasons: string[];
      suggestions: string[];
      score: number;
    }>(raw);

    if (!parsed) {
      logger.warn({ raw }, "Failed to parse heartbeat audit response as JSON");
      // Fix-2 (2026-04-14): パース失敗は自動 revise でリトライに回す。
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
    verdict: "pass" | "revise" | "reject";
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
    case "dry-run":
      return new DryRunLlmClient();
    default:
      return new HeartbeatLlmClient();
  }
}
