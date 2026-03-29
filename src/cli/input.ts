import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import { humanInputs } from "../db/schema.js";

const INPUT_TYPES = ["research", "feedback", "directive"] as const;
type InputType = (typeof INPUT_TYPES)[number];

function isInputType(value: string): value is InputType {
  return (INPUT_TYPES as readonly string[]).includes(value);
}

const inputType = process.argv[2];
const content = process.argv.slice(3).join(" ").trim();

if (!inputType || !isInputType(inputType) || content.length === 0) {
  console.error("Usage: pnpm input:<type> <content>");
  console.error(
    '  pnpm input:research "恋愛系で最近バズってるnote: https://..."',
  );
  console.error('  pnpm input:feedback "もっと具体例を増やして"');
  console.error('  pnpm input:directive "来週は自己理解テーマに集中"');
  process.exit(1);
}

db.insert(humanInputs)
  .values({
    id: randomUUID(),
    inputType,
    content,
    processed: 0,
    createdAt: new Date().toISOString(),
  })
  .run();

console.log(`Saved ${inputType} input. Will be processed on next heartbeat.`);
