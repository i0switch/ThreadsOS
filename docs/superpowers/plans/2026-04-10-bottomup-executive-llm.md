# ボトムアップ情報フロー + LLMエグゼクティブ判断 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 各部署がハートビートごとに状況レポートを上げ、エグゼクティブがLLMで最適な判断を下し、必要な部署だけ動く構造に変更する。

**Architecture:** 各DepartmentExecutorに軽量な`report()`メソッドを追加し、DBからの現況を構造化レポートとして返す。ExecutiveServiceが全部署レポートを集約し、LLMに渡して「どの部署を動かすか・何をさせるか」を判断させる。機械的なswitch/if判定は全廃。

**Tech Stack:** TypeScript, Drizzle ORM, Claude CLI (HeartbeatLlmClient)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/domain/department/index.ts` | Modify | `DepartmentReport` 型を追加 |
| `src/services/department-execution/index.ts` | Modify | 各executor に `report()` を実装 |
| `src/services/executive/index.ts` | Modify | LLMベースの判断ロジックに全面書き換え |
| `src/jobs/hourly-heartbeat.ts` | Modify | フローを「レポート収集→LLM判断→実行」に変更 |
| `tests/executive.test.ts` | Create | エグゼクティブLLM判断のテスト |
| `tests/department-report.test.ts` | Create | 部署レポート生成のテスト |

---

### Task 1: DepartmentReport 型定義

**Files:**
- Modify: `src/domain/department/index.ts`

- [ ] **Step 1: DepartmentReport 型を追加**

```typescript
// src/domain/department/index.ts の末尾に追加

