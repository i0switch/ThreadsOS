#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const cp = require("child_process");

function readStdin() {
  return fs.readFileSync(0, "utf8");
}

function run(command) {
  try {
    return cp.execSync(command, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const stdout = err.stdout ? String(err.stdout) : "";
    const stderr = err.stderr ? String(err.stderr) : "";
    return `${stdout}\n${stderr}`.trim();
  }
}

function respond(additionalContext) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext,
      },
    })
  );
}

try {
  const raw = readStdin();
  const payload = JSON.parse(raw || "{}");
  const filePath =
    payload?.tool_input?.file_path ||
    payload?.tool_response?.filePath ||
    "";

  const ext = path.extname(String(filePath)).toLowerCase();
  const relevant =
    [".ts", ".tsx", ".js", ".jsx", ".json", ".md"].includes(ext) ||
    /package\.json|pnpm-lock\.yaml|drizzle|vitest|tsconfig/i.test(
      String(filePath)
    );

  if (!relevant) process.exit(0);

  const lintOutput = run("pnpm lint");
  let summary = `Post-edit check ran for ${filePath}\n\npnpm lint output:\n${lintOutput || "(no output)"}`;

  if (/\.(ts|tsx|js|jsx)$/i.test(String(filePath))) {
    const testOutput = run("pnpm test");
    summary += `\n\npnpm test output:\n${testOutput || "(no output)"}`;
  }

  respond(summary.slice(0, 12000));
  process.exit(0);
} catch (err) {
  process.exit(0);
}
