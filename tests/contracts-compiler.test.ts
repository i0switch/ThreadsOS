import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ContractCompilationError,
  compileContractStore,
} from "../src/services/contracts/index.js";

const tempDirs: string[] = [];

function writeContract(filePath: string, metadata: Record<string, unknown>) {
  writeFileSync(
    filePath,
    `---\n${JSON.stringify(metadata, null, 2)}\n---\n# contract\n\nbody\n`,
    "utf-8",
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("contract compiler", () => {
  it("compiles the repository contract source of truth", () => {
    const compiled = compileContractStore();
    expect(compiled.agents).toHaveLength(5);
    expect(compiled.playbooks).toHaveLength(8);
    expect(compiled.policies).toHaveLength(6);
  });

  it("fails when required contracts are missing", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "threadsos-contracts-"));
    tempDirs.push(rootDir);

    const agentsDir = join(rootDir, "agents");
    const playbooksDir = join(rootDir, "playbooks");
    const policiesDir = join(rootDir, "policies");
    mkdirSync(agentsDir);
    mkdirSync(playbooksDir);
    mkdirSync(policiesDir);

    writeContract(join(agentsDir, "executive.md"), {
      id: "executive",
      kind: "agent",
      name: "executive",
      department: "management",
      role: "role",
      inputSchema: { x: "string" },
      outputSchema: { y: "string" },
      successCriteria: { result: "ok" },
      forbidden: ["human_review"],
      llmBudget: 1,
      confidenceRule: "skip",
      fallback: "skip",
      primaryRunner: "claude",
      fallbackRunner: "codex",
    });

    expect(() => compileContractStore({ rootDir })).toThrow(
      ContractCompilationError,
    );
  });
});