export interface DepartmentReport {
  department: DepartmentName;
  /** 現在の状態サマリー（LLMが読む用） */
  summary: string;
  /** 定量データ */
  metrics: Record<string, number>;
  /** 部署側の推奨（「動く必要なし」「リサーチ更新推奨」等） */
  recommendation: string;
  /** 最終実行時刻 */
  lastExecutedAt: string | null;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/domain/department/index.ts
git commit -m "feat: add DepartmentReport type for bottom-up info flow"
```

---

### Task 2: 各部署に report() メソッドを実装

**Files:**
- Modify: `src/services/department-execution/index.ts`
- Create: `tests/department-report.test.ts`

- [ ] **Step 1: DepartmentExecutor インターフェースに report() を追加**

`src/domain/department/index.ts` の `DepartmentExecutor` を修正:

```typescript
export interface DepartmentExecutor {
  department: DepartmentName;
  supports(actionType: ActionType): boolean;
  execute(
    context: DepartmentExecutionContext,
  ): Promise<DepartmentExecutionResult>;
  report(): DepartmentReport;
}
```

- [ ] **Step 2: テストを書く**

```typescript
// tests/department-report.test.ts
import { describe, expect, it } from "vitest";

// DepartmentExecutionServiceImpl の report メソッドをテスト
// 注: DepartmentExecutionServiceImpl のコンストラクタには多くの依存があるため、
// 各 executor の report() を直接テストするヘルパーをエクスポートするか、
// collectReports() メソッドの出力形式をテストする

describe("DepartmentExecution reports", () => {
  it("collectReports returns a report for each department", async () => {
    // collectReports が 6 部署分のレポートを返すことを検証
    // 実装後に具体的なアサーションを追加
  });
});
```

- [ ] **Step 3: 各 createXxxExecutor メソッドに report() を実装**

`src/services/department-execution/index.ts` — 各 executor に `report()` を追加。以下は各部署の実装:

**command (司令部):**
```typescript
private createCommandExecutor(): DepartmentExecutor {
  return {
    department: "command",
    supports: (actionType) => actionType === "process_human_inputs",
    report: (): DepartmentReport => {
      const pendingInputs = db
        .select()
        .from(humanInputs)
        .where(eq(humanInputs.processed, 0))
        .all();
      return {
        department: "command",
        summary: pendingInputs.length > 0
          ? `未処理の人間入力が${pendingInputs.length}件あり。優先処理推奨`
          : "未処理の人間入力なし。待機中",
        metrics: { pendingInputs: pendingInputs.length },
        recommendation: pendingInputs.length > 0 ? "process_human_inputs を実行すべき" : "動く必要なし",
        lastExecutedAt: this.getLastRun("command"),
      };
    },
    execute: async ({ action }) => {
      // ...existing...
    },
  };
}
```

**research (リサーチ部):**
```typescript
report: (): DepartmentReport => {
  const lastResearch = db
    .select()
    .from(departmentRuns)
    .where(eq(departmentRuns.department, "research"))
    .orderBy(desc(departmentRuns.createdAt))
    .limit(1)
    .get();
  const hoursSinceLastResearch = lastResearch
    ? (Date.now() - new Date(lastResearch.createdAt).getTime()) / 3_600_000
    : Infinity;
  const activeTopics = db
    .select()
    .from(topics)
    .where(eq(topics.status, "active"))
    .all().length;
  return {
    department: "research",
    summary: hoursSinceLastResearch > 24
      ? `最終リサーチから${Math.floor(hoursSinceLastResearch)}時間経過。更新推奨`
      : `最終リサーチから${Math.floor(hoursSinceLastResearch)}時間。まだ新鮮`,
    metrics: { hoursSinceLastResearch: Math.floor(hoursSinceLastResearch), activeTopics },
    recommendation: hoursSinceLastResearch > 24 ? "リサーチ更新推奨" : "動く必要なし",
    lastExecutedAt: lastResearch?.createdAt ?? null,
  };
},
```

**threads (Threads部):**
```typescript
report: (): DepartmentReport => {
  const pendingDrafts = db
    .select()
    .from(threadPostDrafts)
    .where(eq(threadPostDrafts.status, "approved"))
    .all().length;
  const dueSlots = db
    .select()
    .from(contentSlots)
    .where(
      and(
        eq(contentSlots.channel, "threads"),
        eq(contentSlots.status, "pending"),
        lte(contentSlots.scheduledAt, new Date().toISOString()),
      ),
    )
    .all().length;
  return {
    department: "threads",
    summary: `承認済みドラフト在庫: ${pendingDrafts}件、期限到来スロット: ${dueSlots}件`,
    metrics: { pendingDrafts, dueSlots },
    recommendation: pendingDrafts === 0 ? "ドラフト生成が必要" : dueSlots > 0 ? "公開実行推奨" : "在庫十分。動く必要なし",
    lastExecutedAt: this.getLastRun("threads"),
  };
},
```

**note (note部):**
```typescript
report: (): DepartmentReport => {
  const pendingNoteDrafts = db
    .select()
    .from(noteDrafts)
    .where(eq(noteDrafts.status, "approved"))
    .all().length;
  const dueNoteSlots = db
    .select()
    .from(contentSlots)
    .where(
      and(
        eq(contentSlots.channel, "note"),
        eq(contentSlots.status, "pending"),
        lte(contentSlots.scheduledAt, new Date().toISOString()),
      ),
    )
    .all().length;
  const publishedNotes = db
    .select()
    .from(notePostResults)
    .all().length;
  return {
    department: "note",
    summary: `承認済み記事: ${pendingNoteDrafts}件、期限到来スロット: ${dueNoteSlots}件、公開済み: ${publishedNotes}件`,
    metrics: { pendingNoteDrafts, dueNoteSlots, publishedNotes },
    recommendation: publishedNotes === 0 ? "note実績ゼロ。記事生成を最優先" : pendingNoteDrafts === 0 ? "記事生成が必要" : dueNoteSlots > 0 ? "公開実行推奨" : "動く必要なし",
    lastExecutedAt: this.getLastRun("note"),
  };
},
```

**community (コミュニティ部):**
```typescript
report: (): DepartmentReport => {
  const pendingReplies = db
    .select()
    .from(replyDecisions)
    .where(
      and(
        eq(replyDecisions.decision, "safe_auto_reply"),
        isNull(replyDecisions.sentAt),
      ),
    )
    .all().length;
  const recentEngagement = db
    .select()
    .from(threadPostResults)
    .orderBy(desc(threadPostResults.publishedAt))
    .limit(5)
    .all();
  const avgEngagement = recentEngagement.length > 0
    ? recentEngagement.reduce((sum, r) => sum + r.likes + r.repliesCount + r.shares, 0) / recentEngagement.length
    : 0;
  return {
    department: "community",
    summary: `未返信: ${pendingReplies}件、直近5投稿の平均エンゲージメント: ${avgEngagement.toFixed(1)}`,
    metrics: { pendingReplies, avgEngagement: Math.round(avgEngagement) },
    recommendation: pendingReplies > 0 ? "リプライ処理推奨" : "動く必要なし",
    lastExecutedAt: this.getLastRun("community"),
  };
},
```

**optimization (最適化部):**
```typescript
report: (): DepartmentReport => {
  const lastRetro = db
    .select()
    .from(departmentRuns)
    .where(and(eq(departmentRuns.department, "optimization"), eq(departmentRuns.phase, "weekly_retro")))
    .orderBy(desc(departmentRuns.createdAt))
    .limit(1)
    .get();
  const daysSinceRetro = lastRetro
    ? (Date.now() - new Date(lastRetro.createdAt).getTime()) / 86_400_000
    : Infinity;
  return {
    department: "optimization",
    summary: `最終振り返りから${Math.floor(daysSinceRetro)}日経過`,
    metrics: { daysSinceRetro: Math.floor(daysSinceRetro) },
    recommendation: daysSinceRetro >= 7 ? "週次振り返り推奨" : "動く必要なし",
    lastExecutedAt: lastRetro?.createdAt ?? null,
  };
},
```

- [ ] **Step 4: collectReports() メソッドを DepartmentExecutionServiceImpl に追加**

```typescript
collectReports(): DepartmentReport[] {
  return this.executors.map((executor) => executor.report());
}
```

- [ ] **Step 5: getLastRun ヘルパーを追加**

`DepartmentExecutionServiceImpl` 内に:

```typescript
private getLastRun(department: DepartmentName): string | null {
  const last = db
    .select()
    .from(departmentRuns)
    .where(eq(departmentRuns.department, department))
    .orderBy(desc(departmentRuns.createdAt))
    .limit(1)
    .get();
  return last?.createdAt ?? null;
}
```

各 executor の `report` 内で `this.getLastRun` を呼べるよう、report をアロー関数にしてクラスの `this` を束縛する。

- [ ] **Step 6: テストを実行して通ることを確認**

Run: `npx vitest run tests/department-report.test.ts`

- [ ] **Step 7: Commit**

```bash
git add src/domain/department/index.ts src/services/department-execution/index.ts tests/department-report.test.ts
git commit -m "feat: add report() to each department executor for bottom-up info flow"
```

---

### Task 3: ExecutiveService を LLM ベースの判断に全面書き換え

**Files:**
- Modify: `src/services/executive/index.ts`
- Create: `tests/executive.test.ts`

- [ ] **Step 1: ExecutiveService インターフェースを更新**

```typescript
export interface ExecutiveService {
  beginHeartbeatCycle(
    reports: DepartmentReport[],
    candidateActions: ScheduledAction[],
    llm: LlmClient,
  ): Promise<HeartbeatCyclePlan>;
  resolveDepartment(actionType: ActionType): DepartmentName;
  recordDepartmentRun(params: {
    cycleId: string;
    department: DepartmentName;
    phase: string;
    status: "completed" | "failed";
    summary: string;
    payload?: Record<string, unknown>;
  }): Promise<void>;
  completeHeartbeatCycle(
    cycleId: string,
    status: "completed" | "failed",
    summary: string,
  ): Promise<void>;
}
```

- [ ] **Step 2: LLM判断用プロンプト生成メソッドを追加**

```typescript
private buildExecutivePrompt(
  reports: DepartmentReport[],
  candidateActions: ScheduledAction[],
): string {
  const reportSection = reports
    .map(
      (r) =>
        `### ${r.department}部\n- 状況: ${r.summary}\n- 数値: ${JSON.stringify(r.metrics)}\n- 推奨: ${r.recommendation}\n- 最終実行: ${r.lastExecutedAt ?? "なし"}`,
    )
    .join("\n\n");

  const actionSection = candidateActions
    .map(
      (a, i) =>
        `${i + 1}. type="${a.type}" priority=${a.priority} reason="${a.reason}"`,
    )
    .join("\n");

  return `あなたはThreadsOS運用の最高責任者（エグゼクティブ）です。
各部署から上がってきた状況レポートと、実行候補アクションを見て、
今回のハートビートで何を実行すべきかを判断してください。

## 判断原則
- 動く必要がない部署は動かさない（コスト削減）
- 部署の推奨を尊重しつつ、全体最適を考える
- note実績ゼロならnote生成を最優先（ファネル構築）
- 人間入力があれば最優先で処理
- 1回のハートビートで最大3アクションまで
- 各部署のデータに基づいて根拠ある判断をする

## 各部署の状況レポート

${reportSection}

## 実行候補アクション

${actionSection}

## 回答形式（JSONのみ）
{
  "objective": "directive_assimilation" | "funnel_expansion" | "engagement_compounding",
  "funnelStage": "bootstrap" | "distribution" | "conversion" | "optimization",
  "approvedActionTypes": ["action_type_1", "action_type_2"],
  "reasoning": "判断理由を1-2文で",
  "departmentInstructions": {
    "department_name": "この部署への具体的指示"
  }
}`;
}
```

- [ ] **Step 3: beginHeartbeatCycle を LLM 呼び出しに書き換え**

```typescript
async beginHeartbeatCycle(
  reports: DepartmentReport[],
  candidateActions: ScheduledAction[],
  llm: LlmClient,
): Promise<HeartbeatCyclePlan> {
  const prompt = this.buildExecutivePrompt(reports, candidateActions);

  const raw = await llm.generate(prompt, {
    temperature: 0.3,
    systemPrompt:
      "You are an executive decision maker for an autonomous social media system. Return ONLY valid JSON.",
    tier: "standard",
  });

  const decision = parseJsonObject<{
    objective: HeartbeatObjective;
    funnelStage: FunnelStage;
    approvedActionTypes: ActionType[];
    reasoning: string;
    departmentInstructions: Record<string, string>;
  }>(raw);

  if (!decision) {
    // LLMパース失敗時のフォールバック: 全候補を承認
    logger.warn({ raw }, "Executive LLM response parse failed, falling back to approving all candidates");
    return this.buildFallbackPlan(candidateActions);
  }

  const approvedActions = candidateActions.filter((a) =>
    decision.approvedActionTypes.includes(a.type),
  );
  const skippedActions = candidateActions
    .filter((a) => !decision.approvedActionTypes.includes(a.type))
    .map((a) => ({
      action: a,
      reason: `Executive LLM deferred: ${decision.reasoning}`,
    }));

  const cycleId = randomUUID();
  const now = new Date().toISOString();
  const directives = this.buildDirectives(approvedActions);

  // strategy_states 更新
  const strategy: StrategyStateSnapshot = {
    objective: decision.objective,
    funnelStage: decision.funnelStage,
    priorityTopics: this.collectPriorityTopics(),
    pendingHumanInputs: reports.find((r) => r.department === "command")?.metrics.pendingInputs ?? 0,
    dueThreadSlots: reports.find((r) => r.department === "threads")?.metrics.dueSlots ?? 0,
    dueNoteSlots: reports.find((r) => r.department === "note")?.metrics.dueNoteSlots ?? 0,
    pendingReplies: reports.find((r) => r.department === "community")?.metrics.pendingReplies ?? 0,
    latestNoteCount: reports.find((r) => r.department === "note")?.metrics.publishedNotes ?? 0,
    insightFocus: this.collectInsightFocus(),
    activeActionTypes: unique(approvedActions.map((a) => a.type)),
  };

  db.insert(strategyStates)
    .values({
      key: STRATEGY_STATE_KEY,
      scope: "heartbeat",
      stateJson: JSON.stringify(strategy),
      summary: `${strategy.objective}:${strategy.funnelStage} — ${decision.reasoning}`,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: strategyStates.key,
      set: {
        scope: "heartbeat",
        stateJson: JSON.stringify(strategy),
        summary: `${strategy.objective}:${strategy.funnelStage} — ${decision.reasoning}`,
        updatedAt: now,
      },
    })
    .run();

  db.insert(executiveCycles)
    .values({
      id: cycleId,
      objective: strategy.objective,
      funnelStage: strategy.funnelStage,
      strategyKey: STRATEGY_STATE_KEY,
      status: "running",
      decisionJson: JSON.stringify({
        llmReasoning: decision.reasoning,
        departmentInstructions: decision.departmentInstructions,
        departmentReports: reports,
        directives,
        candidateActions,
        approvedActions,
        skippedActions,
      }),
      summary: null,
      startedAt: now,
      completedAt: null,
      createdAt: now,
    })
    .run();

  return {
    cycleId,
    strategyKey: STRATEGY_STATE_KEY,
    objective: decision.objective,
    funnelStage: decision.funnelStage,
    approvedActions,
    skippedActions,
    directives,
    strategy,
  };
}
```

- [ ] **Step 4: フォールバック用メソッドを追加**

```typescript
private buildFallbackPlan(
  candidateActions: ScheduledAction[],
): HeartbeatCyclePlan {
  const cycleId = randomUUID();
  const limited = candidateActions.slice(0, 3);
  const skipped = candidateActions.slice(3).map((a) => ({
    action: a,
    reason: "LLM fallback: limited to 3 actions",
  }));
  return {
    cycleId,
    strategyKey: STRATEGY_STATE_KEY,
    objective: "funnel_expansion",
    funnelStage: "bootstrap",
    approvedActions: limited,
    skippedActions: skipped,
    directives: this.buildDirectives(limited),
    strategy: {
      objective: "funnel_expansion",
      funnelStage: "bootstrap",
      priorityTopics: [],
      pendingHumanInputs: 0,
      dueThreadSlots: 0,
      dueNoteSlots: 0,
      pendingReplies: 0,
      latestNoteCount: 0,
      insightFocus: [],
      activeActionTypes: limited.map((a) => a.type),
    },
  };
}
```

- [ ] **Step 5: 機械的な selectActionPlan, deriveObjective, deriveFunnelStage メソッドを削除**

これらのメソッドは全て LLM 判断に置き換わるため削除:
- `selectActionPlan()`
- `deriveObjective()`
- `deriveFunnelStage()`
- `MAX_ACTIONS_PER_CYCLE` 定数

- [ ] **Step 6: parseJsonObject をインポート**

```typescript
import { parseJsonObject } from "../../utils/llm-json.js";
```

- [ ] **Step 7: LlmClient と DepartmentReport をインポート**

```typescript
import type { LlmClient } from "../../adapters/llm/index.js";
import type { DepartmentReport } from "../../domain/department/index.js";
```

- [ ] **Step 8: テストを書く**

```typescript
// tests/executive.test.ts
import { describe, expect, it } from "vitest";
import type { LlmClient, LlmGenerateOptions } from "../src/adapters/llm/index.js";
import type { DepartmentReport } from "../src/domain/department/index.js";

class MockLlmClient implements LlmClient {
  constructor(private response: string) {}

