# ダッシュボード人間語化 修正案 v2

## 問題

現在のダッシュボードは「データが表示されている」だけで「人間が読んで直感的に分かる」状態になっていない。

具体的な問題:
1. ファネルプレビューが内部用語（「監査を通過」「Note schedule optimized」「自動処理停止」）
2. ハートビート履歴が `threads | generate_and_post | completed` というエンジニアログ
3. 14人のエージェントが「誰が」「何をした」の日本語文で表示されていない
4. departmentInstructionsは部署ID（`competitive-analysis`）で表示されていて日本語部署名じゃない

## ゴール

ダッシュボードの全テキストを**普通の人が読んで分かる日本語**にする。

---

## 修正1: ファネルプレビューの人間語化

### 現在（APIレスポンス）

```json
{
  "threadsAction": "投稿案を15件作成し、13件が監査を通過 Threads投稿を1件自動公開",
  "noteAction": "note下書きを1件作成 note記事を0件自動公開 Note schedule optimized 進捗共有を送信",
  "blocker": "1件の自動処理停止が残っている"
}
```

### あるべき姿

```
Threads: 15件作って1件公開した
note: 下書き1件。まだ公開できてない
ボトルネック: noteの記事公開が進んでいない
```

### 対象ファイル・方針

ファイル: `src/dashboard/public/index.html` のレンダリング関数

`threadsAction` / `noteAction` は `getDashboardFunnel()` の内部計算結果（stages[].headline）から生成されたテキスト。元テキストが技術的すぎるため、**フロント側で正規表現パースして人間語に変換する**。

```javascript
function humanizeFunnel(fp) {
  // threadsAction から数字を抽出して人間語に
  const tm = fp.threadsAction?.match(/(\d+)件.*?(\d+)件.*?通過.*?(\d+)件.*?公開/);
  const threads = tm ? `${tm[1]}件作って${tm[3]}件公開した` : fp.threadsAction;

  // noteAction から数字を抽出
  const nm = fp.noteAction?.match(/(\d+)件.*?作成.*?(\d+)件.*?公開/);
  const note = nm
    ? (Number(nm[2]) > 0 ? `${nm[2]}件公開した` : `下書き${nm[1]}件。まだ公開できてない`)
    : fp.noteAction;

  // blocker
  const blocker = fp.blocker
    ?.replace(/自動処理停止/g, '処理の停滞')
    ?.replace(/が残っている/g, 'がある') ?? null;

  return { threads, note, blocker };
}
```

---

## 修正2: ハートビート履歴の人間語化

### 現在

```
2026/4/12 9:54:21  funnel_expansion

note への指示: note記事を1本生成して即座にスケジュール登録せよ…
threads への指示: 12件のスロットに対して新規ドラフトを最大5件生成して…

実行結果
  threads | generate_and_post | completed | Generated 15 drafts, 13 passed audit…
```

### あるべき姿

```
4/12 09:54 — ファネル拡大フェーズ

📋 総合指揮官の判断
  note運用への指示: 記事1本を生成して即公開準備に入れ
  Threads運用への指示: 12枠のうち5件のドラフトを生成しろ
  競合リサーチ分析への指示: 既存データで即分析しろ
  外部リサーチは今回お休み

🏢 部署の動き
  Threads運用
    Threads投稿生成員: 15件の投稿を作り、13件が合格、1件を公開した
  note運用
    (この回では実行なし)
```

### 対象ファイル・方針

**API側 (`dashboard-query/index.ts`):**

#### ラベルマップ

既存の `DEPARTMENT_DISPLAY_NAMES` (L105付近) と `humanizeInternalText()` (L197-246) が既にある。**新しいマップを作るのではなく、既存を拡張する。**

`humanizeInternalText()` に以下のActionType変換を追加（現在欠けている6つ）:

```typescript
// L219-225 付近の既存ActionType変換に追加:
.replace(/\banalyze_competitors\b/g, "競合分析の実行")
.replace(/\bfetch_competitor_updates\b/g, "競合データの更新")
.replace(/\boptimize_schedule\b/g, "投稿スケジュールの最適化")
.replace(/\bweekly_retro\b/g, "週次振り返り")
.replace(/\bnotify\b/g, "進捗通知の送信")
.replace(/\bprocess_human_inputs\b/g, "ユーザー入力の処理")
```

OBJECTIVE_LABELS は新規追加（`HeartbeatObjective` 型 `src/domain/department/index.ts` L15-18 に基づく正確な値）:

```typescript
const OBJECTIVE_LABELS: Record<string, string> = {
  directive_assimilation: "指示吸収フェーズ",
  funnel_expansion: "ファネル拡大フェーズ",
  engagement_compounding: "エンゲージメント強化フェーズ",
};
```

