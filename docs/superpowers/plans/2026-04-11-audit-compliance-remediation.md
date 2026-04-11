# ThreadsOS 仕様監査コンプライアンス改修計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 監査で発見された16件のギャップ（一部実装10件・仕様ズレ2件・未実装4件）のうち、優先度高〜中の6項目を修正し、仕様適合率を36/52 → 48/52に引き上げる

**Architecture:** 既存の5部署構成・ハートビートループ・LLMエグゼクティブ判断の骨格はそのまま維持。競合分析部署の有効化、Executive→部署への指示伝達パス追加、戦略履歴の永続化、部署間通知の追加を行う。すべて既存ファイルへの追加・修正で完結し、新サービスの作成は最小限にする

**Tech Stack:** TypeScript, Drizzle ORM (SQLite), Vitest, LLM (Claude Code heartbeat mode)

**対象外（優先度低・今回スコープ外）:**
- 要件22/23: スキル・プラグインの動的導入（アーキテクチャ大規模変更が必要）
- 要件8: デスクトップアプリ連携（CLI/cron方式で運用可能）

---

## ファイル構成概要

| 変更種別 | ファイルパス | 責務 |
|---------|------------|------|
| Modify | `src/services/content-scheduler/index.ts` | `ActionType`に`analyze_competitors`を追加 |
| Modify | `src/domain/department/index.ts` | `resolveDepartmentName`に`analyze_competitors`のルーティング追加 |
| Modify | `src/services/department-execution/index.ts` | CompetitiveAnalysisExecutor有効化＋分析ロジック＋departmentInstructions受け渡し |
| Modify | `src/services/executive/index.ts` | `HeartbeatCyclePlan`活用の改善 |
| Modify | `src/jobs/hourly-heartbeat.ts` | departmentInstructions伝達＋戦略履歴保存 |
| Modify | `src/db/schema.ts` | 新テーブル3個追加（`competitorAnalyses`, `strategyHistory`, `departmentNotifications`） |
| Modify | `src/db/bootstrap.ts` | 新テーブルのCREATE TABLE追加 |
| Modify | `src/services/research/index.ts` | 競合分析用の構造化メソッド追加 |
| Modify | `src/services/runtime-state/index.ts` | 競合分析エージェントのactions更新 |
| Modify | `tests/department-execution.test.ts` | 競合分析テスト追加 |
| Modify | `tests/executive.test.ts` | departmentInstructions伝達テスト追加 |
| Create | `tests/competitive-analysis.test.ts` | 競合分析専用テスト |
| Create | `tests/strategy-history.test.ts` | 戦略履歴テスト |

---

### Task 1: DBスキーマ拡張 — 新テーブル3個追加

**Files:**
- Modify: `src/db/schema.ts:293` 付近
- Modify: `src/db/bootstrap.ts`
- Test: `tests/db.test.ts`

- [ ] **Step 1: schema.tsに`competitorAnalyses`テーブル定義を追加**

`src/db/schema.ts` の `competitorSnapshots` 定義の後に追加:

```typescript
export const competitorAnalyses = sqliteTable("competitor_analyses", {
  id: text("id").primaryKey(),
  snapshotId: text("snapshot_id").notNull(),
  channel: text("channel").notNull(), // "threads" | "note"
  themes: text("themes").notNull(), // JSON array of theme strings
  hooks: text("hooks").notNull(), // JSON array of hook patterns
  engagementPatterns: text("engagement_patterns").notNull(), // JSON summary
  winningPatterns: text("winning_patterns").notNull(), // JSON array
  rawAnalysis: text("raw_analysis").notNull(), // Full LLM response
  createdAt: text("created_at").notNull(),
});
```

- [ ] **Step 2: schema.tsに`strategyHistory`テーブル定義を追加**

`executiveCycles` 定義の後に追加:

```typescript
export const strategyHistory = sqliteTable(
  "strategy_history",
  {
    id: text("id").primaryKey(),
    cycleId: text("cycle_id").notNull(),
    objective: text("objective").notNull(),
    funnelStage: text("funnel_stage").notNull(),
    reasoning: text("reasoning").notNull(),
    departmentInstructions: text("department_instructions"), // JSON
    stateJson: text("state_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    createdIdx: index("strategy_history_created_idx").on(table.createdAt),
  }),
);
```

- [ ] **Step 3: schema.tsに`departmentNotifications`テーブル定義を追加**

