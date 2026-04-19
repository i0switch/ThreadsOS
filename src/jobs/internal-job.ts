import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const jobsDir = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = resolve(jobsDir, "..", "..");
const tsxCli = resolve(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const ansiPattern = new RegExp(
  `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
  "gu",
);

function stripAnsi(value: string): string {
  return value.replace(ansiPattern, "");
}

function summarizeOutput(output: string, scriptName: string): string {
  const lines = stripAnsi(output)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? `${scriptName} completed`;
}

const INTERNAL_JOB_TIMEOUT_MS = Number(
  process.env.INTERNAL_JOB_TIMEOUT_MS ?? 30 * 60 * 1000,
);

export async function runInternalJob(
  scriptName: string,
  options?: { dryRun?: boolean; timeoutMs?: number },
): Promise<string> {
  const scriptPath = resolve(jobsDir, scriptName);
  const args = [tsxCli, scriptPath];
  if (options?.dryRun) {
    args.push("--dry-run");
  }
  const timeoutMs = options?.timeoutMs ?? INTERNAL_JOB_TIMEOUT_MS;

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });

    const timer = setTimeout(() => {
      if (!child.killed) {
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 5000);
      }
      settle(() =>
        rejectPromise(
          new Error(
            `${scriptName} timed out after ${Math.round(timeoutMs / 60000)} minutes`,
          ),
        ),
      );
    }, timeoutMs);

    child.on("error", (error) => {
      settle(() => rejectPromise(error));
    });

    child.on("exit", (code) => {
      const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
      settle(() => {
        if (code === 0) {
          resolvePromise(summarizeOutput(combined, scriptName));
          return;
        }
        rejectPromise(
          new Error(
            `${scriptName} failed with exit code ${code ?? "unknown"}: ${combined}`,
          ),
        );
      });
    });
  });
}