ACTION_LABELS は新規追加（全12 ActionType、`content-scheduler/index.ts` L23-36 に基づく）:

```typescript
const ACTION_LABELS: Record<string, string> = {
  generate_and_post: "Threads投稿の生成と公開",
  generate_note: "note記事の生成",
  fetch_engagement: "エンゲージメントの取得",
  reply_safe: "安全なリプライの送信",
  optimize_schedule: "投稿スケジュールの最適化",
  research_threads: "Threadsテーマのリサーチ",
  research_note: "note競合のリサーチ",
  analyze_competitors: "競合分析の実行",
  fetch_competitor_updates: "競合データの更新",
  weekly_retro: "週次振り返り",
  notify: "進捗通知の送信",
  process_human_inputs: "ユーザー入力の処理",
};
```

DEPT_LABELS は既存の `DEPARTMENT_DISPLAY_NAMES` を使う（「部署」は付けない。既存と一貫性を取る）:

```typescript
// 既存の DEPARTMENT_DISPLAY_NAMES (L105付近) をそのまま使う:
// command: "管理・指揮系統"
// "external-research": "外部リサーチ"
// "competitive-analysis": "競合リサーチ分析"
// threads: "Threads運用"
// note: "note運用"
```

#### エージェント単位の活動取得

**agent_states.lastActiveAt のクエリは使わない。** `setStatus()` が毎回 `lastActiveAt: nowIso()` をセットするため、ほぼ全エージェントが毎サイクルでヒットしてしまう。

正しい方法: **`department_runs` テーブルの `cycle_id` でJOINし、各 run の `department` + `phase`（actionType）から `resolveAgents()` のロジックで担当エージェントを逆引きする。**

`getHeartbeatHistory()` 内で:

```typescript
// 既にcycle_idでdepartment_runsを取得済み (L3876-3887)
// 各runに対して、AGENTS配列からpreferredWorkersマッピングで担当エージェントを逆引き
import { AGENTS } from "../runtime-state/index.js";

// preferredWorkersマッピング（runtime-state/index.ts L173-184と同じ）
const PREFERRED_WORKERS: Partial<Record<string, string>> = {
  research_threads: "trend-researcher",
  research_note: "note-competitor-researcher",
  generate_and_post: "threads-post-generator",
  generate_note: "note-article-generator",
  fetch_engagement: "threads-engagement-analyst",
  reply_safe: "threads-reply-generator",
  weekly_retro: "threads-operations-director",
  optimize_schedule: "threads-operations-director",
  notify: "executive-director",
  process_human_inputs: "executive-director",
  analyze_competitors: "engagement-analyst",
  fetch_competitor_updates: "threads-competitor-researcher",
};

function resolveAgentName(actionType: string): string {
  const agentId = PREFERRED_WORKERS[actionType];
  const agent = agentId ? AGENTS.find(a => a.id === agentId) : null;
  return agent?.name ?? "不明";
}
```

各runに `agentName` フィールドを追加:

```typescript
.map((run) => ({
  department: DEPARTMENT_DISPLAY_NAMES[run.department] ?? run.department,
  actionType: ACTION_LABELS[run.phase] ?? run.phase,
  status: run.status,
  summary: humanizeInternalText(run.summary ?? ""),
  agentName: resolveAgentName(run.phase),
}));
```

#### run.summary の人間語変換

**新関数は作らない。既存の `humanizeInternalText()` (L197-246) を使う。** この関数は既に以下のパターンをカバーしている:

- `Generated (\d+) drafts, (\d+) passed audit.` → 日本語
- `Auto-published (\d+) threads posts` → 日本語
- `Generated (\d+) note drafts.` → 日本語
- `Note schedule optimized` → 日本語
- `Progress notification sent` → 日本語
- etc.

#### getHeartbeatHistory() の変更まとめ

```typescript
export function getHeartbeatHistory() {
  const cycles = db.select().from(s.executiveCycles)
    .orderBy(desc(s.executiveCycles.createdAt)).limit(10).all();

  return {
    cycles: cycles.map((cycle) => {
      const runs = db.select().from(s.departmentRuns)
        .where(eq(s.departmentRuns.cycleId, cycle.id))
        .orderBy(asc(s.departmentRuns.createdAt)).all()
        .map((run) => ({
          department: DEPARTMENT_DISPLAY_NAMES[run.department] ?? run.department,
          actionType: ACTION_LABELS[run.phase] ?? run.phase,
          status: run.status,
          summary: humanizeInternalText(run.summary ?? ""),
          agentName: resolveAgentName(run.phase),   // NEW
        }));

      // Parse decision_json
      let reasoning: string | null = null;
      let departmentInstructions: Record<string, string> | null = null;
      if (cycle.decisionJson) {
        try {
          const decision = JSON.parse(cycle.decisionJson);
          reasoning = decision.reasoning ?? null;
          // departmentInstructions のキーを日本語化
          if (decision.departmentInstructions) {
            departmentInstructions = {};
            for (const [k, v] of Object.entries(decision.departmentInstructions)) {
              const label = DEPARTMENT_DISPLAY_NAMES[k] ?? k;
              departmentInstructions[label] = v as string;
            }
          }
        } catch { /* ignore */ }
      }

      return {
        id: cycle.id,
        objective: OBJECTIVE_LABELS[cycle.objective] ?? cycle.objective,  // NEW: 日本語化
        funnelStage: cycle.funnelStage,
        summary: humanizeInternalText(cycle.summary ?? ""),  // NEW: 人間語化
        reasoning,
        departmentInstructions,  // キーが日本語化済み
        createdAt: cycle.createdAt,
        runs,  // department/actionType/summary/agentName 全て日本語化済み
      };
    }),
  };
}
```

