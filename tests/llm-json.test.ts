import { describe, expect, it } from "vitest";
import { parseJsonArray, parseJsonObject } from "../src/utils/llm-json.js";

describe("llm-json", () => {
  it("extracts arrays wrapped inside an object payload", () => {
    const parsed = parseJsonArray<{ body: string }>(
      JSON.stringify({
        drafts: [{ body: "one" }, { body: "two" }],
      }),
    );

    expect(parsed).toEqual([{ body: "one" }, { body: "two" }]);
  });

  it("extracts a single object wrapped inside a one-item array", () => {
    const parsed = parseJsonObject<{ verdict: string }>('[{"verdict":"pass"}]');

    expect(parsed).toEqual({ verdict: "pass" });
  });
});
