import { describe, expect, it } from "vitest";
import * as schema from "../src/db/schema.js";

describe("schema exports", () => {
  it("exposes proposals for the autonomous approval flow", () => {
    expect(schema.proposals).toBeDefined();
    expect(schema.proposalEvents).toBeDefined();
  });
});
