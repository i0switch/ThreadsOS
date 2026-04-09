import { createRequire } from "node:module";
const require = createRequire(
  "C:/Users/i0swi/AppData/Roaming/npm/node_modules/@github/copilot-sdk/package.json"
);
const { CopilotClient, approveAll } = require("@github/copilot-sdk");

const [, , sessionId, ...promptParts] = process.argv;
const prompt = promptParts.join(" ").trim();

if (!sessionId || !prompt) {
  console.error("Usage: node scripts/copilot-chat.mjs <sessionId> <prompt>");
  process.exit(1);
}

const client = new CopilotClient();
await client.start();

let session;
try {
  session = await client.resumeSession({ sessionId });
} catch {
  session = await client.createSession({
    sessionId,
    model: "gpt-5.4",
    onPermissionRequest: approveAll,
  });
}

const response = await session.sendAndWait({ prompt }, 300_000);

const text =
  response?.data?.content ??
  JSON.stringify(response, null, 2);

console.log(text);

await session.disconnect();
await client.stop();