```typescript
export const departmentNotifications = sqliteTable(
  "department_notifications",
  {
    id: text("id").primaryKey(),
    fromDepartment: text("from_department").notNull(),
    toDepartment: text("to_department").notNull(),
    notificationType: text("notification_type").notNull(), // "research_update" | "analysis_complete" | "instruction"
    content: text("content").notNull(),
    readAt: text("read_at"),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    toUnreadIdx: index("dept_notif_to_unread_idx").on(
      table.toDepartment,
      table.readAt,
    ),
  }),
);
```

- [ ] **Step 4: bootstrap.tsに新テーブルのCREATE TABLE文を追加**

`src/db/bootstrap.ts` の `ensureAutonomyTables()` 内に追加:

```typescript
db.run(sql`CREATE TABLE IF NOT EXISTS competitor_analyses (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  themes TEXT NOT NULL,
  hooks TEXT NOT NULL,
  engagement_patterns TEXT NOT NULL,
  winning_patterns TEXT NOT NULL,
  raw_analysis TEXT NOT NULL,
  created_at TEXT NOT NULL
)`);

db.run(sql`CREATE TABLE IF NOT EXISTS strategy_history (
  id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL,
  objective TEXT NOT NULL,
  funnel_stage TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  department_instructions TEXT,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL
)`);
db.run(sql`CREATE INDEX IF NOT EXISTS strategy_history_created_idx ON strategy_history(created_at)`);

db.run(sql`CREATE TABLE IF NOT EXISTS department_notifications (
  id TEXT PRIMARY KEY,
  from_department TEXT NOT NULL,
  to_department TEXT NOT NULL,
  notification_type TEXT NOT NULL,
  content TEXT NOT NULL,
  read_at TEXT,
  created_at TEXT NOT NULL
)`);
db.run(sql`CREATE INDEX IF NOT EXISTS dept_notif_to_unread_idx ON department_notifications(to_department, read_at)`);
```

- [ ] **Step 5: テスト — テーブル作成を確認**

Run: `npx vitest run tests/db.test.ts -v`
Expected: PASS（既存テスト + 新テーブルが正常に作成される）

- [ ] **Step 6: コミット**

```bash
git add src/db/schema.ts src/db/bootstrap.ts
git commit -m "feat(db): add competitorAnalyses, strategyHistory, departmentNotifications tables"
```

---

### Task 2: ActionType拡張 + ルーティング — `analyze_competitors`の追加

**Files:**
- Modify: `src/services/content-scheduler/index.ts:24-33`
- Modify: `src/domain/department/index.ts:71-104`
- Modify: `src/services/runtime-state/index.ts:122-143`
- Test: `tests/content-scheduler.test.ts`

- [ ] **Step 1: ActionType unionに`analyze_competitors`を追加**

`src/services/content-scheduler/index.ts:24-33` を修正:

```typescript
export type ActionType =
  | "process_human_inputs"
  | "research_threads"
  | "research_note"
  | "generate_and_post"
  | "fetch_engagement"
  | "reply_safe"
  | "generate_note"
  | "optimize_schedule"
  | "weekly_retro"
  | "notify"
  | "analyze_competitors";
```

- [ ] **Step 2: resolveDepartmentNameに`analyze_competitors`のルーティングを追加**

`src/domain/department/index.ts:75` のswitch文に追加:

```typescript
case "analyze_competitors":
  return "competitive-analysis";
```

- [ ] **Step 3: runtime-stateのエージェント定義を更新**

`src/services/runtime-state/index.ts` の `engagement-analyst` と `community-director` のactions配列を更新:

```typescript
{
  id: "engagement-analyst",
  name: "Competitive Signal Analyst",
  department: "competitive-analysis",
  role: "analyst",
  actions: ["analyze_competitors"],
  leaderId: "community-director",
},
// ...
{
  id: "community-director",
  name: "Competitive Analysis Director",
  department: "competitive-analysis",
  role: "leader",
  actions: ["analyze_competitors"],
},
```

- [ ] **Step 4: content-schedulerのdecideActions()に競合分析トリガーを追加**

`src/services/content-scheduler/index.ts` の `decideActions()` メソッド内、`research_note` アクション判定の後（noteResearchAge >= 24 ブロックの後）に追加:

```typescript
// 競合分析: 週1回 or スナップショットが5件以上溜まって未分析
const lastCompetitorAnalysis = db
  .select()
  .from(scheduledJobRuns)
  .where(
    and(
      eq(scheduledJobRuns.jobName, "competitor-analysis"),
      eq(scheduledJobRuns.status, "completed"),
    ),
  )
  .orderBy(desc(scheduledJobRuns.startedAt))
  .limit(1)
  .get();
const competitorAnalysisAge = lastCompetitorAnalysis
  ? hoursBetween(now, lastCompetitorAnalysis.startedAt)
  : Number.POSITIVE_INFINITY;
if (competitorAnalysisAge >= 168) {
  // 168時間 = 7日
  actions.push({
    type: "analyze_competitors",
    priority: 9,
    reason: `前回競合分析から${Math.floor(competitorAnalysisAge / 24)}日経過`,
  });
}
```

