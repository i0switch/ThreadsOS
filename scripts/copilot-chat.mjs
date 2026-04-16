import { createRequire } from "node:module";
const require = createRequire(
  "C:/Users/i0swi/AppData/Roaming/npm/node_modules/@github/copilot-sdk/package.json"
);
const { CopilotClient, approveAll } = require("@github/copilot-sdk");

const [, , sessionId, ...cliArgs] = process.argv;

function parseCliArgs(args) {
  let model;
  const promptParts = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--model" || arg === "-m") {
      model = args[index + 1];
      index += 1;
      continue;
    }

    if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length);
      continue;
    }

    promptParts.push(arg);
  }

  return {
    prompt: promptParts.join(" ").trim(),
    model,
  };
}

const { prompt, model } = parseCliArgs(cliArgs);

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
    model: model ?? "gpt-5.4",
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
