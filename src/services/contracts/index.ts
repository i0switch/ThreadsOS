import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const RUNNERS = ["claude", "codex", "copilot"] as const;

const baseFrontmatterSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["agent", "playbook", "policy"]),
    name: z.string().min(1),
  })
  .passthrough();

const agentFrontmatterSchema = baseFrontmatterSchema.extend({
  kind: z.literal("agent"),
  department: z.string().min(1),
  role: z.string().min(1),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()),
  successCriteria: z.record(z.string(), z.unknown()),
  forbidden: z.array(z.string()).min(1),
  llmBudget: z.number().int().nonnegative(),
  confidenceRule: z.string().min(1),
  fallback: z.enum(["rewrite", "skip", "quarantine", "pass"]),
  primaryRunner: z.enum(RUNNERS),
  fallbackRunner: z.enum(RUNNERS),
});

const playbookFrontmatterSchema = baseFrontmatterSchema.extend({
  kind: z.literal("playbook"),
  owner: z.string().min(1),
  purpose: z.string().min(1),
  inputs: z.array(z.string()).min(1),
  outputs: z.array(z.string()).min(1),
  steps: z.array(z.string()).min(1),
  successCriteria: z.record(z.string(), z.unknown()),
});

const policyFrontmatterSchema = baseFrontmatterSchema.extend({
  kind: z.literal("policy"),
  scope: z.string().min(1),
  summary: z.string().min(1),
  rules: z.array(z.string()).min(1),
  thresholds: z.record(z.string(), z.unknown()).optional(),
});

export type CompiledAgentContract = z.infer<typeof agentFrontmatterSchema> & {
  body: string;
  filePath: string;
};

export type CompiledPlaybookContract = z.infer<
  typeof playbookFrontmatterSchema
> & {
  body: string;
  filePath: string;
};

export type CompiledPolicyContract = z.infer<typeof policyFrontmatterSchema> & {
  body: string;
  filePath: string;
};

export interface CompiledContractStore {
  rootDir: string;
  compiledAt: string;
  agents: CompiledAgentContract[];
  playbooks: CompiledPlaybookContract[];
  policies: CompiledPolicyContract[];
}