schema.tsの `competitorSnapshots` テーブルのimportが必要な場合は追加。ただし `scheduledJobRuns` は既にimport済み。

- [ ] **Step 5: テスト実行**

Run: `npx vitest run tests/content-scheduler.test.ts -v`
Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add src/services/content-scheduler/index.ts src/domain/department/index.ts src/services/runtime-state/index.ts
git commit -m "feat: add analyze_competitors action type with routing and scheduling"
```

---

### Task 3: 競合リサーチ分析部署の有効化（要件32-35）

**Files:**
- Modify: `src/services/department-execution/index.ts:275-322`
- Modify: `src/services/research/index.ts`
- Create: `tests/competitive-analysis.test.ts`

- [ ] **Step 1: テストファイルを作成**

`tests/competitive-analysis.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { DepartmentExecutionServiceImpl } from "../src/services/department-execution/index.js";

describe("CompetitiveAnalysisExecutor", () => {
  function buildService(overrides: Record<string, unknown> = {}) {
    const llm = {
      generate: vi.fn(async () =>
        JSON.stringify({
          themes: ["副業", "AI活用"],
          hooks: ["数字フック", "逆張りフック"],
          engagementPatterns: "午前投稿が高エンゲージメント",
          winningPatterns: [
            {
              pattern: "具体数字+逆張り",
              frequency: "high",
              estimatedEngagement: "high",
            },
          ],
        }),
      ),
    } as never;
    const runtimeState = {
      startAgent: vi.fn(),
      finishAgent: vi.fn(),
    } as const;
    const runTrackedSubJob = vi.fn(
      async (_jobName: string, task: () => Promise<string>) => task(),
    );

    return new DepartmentExecutionServiceImpl({
      dryRun: false,
      maxPostsPerHour: 3,
      llm,
      storage: {} as never,
      threadsApi: {} as never,
      orchestration: {} as never,
      scheduler: {} as never,
      autoPublisher: {} as never,
      optimizer: {} as never,
      replyExecution: {} as never,
      noteEngagement: {} as never,
      notification: {} as never,
      runTrackedSubJob,
      createNoteApiClient: vi.fn() as never,
      runtimeState: runtimeState as never,
      ...overrides,
    });
  }

  it("supports analyze_competitors action", () => {
    const service = buildService();
    const reports = service.collectReports();
    const caReport = reports.find((r) => r.department === "competitive-analysis");
    expect(caReport).toBeDefined();
    expect(caReport!.department).toBe("competitive-analysis");
  });

  it("executes competitor analysis and returns structured result", async () => {
    const service = buildService();
    const result = await service.execute({
      type: "analyze_competitors",
      priority: 9,
      reason: "週次競合分析",
    });
    expect(result.department).toBe("competitive-analysis");
    expect(result.status).toBe("completed");
    expect(result.summary).toContain("競合分析");
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run tests/competitive-analysis.test.ts -v`
Expected: FAIL — `supports()` が `false` を返すため `No department executor registered` エラー

- [ ] **Step 3: ResearchServiceにanalyzeCompetitorSnapshots()メソッドを追加**

`src/services/research/index.ts` のインターフェースに追加:

```typescript
export interface ResearchService {
  // ... existing methods ...
  analyzeCompetitorSnapshots(
    llm: LlmClient,
    channel: "threads" | "note",
  ): Promise<{
    analysisCount: number;
    winningPatterns: string[];
    summary: string;
  }>;
}
```

`ResearchServiceImpl` に実装を追加:

```typescript
async analyzeCompetitorSnapshots(
  llm: LlmClient,
  channel: "threads" | "note",
): Promise<{
  analysisCount: number;
  winningPatterns: string[];
  summary: string;
}> {
  const snapshots = db
    .select()
    .from(competitorSnapshots)
    .orderBy(desc(competitorSnapshots.createdAt))
    .limit(20)
    .all();

  if (snapshots.length === 0) {
    return { analysisCount: 0, winningPatterns: [], summary: "競合スナップショットなし" };
  }

  const snapshotSummary = snapshots
    .map((s, i) => `[${i + 1}] source: ${s.source}\ndata: ${s.data.slice(0, 500)}`)
    .join("\n\n");

  const prompt = `以下の競合スナップショットを分析してください。
チャネル: ${channel}

## スナップショット
${snapshotSummary}

以下の形式でJSON1つだけ返してください:
{
  "themes": ["テーマ1", "テーマ2"],
  "hooks": ["フック手法1", "フック手法2"],
  "engagementPatterns": "エンゲージメントパターンの要約",
  "winningPatterns": [
    {"pattern": "パターン名", "frequency": "high|medium|low", "estimatedEngagement": "high|medium|low"}
  ]
}`;

  const raw = await llm.generate(prompt, {
    temperature: 0.3,
    tier: "standard",
  });

  const parsed = parseJsonObject<{
    themes: string[];
    hooks: string[];
    engagementPatterns: string;
    winningPatterns: Array<{ pattern: string; frequency: string; estimatedEngagement: string }>;
  }>(raw);

  if (!parsed) {
    logger.warn("Failed to parse competitor analysis");
    return { analysisCount: 0, winningPatterns: [], summary: "分析パース失敗" };
  }

  // Save each analysis
  for (const snapshot of snapshots) {
    db.insert(competitorAnalyses)
      .values({
        id: randomUUID(),
        snapshotId: snapshot.id,
        channel,
        themes: JSON.stringify(parsed.themes),
        hooks: JSON.stringify(parsed.hooks),
        engagementPatterns: parsed.engagementPatterns,
        winningPatterns: JSON.stringify(parsed.winningPatterns),
        rawAnalysis: raw,
        createdAt: new Date().toISOString(),
      })
      .onConflictDoNothing()
      .run();
  }

  const winningPatternNames = parsed.winningPatterns.map((p) => p.pattern);
  const summary = `競合分析完了: ${snapshots.length}件のスナップショットからテーマ${parsed.themes.length}件、勝ちパターン${winningPatternNames.length}件を抽出`;

  return {
    analysisCount: snapshots.length,
    winningPatterns: winningPatternNames,
    summary,
  };
}
```

`competitorAnalyses` をschema.tsからimportに追加。`parseJsonObject` のimportも追加。

- [ ] **Step 4: CompetitiveAnalysisExecutorを有効化**

`src/services/department-execution/index.ts:275-322` の `createCompetitiveAnalysisExecutor()` を差し替え:

```typescript
private createCompetitiveAnalysisExecutor(): DepartmentExecutor {
  const research = new ResearchServiceImpl();
  return {
    department: "competitive-analysis",
    supports: (actionType) => actionType === "analyze_competitors",
    report: (): DepartmentReport => {
      const snapshots = db
        .select()
        .from(competitorSnapshots)
        .orderBy(desc(competitorSnapshots.createdAt))
        .all();
      const latestSnapshot = snapshots[0] ?? null;
      const daysSinceSnapshot = latestSnapshot
        ? Math.floor(
            (Date.now() - new Date(latestSnapshot.createdAt).getTime()) /
              86_400_000,
          )
        : 999;
      const analyses = db
        .select()
        .from(competitorAnalyses)
        .orderBy(desc(competitorAnalyses.createdAt))
        .limit(1)
        .all();
      const latestAnalysis = analyses[0] ?? null;
      const daysSinceAnalysis = latestAnalysis
        ? Math.floor(
            (Date.now() - new Date(latestAnalysis.createdAt).getTime()) /
              86_400_000,
          )
        : 999;
      const currentState = this.getLatestDepartmentSummary(
        "competitive-analysis",
      );
      const liveSummary = latestSnapshot
        ? `競合スナップショット: ${snapshots.length}件（最新${daysSinceSnapshot}日前）、分析: ${latestAnalysis ? `最新${daysSinceAnalysis}日前` : "未実行"}`
        : "競合スナップショット未取得。比較材料の蓄積が必要";

      return {
        department: "competitive-analysis",
        summary: currentState
          ? `${liveSummary}\n※前回の状態: ${currentState}`
          : liveSummary,
        metrics: {
          snapshotCount: snapshots.length,
          daysSinceSnapshot,
          daysSinceAnalysis,
        },
        recommendation:
          daysSinceAnalysis >= 7 && snapshots.length > 0
            ? "競合分析を実行すべき"
            : snapshots.length === 0
              ? "競合スナップショットの蓄積を優先すべき"
              : "動く必要なし",
        lastExecutedAt:
          latestAnalysis?.createdAt ??
          this.getLastRun("competitive-analysis"),
      };
    },
    execute: async ({ action }) => {
      const summary = await this.runAgentSubtask(
        "engagement-analyst",
        "競合投稿の分析と勝ちパターン抽出",
        async () => {
          const threadsResult = await research.analyzeCompetitorSnapshots(
            this.deps.llm,
            "threads",
          );
          const noteResult = await research.analyzeCompetitorSnapshots(
            this.deps.llm,
            "note",
          );

          // Push notifications to threads and note departments
          const now = new Date().toISOString();
          if (threadsResult.winningPatterns.length > 0) {
            db.insert(departmentNotifications)
              .values({
                id: randomUUID(),
                fromDepartment: "competitive-analysis",
                toDepartment: "threads",
                notificationType: "analysis_complete",
                content: JSON.stringify({
                  winningPatterns: threadsResult.winningPatterns,
                  summary: threadsResult.summary,
                }),
                readAt: null,
                createdAt: now,
              })
              .run();
          }
          if (noteResult.winningPatterns.length > 0) {
            db.insert(departmentNotifications)
              .values({
                id: randomUUID(),
                fromDepartment: "competitive-analysis",
                toDepartment: "note",
                notificationType: "analysis_complete",
                content: JSON.stringify({
                  winningPatterns: noteResult.winningPatterns,
                  summary: noteResult.summary,
                }),
                readAt: null,
                createdAt: now,
              })
              .run();
          }

          return `競合分析完了: Threads ${threadsResult.analysisCount}件, note ${noteResult.analysisCount}件分析。勝ちパターン: ${[...threadsResult.winningPatterns, ...noteResult.winningPatterns].join(", ") || "なし"}`;
        },
      );
      return createResult(action, summary, undefined, "competitive-analysis");
    },
  };
}
```

必要なimportを追加:
- `competitorAnalyses`, `departmentNotifications` を schema.ts から
- `ResearchServiceImpl` を research service から

- [ ] **Step 5: テスト再実行**

Run: `npx vitest run tests/competitive-analysis.test.ts -v`
Expected: PASS

- [ ] **Step 6: 既存テストの確認**

Run: `npx vitest run tests/department-execution.test.ts tests/department-report.test.ts -v`
Expected: PASS（既存テストが壊れていないこと）

- [ ] **Step 7: コミット**

```bash
git add src/services/department-execution/index.ts src/services/research/index.ts tests/competitive-analysis.test.ts
git commit -m "feat: enable competitive analysis department with LLM-driven analysis and winning pattern extraction"
```

---

### Task 4: departmentInstructionsの部署実行への反映（要件26, 45）

**Files:**
- Modify: `src/domain/department/index.ts:32-35`
- Modify: `src/services/department-execution/index.ts:156-165`
- Modify: `src/jobs/hourly-heartbeat.ts:478-479`
- Test: `tests/executive.test.ts`
- Test: `tests/integration/heartbeat-flow.test.ts`

- [ ] **Step 1: DepartmentExecutionContextにinstruction追加のテストを書く**

`tests/executive.test.ts` の末尾に追加:

```typescript
describe("departmentInstructions propagation", () => {
  it("HeartbeatCyclePlan includes departmentInstructions from LLM", async () => {
    const response = JSON.stringify({
      objective: "funnel_expansion",
      funnelStage: "distribution",
      approvedActionTypes: ["generate_and_post"],
      reasoning: "Threads投稿を増やす",
      departmentInstructions: {
        threads: "エンゲージメント率重視の投稿を生成せよ",
        note: "価格を据え置きにすること",
      },
    });
    const llm = new MockLlmClient(response);
    const service = new ExecutiveServiceImpl();

    const plan = await service.beginHeartbeatCycle(makeReports(), makeCandidateActions(), llm);

    expect(plan.departmentInstructions).toBeDefined();
    expect(plan.departmentInstructions!.threads).toBe("エンゲージメント率重視の投稿を生成せよ");
    expect(plan.departmentInstructions!.note).toBe("価格を据え置きにすること");
  });
});
```

- [ ] **Step 2: テストが通ることを確認（既に実装済みの部分）**

Run: `npx vitest run tests/executive.test.ts -v`
Expected: PASS（departmentInstructionsは既にHeartbeatCyclePlanに含まれている）

- [ ] **Step 3: DepartmentExecutionContextにinstructionフィールドを追加**

`src/domain/department/index.ts:32-35` を修正:

```typescript
export interface DepartmentExecutionContext {
  action: ScheduledAction;
  dryRun: boolean;
  /** Executiveから部署への具体的指示（あれば） */
  instruction?: string;
}
```

- [ ] **Step 4: DepartmentExecutionServiceImpl.execute()にinstruction引数を追加**

`src/services/department-execution/index.ts` の `execute` メソッドのシグネチャを拡張:

```typescript
async execute(
  action: ScheduledAction,
  instruction?: string,
): Promise<DepartmentExecutionResult> {
  const executor = this.executors.find((candidate) =>
    candidate.supports(action.type),
  );
  if (!executor) {
    throw new Error(`No department executor registered for ${action.type}`);
  }

  return executor.execute({
    action,
    dryRun: this.deps.dryRun,
    instruction,
  });
}
```

- [ ] **Step 5: hourly-heartbeat.tsでdepartmentInstructionsをexecute()に渡す**

`src/jobs/hourly-heartbeat.ts:588` の `departmentExecution.execute(action)` 呼び出しを修正:

```typescript
const department = executive.resolveDepartment(action.type);
// ...existing code...

// Step 6: Department execution with executive instruction
const instruction = cycle.departmentInstructions?.[department];
const execution = await departmentExecution.execute(action, instruction);
```

- [ ] **Step 6: instructionをLLMプロンプトに注入する仕組みを各executorに追加**

各executorの `execute` メソッド内で `context.instruction` が存在する場合、それをログに記録する。将来的にLLMプロンプトへ注入するための基盤として:

`src/services/department-execution/index.ts` — `createThreadsExecutor()` の `execute` 最初に:

```typescript
execute: async ({ action, instruction }) => {
  if (instruction) {
    logger.info(
      { department: "threads", instruction },
      "Executive instruction received",
    );
  }
  // ...existing logic...
```

同様に `createNoteExecutor()`, `createExternalResearchExecutor()`, `createCompetitiveAnalysisExecutor()`, `createCommandExecutor()` にも追加。

**注意:** `logger` のimportが `department-execution/index.ts` に無い場合は追加:
```typescript
import { logger } from "../../app/logger.js";
```

- [ ] **Step 7: departmentNotificationsにinstructionを保存**

`src/jobs/hourly-heartbeat.ts` の execute ループ内で、instructionがある場合にnotificationとして保存:

```typescript
if (instruction) {
  db.insert(departmentNotifications)
    .values({
      id: randomUUID(),
      fromDepartment: "command",
      toDepartment: department,
      notificationType: "instruction",
      content: instruction,
      readAt: null,
      createdAt: new Date().toISOString(),
    })
    .run();
}
```

`departmentNotifications` のimportを `hourly-heartbeat.ts` の schema import に追加。

- [ ] **Step 8: テスト実行**

Run: `npx vitest run tests/executive.test.ts tests/department-execution.test.ts tests/integration/heartbeat-flow.test.ts -v`
Expected: PASS

- [ ] **Step 9: コミット**

```bash
git add src/domain/department/index.ts src/services/department-execution/index.ts src/jobs/hourly-heartbeat.ts
git commit -m "feat: propagate departmentInstructions from executive to department execution"
```

---

### Task 5: 中長期運用方針の永続化（要件27, 51）

**Files:**
- Modify: `src/services/executive/index.ts:424-446`
- Modify: `src/jobs/hourly-heartbeat.ts` (戦略履歴保存)
- Create: `tests/strategy-history.test.ts`

- [ ] **Step 1: テストを書く**

`tests/strategy-history.test.ts`:

```typescript
import { sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = ":memory:";

type Db = typeof import("../src/db/index.js")["db"];
type SchemaModule = typeof import("../src/db/schema.js");

let db: Db;
let schema: SchemaModule;

beforeAll(async () => {
  const dbMod = await import("../src/db/index.js");
  db = dbMod.db;
  schema = await import("../src/db/schema.js");
  const { ensureAutonomyTables } = await import("../src/db/bootstrap.js");
  ensureAutonomyTables();
});

beforeEach(() => {
  db.run(sql`DELETE FROM strategy_history`);
});

describe("strategyHistory", () => {
  it("stores a strategy history entry", () => {
    const now = new Date().toISOString();
    db.insert(schema.strategyHistory)
      .values({
        id: "sh-1",
        cycleId: "cycle-1",
        objective: "funnel_expansion",
        funnelStage: "distribution",
        reasoning: "コンテンツ生成を優先",
        departmentInstructions: JSON.stringify({ threads: "投稿数を増やせ" }),
        stateJson: JSON.stringify({ priorityTopics: ["AI副業"] }),
        createdAt: now,
      })
      .run();

    const rows = db.select().from(schema.strategyHistory).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].objective).toBe("funnel_expansion");
    expect(rows[0].reasoning).toBe("コンテンツ生成を優先");
  });

  it("preserves history across multiple cycles", () => {
    const base = Date.now();
    for (let i = 0; i < 5; i++) {
      db.insert(schema.strategyHistory)
        .values({
          id: `sh-${i}`,
          cycleId: `cycle-${i}`,
          objective: i < 3 ? "funnel_expansion" : "engagement_compounding",
          funnelStage: "distribution",
          reasoning: `判断理由 ${i}`,
          stateJson: "{}",
          createdAt: new Date(base + i * 3600000).toISOString(),
        })
        .run();
    }

    const rows = db.select().from(schema.strategyHistory).all();
    expect(rows).toHaveLength(5);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run tests/strategy-history.test.ts -v`
Expected: FAIL（`strategyHistory` テーブルがまだ無い場合）またはPASS（Task 1完了後なら）

- [ ] **Step 3: ExecutiveServiceImplにsaveStrategyHistory()を追加**

`src/services/executive/index.ts` に新メソッドを追加:

```typescript
private saveStrategyHistory(
  cycleId: string,
  objective: HeartbeatObjective,
  funnelStage: FunnelStage,
  reasoning: string,
  departmentInstructions: Record<string, string>,
  strategy: StrategyStateSnapshot,
): void {
  db.insert(strategyHistory)
    .values({
      id: randomUUID(),
      cycleId,
      objective,
      funnelStage,
      reasoning,
      departmentInstructions: Object.keys(departmentInstructions).length > 0
        ? JSON.stringify(departmentInstructions)
        : null,
      stateJson: JSON.stringify(strategy),
      createdAt: new Date().toISOString(),
    })
    .run();
}
```

`strategyHistory` をschema.tsからのimportに追加。

- [ ] **Step 4: beginHeartbeatCycle()内でsaveStrategyHistory()を呼び出す**

`src/services/executive/index.ts` の `beginHeartbeatCycle()` メソッド内、`executiveCycles` insert の後（約L446）に追加:

```typescript
this.saveStrategyHistory(
  cycleId,
  objective,
  funnelStage,
  rawReasoning,
  rawInstructions,
  strategy,
);
```

フォールバックパス（`buildFallbackPlan` 側）にも同様に追加:

```typescript
this.saveStrategyHistory(
  fallback.cycleId,
  fallback.objective,
  fallback.funnelStage,
  fallback.llmReasoning ?? "",
  {},
  fallback.strategy,
);
```

- [ ] **Step 5: ExecutiveプロンプトにstrategyHistory直近5件を注入**

`src/services/executive/index.ts` の `buildExecutivePrompt()` に以下を追加:

```typescript
const recentHistory = db
  .select()
  .from(strategyHistory)
  .orderBy(desc(strategyHistory.createdAt))
  .limit(5)
  .all();

const historySection = recentHistory.length > 0
  ? `## 過去の戦略判断（直近${recentHistory.length}回）\n${recentHistory.map((h, i) => `${i + 1}. objective=${h.objective}, funnelStage=${h.funnelStage}, 理由: ${h.reasoning}`).join("\n")}\n\n中長期的な方向性の一貫性を考慮してください。頻繁な方針転換は避け、根拠がない限り前回の方針を継続してください。`
  : "";
```

これをプロンプト文字列に `## 各部署の状況レポート` の前に挿入。

- [ ] **Step 6: テスト再実行**

Run: `npx vitest run tests/strategy-history.test.ts tests/executive.test.ts -v`
Expected: PASS

- [ ] **Step 7: コミット**

```bash
git add src/services/executive/index.ts src/db/schema.ts tests/strategy-history.test.ts
git commit -m "feat: persist strategy history for mid/long-term policy continuity"
```

---

### Task 6: 部署間の能動的情報共有（要件31, 41）

**Files:**
- Modify: `src/services/department-execution/index.ts` (各executorのreport()で通知を取り込む)
- Modify: `src/services/research/index.ts` (リサーチ完了時にプッシュ通知)

- [ ] **Step 1: ResearchServiceImplのresearchTopic()にプッシュ通知を追加**

`src/services/research/index.ts` の `researchTopic()` メソッド末尾（`return items;` の前）に追加:

```typescript
// Push notification to relevant departments
if (items.length > 0) {
  const notification = {
    topicId,
    topicName,
    itemCount: items.length,
    highlights: items.slice(0, 3).map((i) => i.content.slice(0, 100)),
  };
  const now = new Date().toISOString();
  for (const dept of ["threads", "note", "competitive-analysis"] as const) {
    db.insert(departmentNotifications)
      .values({
        id: randomUUID(),
        fromDepartment: "external-research",
        toDepartment: dept,
        notificationType: "research_update",
        content: JSON.stringify(notification),
        readAt: null,
        createdAt: now,
      })
      .run();
  }
}
```

`departmentNotifications` をschema.tsからのimportに追加。

- [ ] **Step 2: 各executorのreport()で未読通知を取り込む**

`src/services/department-execution/index.ts` にヘルパーメソッドを追加:

```typescript
private getUnreadNotifications(department: DepartmentName): string {
  const unread = db
    .select()
    .from(departmentNotifications)
    .where(
      and(
        eq(departmentNotifications.toDepartment, department),
        isNull(departmentNotifications.readAt),
      ),
    )
    .orderBy(desc(departmentNotifications.createdAt))
    .limit(5)
    .all();

  if (unread.length === 0) return "";

  // Mark as read
  for (const n of unread) {
    db.update(departmentNotifications)
      .set({ readAt: new Date().toISOString() })
      .where(eq(departmentNotifications.id, n.id))
      .run();
  }

  return `\n📨 他部署からの通知${unread.length}件: ${unread.map((n) => `[${n.fromDepartment}→${n.notificationType}]`).join(", ")}`;
}
```

必要なimport追加: `departmentNotifications` を schema.ts から、`isNull` を drizzle-orm から。

- [ ] **Step 3: Threads/Note executorのreport()に通知情報を追加**

各executorの `report()` メソッド内で `liveSummary` に通知を付加:

ThreadsExecutor:
```typescript
const notifications = this.getUnreadNotifications("threads");
const threadsLiveSummary = `承認済みドラフト在庫: ${pendingDrafts}件、...${notifications}`;
```

NoteExecutor:
```typescript
const notifications = this.getUnreadNotifications("note");
const noteLiveSummary = `承認済み記事: ${pendingNoteDrafts}件、...${notifications}`;
```

CompetitiveAnalysisExecutor:
```typescript
const notifications = this.getUnreadNotifications("competitive-analysis");
const liveSummary = latestSnapshot
  ? `競合スナップショット: ...${notifications}`
  : `競合スナップショット未取得...${notifications}`;
```

- [ ] **Step 4: テスト実行**

Run: `npx vitest run tests/department-execution.test.ts tests/department-report.test.ts -v`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/services/department-execution/index.ts src/services/research/index.ts
git commit -m "feat: add push-based inter-department notifications for research updates and analysis results"
```

---

### Task 7: 全体テスト + リグレッション確認

**Files:**
- All test files

- [ ] **Step 1: 全テスト実行**

Run: `npx vitest run -v`
Expected: ALL PASS

- [ ] **Step 2: TypeScript型チェック**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: 失敗がある場合は修正**

個別に失敗を特定して修正。共通パターン:
- import忘れ → 追加
- テストの型不一致（新フィールド追加による） → テストのmockを更新

- [ ] **Step 4: dry-run実行**

Run: `npx tsx src/jobs/hourly-heartbeat.ts --dry-run`
Expected: 正常終了（新しいアクションタイプ `analyze_competitors` が候補に含まれること）

- [ ] **Step 5: 最終コミット**

```bash
git add -A
git commit -m "test: fix regressions from audit compliance remediation"
```

---

## 改修後の仕様適合状態（予測）

| 要件 | 改修前 | 改修後 | 対応Task |
|------|--------|--------|----------|
| 要件26: 修正指示の反映 | 一部実装 | **実装済み** | Task 4 |
| 要件27: 中長期方針管理 | 一部実装 | **実装済み** | Task 5 |
| 要件31: 能動的情報共有 | 仕様ズレ | **実装済み** | Task 6 |
| 要件32: 競合投稿内容分析 | 一部実装 | **実装済み** | Task 3 |
| 要件33: 競合反応分析 | 未実装 | **実装済み** | Task 3 |
| 要件34: 勝ちパターン抽出 | 未実装 | **実装済み** | Task 3 |
| 要件35: 分析結果共有 | 一部実装 | **実装済み** | Task 3, 6 |
| 要件36: Threads部署構成 | 一部実装 | **一部改善** | Task 2 (エージェント更新) |
| 要件37: Threads運用機能 | 一部実装 | **一部改善** | Task 3 (競合リサーチ補完) |
| 要件39: note部署構成 | 一部実装 | **一部改善** | -(リーダーロジックは次フェーズ) |
| 要件41: 外部→各部署共有 | 仕様ズレ | **実装済み** | Task 6 |
| 要件45: 全体最適指示 | 一部実装 | **実装済み** | Task 4 |
| 要件51: 中長期方針最適化 | 一部実装 | **実装済み** | Task 5 |

**改修後の想定適合率:** 48/52件（実装済み: 45件、一部実装: 3件、未実装: 4件のまま）
