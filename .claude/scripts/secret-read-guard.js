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
  const input = payload.tool_input || {};
  const target =
    input.file_path || input.path || input.pattern || input.command || "";

  const blocked = [
    ".env",
    ".env.",
    "secrets/",
    "config/credentials.json",
    "id_rsa",
    "id_ed25519",
    "auth.json",
    "token",
    "credential",
  ];

  const text = String(target).toLowerCase();

  if (blocked.some((x) => text.includes(x.toLowerCase()))) {
    deny(`Sensitive path access blocked by project policy: ${target}`);
    process.exit(0);
  }

  process.exit(0);
} catch (err) {
  process.exit(0);
}
