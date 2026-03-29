import { ExternalApiError } from "../../app/errors.js";
import { logger } from "../../app/logger.js";
import { loadEnv } from "../../config/env.js";

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

    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No JSON found in response");
      return JSON.parse(jsonMatch[0]);
    } catch {
      logger.warn({ raw }, "Failed to parse audit response as JSON");
      return {
        verdict: "human_review",
        severity: "medium",
        reasons: ["LLM応答のパース失敗"],
        suggestions: [],
        score: 5,
      };
    }
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
