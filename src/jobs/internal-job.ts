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

export async function runInternalJob(
  scriptName: string,
  options?: { dryRun?: boolean },
): Promise<string> {
  const scriptPath = resolve(jobsDir, scriptName);
  const args = [tsxCli, scriptPath];
  if (options?.dryRun) {
    args.push("--dry-run");
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      rejectPromise(error);
    });

    child.on("exit", (code) => {
      const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
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
}
