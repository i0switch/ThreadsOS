#!/usr/bin/env node
const fs = require("fs");

function readStdin() {
  return fs.readFileSync(0, "utf8");
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })
  );
}

try {
  const raw = readStdin();
  const payload = JSON.parse(raw || "{}");
  const command = String(payload?.tool_input?.command || "").trim();

  const blockedPatterns = [
    /rm\s+-rf\s+\//i,
    /git\s+push\s+origin\s+(main|master)\b/i,
    /curl\s+/i,
    /wget\s+/i,
    /shutdown\b/i,
    /reboot\b/i,
    /format\b/i,
    /mkfs\b/i,
  ];

  for (const pattern of blockedPatterns) {
    if (pattern.test(command)) {
      deny(`Blocked risky Bash command by project policy: ${command}`);
      process.exit(0);
    }
  }

  process.exit(0);
} catch (err) {
  process.exit(0);
}
