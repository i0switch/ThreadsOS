#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

function readStdin() {
  return fs.readFileSync(0, "utf8");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function today() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function nowIso() {
  return new Date().toISOString();
}

try {
  const raw = readStdin();
  const payload = JSON.parse(raw || "{}");
  const cwd = payload.cwd || process.cwd();
  const dir = path.join(cwd, "docs", "runlog");
  ensureDir(dir);

  const file = path.join(dir, `${today()}.md`);
  const lastMessage = String(payload.last_assistant_message || "").trim();

  const block = [
    `## ${nowIso()}`,
    "",
    `- session_id: ${payload.session_id || ""}`,
    `- hook_event_name: ${payload.hook_event_name || ""}`,
    "",
    lastMessage || "(empty last assistant message)",
    "",
    "---",
    "",
  ].join("\n");

  fs.appendFileSync(file, block, "utf8");
  process.exit(0);
} catch (err) {
  process.exit(0);
}