### フロント側 (`index.html`)

`renderHistory()` を書き換え。**APIからデータが既に日本語化済みで返るため、フロント側は表示するだけ。**

レンダリング構造:

```html
<div class="cycle">
  <div class="cycle-header">4/12 09:54 — ファネル拡大フェーズ</div>

  <!-- 総合指揮官の判断 -->
  <div class="executive-section">
    📋 総合指揮官の判断
    <!-- reasoning があれば表示 -->
    <div class="reasoning">判断理由テキスト</div>
    <!-- departmentInstructions: キーが日本語部署名で返る -->
    <div>note運用への指示: ...</div>
    <div>Threads運用への指示: ...</div>
  </div>

  <!-- 各部署の動き（エージェント単位） -->
  <!-- runs を department でグループ化し、agentName で表示 -->
  <div class="department-section">
    🏢 Threads運用
    <div>Threads投稿生成員: 15件の投稿を作り、13件が合格、1件を公開した</div>
  </div>
  <div class="department-section">
    🏢 note運用
    <div>note記事生成員: 下書き1件を作成した</div>
  </div>
</div>
```

---

## 修正3: departmentInstructionsのキーを日本語化

修正2に統合済み。`getHeartbeatHistory()` 内で `DEPARTMENT_DISPLAY_NAMES` を使ってキーを変換してからレスポンスに含める。

---

## 修正4: heroセクション + currentPolicy の人間語化

### 現在

```json
{
  "currentPolicy": "ファネル拡大 → 立ち上げ → 実行内容:投稿を作成して公開, note記事生成, analyze_competitors"
}
```

### 問題

- `currentPolicy` に `analyze_competitors` 等の英語ActionTypeが混入
- `humanizeInternalText()` (L219-225) に `analyze_competitors`, `fetch_competitor_updates`, `optimize_schedule`, `weekly_retro`, `notify`, `process_human_inputs` の6つが未登録

### 方針

`humanizeInternalText()` に欠けている6つのActionTypeパターンを追加する（修正2のラベルマップ追加と同時に実施）。これにより `currentPolicy` テキストも自動的に日本語化される（`getSummary()` L1186 で `humanizePolicyText()` → `humanizeInternalText()` が呼ばれるため）。

---

## 変更対象ファイル

| ファイル | 変更内容 |
|---|---|
| `src/services/dashboard-query/index.ts` | `OBJECTIVE_LABELS`, `ACTION_LABELS` を追加。`humanizeInternalText()` に6 ActionType追加。`getHeartbeatHistory()` にagentName追加 + 全テキスト日本語化。departmentInstructionsキー日本語化 |
| `src/dashboard/public/index.html` | `renderHistory()` を部署→エージェント階層表示に書き換え。`renderKpi()` のファネルプレビューを `humanizeFunnel()` で変換 |

## 実装順序

1. `dashboard-query/index.ts` に `OBJECTIVE_LABELS`, `ACTION_LABELS` を追加
2. `humanizeInternalText()` に欠けている6 ActionTypeパターンを追加
3. `getHeartbeatHistory()` を拡張（agentName逆引き + 全フィールド日本語化 + departmentInstructionsキー変換）
4. `index.html` の `renderHistory()` を階層表示に書き換え
5. `index.html` の `renderKpi()` ファネルプレビューに `humanizeFunnel()` 追加
6. ブラウザで**人間目線で**確認（技術用語が残っていないか、「誰が何をした」が直感的に読めるか）

## 制約

- エージェントIDは英語のまま（内部キー）
- 表示名だけ日本語化
- 新関数は最小限。既存の `humanizeInternalText()` と `DEPARTMENT_DISPLAY_NAMES` を活用
- `resolveAgentName()` は `PREFERRED_WORKERS` マッピングで逆引き（`runtime-state/index.ts` の `preferredWorkers` と同じマッピング）
- 未知のパターンはそのまま表示（壊れない）
