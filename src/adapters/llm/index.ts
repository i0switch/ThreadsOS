import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { ExternalApiError } from "../../app/errors.js";
import { logger } from "../../app/logger.js";
import { loadEnv } from "../../config/env.js";
import { db } from "../../db/index.js";
import { llmTaskQueue } from "../../db/schema.js";
import { parseJsonObject } from "../../utils/llm-json.js";

export interface LlmClient {
  generate(
    prompt: string,
    options?: {
      maxTokens?: number;
      temperature?: number;
      systemPrompt?: string;
    },
  ): Promise<string>;
  audit(
    content: string,
    criteria: string[],
  ): Promise<{
    verdict: "pass" | "revise" | "reject" | "human_review";
    severity: "low" | "medium" | "high";
    reasons: string[];
    suggestions: string[];
    score: number;
  }>;
}

export class ClaudeLlmClient implements LlmClient {
  private apiKey: string;
  private baseUrl = "https://api.anthropic.com/v1/messages";

  constructor() {
    const env = loadEnv();
    this.apiKey = env.LLM_API_KEY ?? "";
  }

  async generate(
    prompt: string,
    options?: {
      maxTokens?: number;
      temperature?: number;
      systemPrompt?: string;
    },
  ): Promise<string> {
    const { maxTokens = 4096, temperature = 0.7, systemPrompt } = options ?? {};

    logger.debug({ promptLength: prompt.length }, "LLM generate request");

    const body: Record<string, unknown> = {
      model: "claude-sonnet-4-20250514",
      max_tokens: maxTokens,
      temperature,
      messages: [{ role: "user", content: prompt }],
    };
    if (systemPrompt) {
      body.system = systemPrompt;
    }

    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new ExternalApiError(
        "Claude API",
        `${response.status}: ${errorBody}`,
      );
    }

    const result = (await response.json()) as {
      content: Array<{ type: string; text: string }>;
    };
    return result.content?.[0]?.text ?? "";
  }

  async audit(
    content: string,
    criteria: string[],
  ): Promise<{
    verdict: "pass" | "revise" | "reject" | "human_review";
    severity: "low" | "medium" | "high";
    reasons: string[];
    suggestions: string[];
    score: number;
  }> {
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
      temperature: 0.3,
      systemPrompt: "You are a content auditor. Return ONLY valid JSON.",
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
      return {
        verdict: "human_review",
        severity: "medium",
        reasons: ["LLM応答のパース失敗"],
        suggestions: ["JSON形式を維持して再生成する"],
        score: 5,
      };
    }

    return parsed;
  }
}

// Heartbeat LLM client（ローカル Claude Code 経由）
const HEARTBEAT_POLL_MS = 500;
const HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000;

export class HeartbeatLlmClient implements LlmClient {
  async generate(
    prompt: string,
    options?: {
      maxTokens?: number;
      temperature?: number;
      systemPrompt?: string;
    },
  ): Promise<string> {
    const now = new Date().toISOString();
    const id = randomUUID();

    db.insert(llmTaskQueue)
      .values({
        id,
        status: "pending",
        prompt,
        systemPrompt: options?.systemPrompt ?? null,
        optionsJson: options ? JSON.stringify(options) : null,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    logger.info({ taskId: id }, "[HEARTBEAT] LLM task queued");

    return this._poll(id);
  }

  async audit(
    content: string,
    criteria: string[],
  ): Promise<{
    verdict: "pass" | "revise" | "reject" | "human_review";
    severity: "low" | "medium" | "high";
    reasons: string[];
    suggestions: string[];
    score: number;
  }> {
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
      temperature: 0.3,
      systemPrompt: "You are a content auditor. Return ONLY valid JSON.",
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
      return {
        verdict: "human_review",
        severity: "medium",
        reasons: ["LLM応答のパース失敗"],
        suggestions: ["JSON形式を維持して再生成する"],
        score: 5,
      };
    }

    return parsed;
  }

  private async _poll(taskId: string): Promise<string> {
    const deadline = Date.now() + HEARTBEAT_TIMEOUT_MS;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, HEARTBEAT_POLL_MS));

      const row = db
        .select()
        .from(llmTaskQueue)
        .where(eq(llmTaskQueue.id, taskId))
        .get();

      if (!row) {
        throw new Error(`[HEARTBEAT] LLM task ${taskId} disappeared from queue`);
      }

      if (row.status === "done") {
        logger.info({ taskId }, "[HEARTBEAT] LLM task done");
        return row.result ?? "";
      }
      if (row.status === "error") {
        const errorMsg = row.error ?? "unknown error";
        logger.warn({ taskId, error: errorMsg }, "[HEARTBEAT] LLM task error");
        throw new Error(`[HEARTBEAT] LLM task ${taskId} failed: ${errorMsg}`);
      }
    }

    // タイムアウトした行を error に更新して残骸を残さない
    db.update(llmTaskQueue)
      .set({
        status: "error",
        error: `timed out after ${HEARTBEAT_TIMEOUT_MS}ms`,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(llmTaskQueue.id, taskId))
      .run();

    logger.warn({ taskId }, "[HEARTBEAT] LLM task timed out");
    throw new Error(`[HEARTBEAT] LLM task ${taskId} timed out after ${HEARTBEAT_TIMEOUT_MS}ms`);
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