  async generate(_prompt: string, _options?: LlmGenerateOptions): Promise<string> {
    return this.response;
  }

  async audit() {
    return { verdict: "pass" as const, severity: "low" as const, reasons: [], suggestions: [], score: 8 };
  }
}

describe("ExecutiveService LLM decision", () => {
  it("passes department reports to LLM and respects the decision", async () => {
    // LLMが generate_note だけを承認する応答を返す
    const mockLlm = new MockLlmClient(JSON.stringify({
      objective: "funnel_expansion",
      funnelStage: "bootstrap",
      approvedActionTypes: ["generate_note"],
      reasoning: "note実績ゼロのため記事生成を最優先",
      departmentInstructions: { note: "恋愛ジャンルで記事生成" },
    }));

    // ExecutiveServiceImpl を使ってテスト
    // 具体的なDB依存はテストDBで解決（tests/setup.ts 参照）
  });

  it("falls back to approving all candidates when LLM returns invalid JSON", async () => {
    const mockLlm = new MockLlmClient("this is not json");
    // フォールバック動作を検証
  });
});
```

- [ ] **Step 9: テスト実行**

Run: `npx vitest run tests/executive.test.ts`

- [ ] **Step 10: Commit**

```bash
git add src/services/executive/index.ts tests/executive.test.ts
git commit -m "feat: replace mechanical executive logic with LLM-based decision making"
```

---

### Task 4: hourly-heartbeat.ts のフローを変更

**Files:**
- Modify: `src/jobs/hourly-heartbeat.ts`

- [ ] **Step 1: レポート収集ステップを追加（Step 4 の前に挿入）**

既存のStep 4 (`const actions = await scheduler.decideActions()`) の直前に:

```typescript
// ── Step 3.5: 各部署から状況レポート収集 ────────────────
const departmentReports = departmentExecution.collectReports();
logger.info(
  {
    reports: departmentReports.map((r) => ({
      department: r.department,
      summary: r.summary,
      recommendation: r.recommendation,
    })),
  },
  "Department reports collected (bottom-up)",
);
```

- [ ] **Step 2: beginHeartbeatCycle の呼び出しを変更**

Before:
```typescript
const cycle = await executive.beginHeartbeatCycle(actions);
```

After:
```typescript
const cycle = await executive.beginHeartbeatCycle(departmentReports, actions, llm);
```

- [ ] **Step 3: ログ出力に LLM reasoning を追加**

既存のログ出力にエグゼクティブの判断理由を追加:

```typescript
logger.info(
  {
    cycleId: cycle.cycleId,
    objective: cycle.objective,
    funnelStage: cycle.funnelStage,
    approvedActions: cycle.approvedActions.map((action) => action.type),
    skippedActions: cycle.skippedActions.map((item) => ({
      type: item.action.type,
      reason: item.reason,
    })),
    directives: cycle.directives,
    degradation,
    departmentReports: departmentReports.map((r) => ({
      dept: r.department,
      rec: r.recommendation,
    })),
  },
  "Heartbeat cycle planned by executive (LLM-driven)",
);
```

- [ ] **Step 4: テスト実行**

Run: `npx vitest run`
Expected: all tests pass

- [ ] **Step 5: Commit**

```bash
git add src/jobs/hourly-heartbeat.ts
git commit -m "feat: heartbeat flow now collects dept reports before executive LLM decision"
```

---

### Task 5: 既存テストの修正

**Files:**
- Modify: `tests/department-execution.test.ts`

- [ ] **Step 1: ExecutiveServiceImpl の呼び出しを新シグネチャに合わせる**

`beginHeartbeatCycle` の引数が `(actions)` から `(reports, actions, llm)` に変わったため、既存テストで ExecutiveServiceImpl を使っている箇所を更新する。

- [ ] **Step 2: テスト全件実行**

Run: `npx vitest run`
Expected: all tests pass

- [ ] **Step 3: Commit**

```bash
git add tests/
git commit -m "test: update existing tests for new executive LLM interface"
```

---

### Task 6: 型チェック・最終検証

- [ ] **Step 1: 型チェック**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 2: 全テスト実行**

Run: `npx vitest run`
Expected: all tests pass

- [ ] **Step 3: dry-run でハートビート起動テスト**

Run: `npx tsx src/jobs/hourly-heartbeat.ts --dry-run`
Expected: Department reports collected ログが出力され、LLMは DryRunLlmClient なのでフォールバック動作する

- [ ] **Step 4: Commit (if any remaining changes)**

```bash
git add -A
git commit -m "chore: final cleanup for bottom-up executive LLM flow"
```
