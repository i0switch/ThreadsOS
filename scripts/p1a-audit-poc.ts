/**
 * P1-A POC: 単発監査 vs バッチ監査の品質比較
 * DB副作用なし。直接 LLM クライアントを叩いてサンプル監査を実行。
 *
 * 出力: tmp/heartbeat-token-reduction-p1a-poc-YYYY-MM-DD.md
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { HeartbeatLlmClient } from "../src/adapters/llm/index.js";
import { parseJsonArray, parseJsonObject } from "../src/utils/llm-json.js";
import { startHeartbeatSession } from "../src/app/heartbeat-context.js";

const N = 30;
const BATCH_SIZE = 5;

const BASE_AUDIT_CRITERIA = [
  "誇張しすぎ",
  "具体性不足",
  "フック弱い",
  "CTA弱い",
  "炎上 / 規約 / 誤情報リスク",
  "根拠不足",
  "note導線が不自然",
  "同一テーマ擦りすぎ",
  "ブランド口調からズレてる",
];

type AuditResult = {
  draftId: string;
  verdict: "pass" | "revise" | "reject" | "human_review";
  severity: "low" | "medium" | "high";
  reasons: string[];
  suggestions: string[];
  score: number;
};

// ── サンプリング ──
const sqlite = new Database("data/threads-note-os.db", { readonly: true });
const samples = sqlite
  .prepare(
    `SELECT id, body FROM thread_post_drafts WHERE status IN ('audited', 'draft') ORDER BY rowid DESC LIMIT ?`,
  )
  .all(N) as Array<{ id: string; body: string }>;
sqlite.close();

console.log(`Sampled ${samples.length} drafts for POC`);

startHeartbeatSession(); // set heartbeatId for token logging
const llm = new HeartbeatLlmClient();

// ── 単発監査 (dry-run: DB書き込みせず直接llm.audit) ──
async function singleAudit(draftId: string, body: string): Promise<AuditResult> {
  const prompt = `以下のコンテンツを監査してください。

## コンテンツ
${body}

## 監査基準
${BASE_AUDIT_CRITERIA.map((c, i) => `${i + 1}. ${c}`).join("\n")}

## 回答形式 (JSONのみ)
{
  "verdict": "pass" | "revise" | "reject" | "human_review",
  "severity": "low" | "medium" | "high",
  "reasons": ["理由1", "理由2"],
  "suggestions": ["改善案1", "改善案2"],
  "score": 0-10
}`;

  const raw = await llm.generate(prompt, {
    label: "poc-single-audit",
    temperature: 0.3,
    systemPrompt: "You are a content auditor. Return ONLY valid JSON.",
    tier: "premium",
  });

  const parsed = parseJsonObject<{
    verdict: AuditResult["verdict"];
    severity: AuditResult["severity"];
    reasons: string[];
    suggestions: string[];
    score: number;
  }>(raw);

  if (!parsed) {
    return {
      draftId,
      verdict: "human_review",
      severity: "medium",
      reasons: ["POC: parse failed"],
      suggestions: [],
      score: 5,
    };
  }

  return {
    draftId,
    verdict: parsed.verdict,
    severity: parsed.severity,
    reasons: parsed.reasons ?? [],
    suggestions: parsed.suggestions ?? [],
    score: parsed.score ?? 5,
  };
}

// ── バッチ監査 (dry-run) ──
async function batchAudit(
  chunk: Array<{ id: string; body: string }>,
): Promise<AuditResult[]> {
  const prompt = `以下のThreads投稿ドラフトをまとめて監査してください。

## 監査基準
${BASE_AUDIT_CRITERIA.map((c, i) => `${i + 1}. ${c}`).join("\n")}

## 対象ドラフト
${chunk
  .map(
    (d, i) =>
      `### Draft ${i + 1}\ndraftId: ${d.id}\nbody:\n${d.body}`,
  )
  .join("\n\n")}

## 回答形式 (JSON配列のみ)
[
  {
    "draftId": "draft-id",
    "verdict": "pass" | "revise" | "reject" | "human_review",
    "severity": "low" | "medium" | "high",
    "reasons": ["理由1", "理由2"],
    "suggestions": ["改善案1", "改善案2"],
    "score": 0-10
  }
]`;

  const raw = await llm.generate(prompt, {
    label: "poc-batch-audit",
    temperature: 0.3,
    systemPrompt: "You are a content auditor. Return ONLY a valid JSON array.",
    tier: "premium",
  });

  const arr =
    parseJsonArray<{
      draftId: string;
      verdict: AuditResult["verdict"];
      severity: AuditResult["severity"];
      reasons: string[];
      suggestions: string[];
      score: number;
    }>(raw) ?? [];

  const resultMap = new Map(
    arr.map((a) => [
      a.draftId,
      {
        draftId: a.draftId,
        verdict: a.verdict,
        severity: a.severity,
        reasons: a.reasons ?? [],
        suggestions: a.suggestions ?? [],
        score: a.score ?? 5,
      } satisfies AuditResult,
    ]),
  );

  return chunk.map(
    (d) =>
      resultMap.get(d.id) ?? {
        draftId: d.id,
        verdict: "human_review",
        severity: "medium",
        reasons: ["POC: batch missing result"],
        suggestions: [],
        score: 5,
      },
  );
}

// ── 実行 ──
console.log("=== Running single audits ===");
const singleResults: AuditResult[] = [];
for (let i = 0; i < samples.length; i++) {
  console.log(`  [${i + 1}/${samples.length}] ${samples[i].id}`);
  try {
    const r = await singleAudit(samples[i].id, samples[i].body);
    singleResults.push(r);
  } catch (err) {
    console.error(`  ERROR:`, (err as Error).message);
    singleResults.push({
      draftId: samples[i].id,
      verdict: "human_review",
      severity: "medium",
      reasons: [`ERROR: ${(err as Error).message}`],
      suggestions: [],
      score: 5,
    });
  }
}

console.log("=== Running batch audits ===");
const batchResults: AuditResult[] = [];
for (let i = 0; i < samples.length; i += BATCH_SIZE) {
  const chunk = samples.slice(i, i + BATCH_SIZE);
  console.log(`  batch ${Math.floor(i / BATCH_SIZE) + 1}: ${chunk.length} drafts`);
  try {
    const rs = await batchAudit(chunk);
    batchResults.push(...rs);
  } catch (err) {
    console.error(`  ERROR:`, (err as Error).message);
    for (const d of chunk) {
      batchResults.push({
        draftId: d.id,
        verdict: "human_review",
        severity: "medium",
        reasons: [`ERROR: ${(err as Error).message}`],
        suggestions: [],
        score: 5,
      });
    }
  }
}

// ── 比較 ──
const singleMap = new Map(singleResults.map((r) => [r.draftId, r]));
const batchMap = new Map(batchResults.map((r) => [r.draftId, r]));

let verdictMatch = 0;
let severityMatch = 0;
const scoreDiffs: number[] = [];
const reasonCountDiffs: number[] = [];
const suggestionCountDiffs: number[] = [];
const perDraft: Array<{
  draftId: string;
  singleVerdict: string;
  batchVerdict: string;
  verdictMatch: boolean;
  singleSeverity: string;
  batchSeverity: string;
  severityMatch: boolean;
  scoreDiff: number;
}> = [];

for (const draft of samples) {
  const s = singleMap.get(draft.id)!;
  const b = batchMap.get(draft.id)!;
  const vMatch = s.verdict === b.verdict;
  const sMatch = s.severity === b.severity;
  const scoreDiff = Math.abs((s.score ?? 5) - (b.score ?? 5));
  const rcDiff = Math.abs(s.reasons.length - b.reasons.length);
  const scDiff = Math.abs(s.suggestions.length - b.suggestions.length);
  if (vMatch) verdictMatch++;
  if (sMatch) severityMatch++;
  scoreDiffs.push(scoreDiff);
  reasonCountDiffs.push(rcDiff);
  suggestionCountDiffs.push(scDiff);
  perDraft.push({
    draftId: draft.id,
    singleVerdict: s.verdict,
    batchVerdict: b.verdict,
    verdictMatch: vMatch,
    singleSeverity: s.severity,
    batchSeverity: b.severity,
    severityMatch: sMatch,
    scoreDiff,
  });
}

const median = (arr: number[]) => {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;

const verdictRate = (verdictMatch / samples.length) * 100;
const severityRate = (severityMatch / samples.length) * 100;
const scoreDiffMedian = median(scoreDiffs);
const reasonCountDiffMean = mean(reasonCountDiffs);
const suggestionCountDiffMean = mean(suggestionCountDiffs);

const pass =
  verdictRate >= 90 &&
  severityRate >= 85 &&
  scoreDiffMedian <= 1 &&
  reasonCountDiffMean <= 1 &&
  suggestionCountDiffMean <= 1;

// ── レポート出力 ──
const date = new Date().toISOString().slice(0, 10);
const reportPath = `tmp/heartbeat-token-reduction-p1a-poc-${date}.md`;
const report = `# P1-A POC 結果レポート

- 日付: ${new Date().toISOString()}
- サンプル数: ${samples.length}
- バッチサイズ: ${BATCH_SIZE}
- 対象: thread-post-audit (単発版 vs バッチ版)

## 結果サマリ

| 指標 | 実測値 | 合格ライン | 判定 |
|---|---|---|---|
| verdict 一致率 | ${verdictRate.toFixed(1)}% | ≥ 90% | ${verdictRate >= 90 ? "✅" : "❌"} |
| severity 一致率 | ${severityRate.toFixed(1)}% | ≥ 85% | ${severityRate >= 85 ? "✅" : "❌"} |
| score 絶対差 中央値 | ${scoreDiffMedian} | ≤ 1 | ${scoreDiffMedian <= 1 ? "✅" : "❌"} |
| reasons 項目数差 平均 | ${reasonCountDiffMean.toFixed(2)} | ≤ 1 | ${reasonCountDiffMean <= 1 ? "✅" : "❌"} |
| suggestions 項目数差 平均 | ${suggestionCountDiffMean.toFixed(2)} | ≤ 1 | ${suggestionCountDiffMean <= 1 ? "✅" : "❌"} |

## 総合判定: **${pass ? "合格 (本実装継続)" : "不合格 (要再設計)"}**

## verdict 分布

| verdict | 単発 | バッチ |
|---|---:|---:|
${(["pass", "revise", "reject", "human_review"] as const)
  .map((v) => {
    const s = singleResults.filter((r) => r.verdict === v).length;
    const b = batchResults.filter((r) => r.verdict === v).length;
    return `| ${v} | ${s} | ${b} |`;
  })
  .join("\n")}

## severity 分布

| severity | 単発 | バッチ |
|---|---:|---:|
${(["low", "medium", "high"] as const)
  .map((s) => {
    const sc = singleResults.filter((r) => r.severity === s).length;
    const bc = batchResults.filter((r) => r.severity === s).length;
    return `| ${s} | ${sc} | ${bc} |`;
  })
  .join("\n")}

## ドラフト別詳細

| draftId | 単発 verdict | バッチ verdict | V一致 | 単発 sev | バッチ sev | S一致 | scoreDiff |
|---|---|---|---|---|---|---|---|
${perDraft
  .map(
    (p) =>
      `| ${p.draftId.slice(0, 8)}... | ${p.singleVerdict} | ${p.batchVerdict} | ${p.verdictMatch ? "✅" : "❌"} | ${p.singleSeverity} | ${p.batchSeverity} | ${p.severityMatch ? "✅" : "❌"} | ${p.scoreDiff} |`,
  )
  .join("\n")}

## 次アクション

${
  pass
    ? "- 本実装継続。P1-A を水平展開 (DepartmentExecutionService 他)\n- Task 4 (本番1HB再測定) に進む"
    : "- P1-A バッチ化を一時停止\n- runDailyThreadsPlan() を単発版に戻す検討\n- 不一致ケースを「バッチサイズ」「プロンプト設計」「JSON形式」の3観点で切り分け"
}

## 生データ

サンプルdraftId一覧: ${samples.map((d) => d.id).join(", ")}
`;

writeFileSync(reportPath, report);
console.log(`\nReport written: ${reportPath}`);
console.log(
  `verdict=${verdictRate.toFixed(1)}% severity=${severityRate.toFixed(1)}% scoreMed=${scoreDiffMedian} → ${pass ? "PASS" : "FAIL"}`,
);