export class ContractCompilationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Contract compilation failed:\n${issues.join("\n")}`);
    this.name = "ContractCompilationError";
    this.issues = issues;
  }
}

const REQUIRED_CONTRACTS = {
  agents: ["executive", "research", "competitor", "threads", "note"],
  playbooks: [
    "funnel-diagnosis",
    "experiment-selection",
    "threads-generation",
    "note-generation",
    "reply-policy",
    "rollback-policy",
    "degrade-modes",
    "canary-rollout",
  ],
  policies: [
    "brand",
    "safety",
    "pricing",
    "monetization",
    "rate-budget",
    "runner-health",
    "rollback-thresholds",
  ],
} as const;

const defaultRootDir = resolve(
  fileURLToPath(new URL("../../../", import.meta.url)),
);

let cachedStore: CompiledContractStore | null = null;

function extractFrontmatter(markdown: string, filePath: string) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new ContractCompilationError([
      `${filePath}: frontmatter block is required`,
    ]);
  }

  const [, rawFrontmatter, body] = match;
  let parsed: unknown;

  try {
    parsed = JSON.parse(rawFrontmatter);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ContractCompilationError([
      `${filePath}: frontmatter must be valid JSON (${reason})`,
    ]);
  }

  if (!body.trim()) {
    throw new ContractCompilationError([
      `${filePath}: markdown body must not be empty`,
    ]);
  }

  return {
    frontmatter: parsed,
    body: body.trim(),
  };
}

function collectMarkdownFiles(dirPath: string, issues: string[]) {
  if (!existsSync(dirPath)) {
    issues.push(`${dirPath}: directory is missing`);
    return [] as string[];
  }

  return readdirSync(dirPath)
    .filter((entry) => entry.endsWith(".md"))
    .sort()
    .map((entry) => resolve(dirPath, entry));
}

function compileContractsFromDir<
  TContract extends { id: string; name: string },
>(filePaths: string[], schema: z.ZodType<TContract>, issues: string[]) {
  const seenIds = new Set<string>();

  return filePaths
    .map((filePath) => {
      try {
        const raw = readFileSync(filePath, "utf-8");
        const { frontmatter, body } = extractFrontmatter(raw, filePath);
        const parsed = schema.safeParse(frontmatter);

        if (!parsed.success) {
          issues.push(
            `${filePath}: ${parsed.error.issues
              .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
              .join(", ")}`,
          );
          return null;
        }

        if (seenIds.has(parsed.data.id)) {
          issues.push(`${filePath}: duplicate contract id '${parsed.data.id}'`);
          return null;
        }
        seenIds.add(parsed.data.id);

        return {
          ...parsed.data,
          body,
          filePath,
        };
      } catch (error) {
        if (error instanceof ContractCompilationError) {
          issues.push(...error.issues);
        } else {
          const reason = error instanceof Error ? error.message : String(error);
          issues.push(`${filePath}: ${reason}`);
        }
        return null;
      }
    })
    .filter(
      (contract): contract is TContract & { body: string; filePath: string } =>
        contract !== null,
    );
}

function assertRequiredIds(
  compiledIds: string[],
  requiredIds: readonly string[],
  kind: string,
  issues: string[],
) {
  for (const requiredId of requiredIds) {
    if (!compiledIds.includes(requiredId)) {
      issues.push(`${kind}: missing required contract '${requiredId}'`);
    }
  }
}

export function resolveContractRootDir(rootDir?: string): string {
  return rootDir ? resolve(rootDir) : defaultRootDir;
}

export function compileContractStore(options?: {
  rootDir?: string;
}): CompiledContractStore {
  const issues: string[] = [];
  const rootDir = resolveContractRootDir(options?.rootDir);

  const agentFiles = collectMarkdownFiles(resolve(rootDir, "agents"), issues);
  const playbookFiles = collectMarkdownFiles(
    resolve(rootDir, "playbooks"),
    issues,
  );
  const policyFiles = collectMarkdownFiles(
    resolve(rootDir, "policies"),
    issues,
  );

  const agents = compileContractsFromDir(
    agentFiles,
    agentFrontmatterSchema,
    issues,
  );
  const runtimeAgents = agents.filter((contract) =>
    REQUIRED_CONTRACTS.agents.includes(
      contract.id as (typeof REQUIRED_CONTRACTS.agents)[number],
    ),
  );
  const playbooks = compileContractsFromDir(
    playbookFiles,
    playbookFrontmatterSchema,
    issues,
  );
  const policies = compileContractsFromDir(
    policyFiles,
    policyFrontmatterSchema,
    issues,
  );

  assertRequiredIds(
    runtimeAgents.map((contract) => contract.id),
    REQUIRED_CONTRACTS.agents,
    "agents",
    issues,
  );
  assertRequiredIds(
    playbooks.map((contract) => contract.id),
    REQUIRED_CONTRACTS.playbooks,
    "playbooks",
    issues,
  );
  assertRequiredIds(
    policies.map((contract) => contract.id),
    REQUIRED_CONTRACTS.policies,
    "policies",
    issues,
  );

  if (issues.length > 0) {
    throw new ContractCompilationError(issues);
  }

  return {
    rootDir,
    compiledAt: new Date().toISOString(),
    agents: runtimeAgents,
    playbooks,
    policies,
  };
}

export function getCompiledContractStore(options?: {
  rootDir?: string;
  forceReload?: boolean;
}): CompiledContractStore {
  if (options?.rootDir) {
    return compileContractStore({ rootDir: options.rootDir });
  }

  if (!cachedStore || options?.forceReload) {
    cachedStore = compileContractStore();
  }

  return cachedStore;
}

export function assertContractStoreHealthy(options?: {
  rootDir?: string;
}): void {
  getCompiledContractStore({
    rootDir: options?.rootDir,
    forceReload: true,
  });
}

export function resetCompiledContractStoreCache(): void {
  cachedStore = null;
}
