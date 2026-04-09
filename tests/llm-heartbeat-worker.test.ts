import { describe, expect, it } from "vitest";
import {
  buildClaudeCliArgs,
  buildClaudeSystemPrompt,
} from "../src/jobs/llm-heartbeat-worker.js";

describe("llm-heartbeat-worker helpers", () => {
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
    const args = buildClaudeCliArgs("Return JSON only.");
    expect(args).toEqual([
      "--print",
      "--output-format",
      "text",
      "--system-prompt",
      "Return JSON only.",
    ]);
  });
});
