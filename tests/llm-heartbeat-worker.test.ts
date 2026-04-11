import { beforeEach, describe, expect, it } from "vitest";
import {
  buildClaudeCliArgs,
  buildClaudeSystemPrompt,
  resolveClaudeCliModel,
} from "../src/jobs/llm-heartbeat-worker.js";

describe("llm-heartbeat-worker helpers", () => {
  beforeEach(() => {
    delete process.env.LLM_DEFAULT_TIER;
    delete process.env.LLM_HEARTBEAT_MODEL_FAST;
    delete process.env.LLM_HEARTBEAT_MODEL_STANDARD;
    delete process.env.LLM_HEARTBEAT_MODEL_PREMIUM;
  });

  it("embeds queued generation constraints into the Claude system prompt", () => {
    const systemPrompt = buildClaudeSystemPrompt("Return JSON only.", {
      maxTokens: 300,
      temperature: 0.2,
    });

    expect(systemPrompt).toContain("Return JSON only.");
    expect(systemPrompt).toContain("approximately 300 tokens");
    expect(systemPrompt).toContain("Be deterministic");
  });

  it("builds CLI args with a merged system prompt when present", () => {
    const args = buildClaudeCliArgs("Return JSON only.", { tier: "premium" });
    expect(args).toEqual([
      "--print",
      "--output-format",
      "text",
      "--model",
      "opus",
      "--system-prompt",
      "Return JSON only.",
    ]);
  });

  it("resolves the configured heartbeat model for each tier", () => {
    process.env.LLM_HEARTBEAT_MODEL_FAST = "haiku-custom";
    process.env.LLM_HEARTBEAT_MODEL_STANDARD = "sonnet-custom";
    process.env.LLM_HEARTBEAT_MODEL_PREMIUM = "opus-custom";

    expect(resolveClaudeCliModel("fast")).toBe("haiku-custom");
    expect(resolveClaudeCliModel("standard")).toBe("sonnet-custom");
    expect(resolveClaudeCliModel("premium")).toBe("opus-custom");
  });

  it("falls back to the default tier when CLI args omit tier", () => {
    process.env.LLM_DEFAULT_TIER = "fast";
    process.env.LLM_HEARTBEAT_MODEL_FAST = "haiku-custom";

    const args = buildClaudeCliArgs();

    expect(args).toEqual([
      "--print",
      "--output-format",
      "text",
      "--model",
      "haiku-custom",
    ]);
  });
});
