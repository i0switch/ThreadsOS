# ThreadsOS 最終設計図

## 0. 一文での定義
**ThreadsOS は、Node.js + TypeScript + SQLite + Playwright + PM2 を本体にしたローカル常駐の deterministic な運用OSであり、Claude Code / Codex CLI / Copilot CLI を pluggable な推論ワーカーとして役割別ルーティングし、売上ファネル最適化ループを完全自律で回す。**

---

## 1. 固定する前提
- 5部署構造は維持
- 完全自律
- 人間非介入
- LLM はサブスクCLI経由
- human_review 全廃
- 本体は収益閉ループ
- 部署は人格ではなく実行ユニット
- CLI を OS にしない
- DB が唯一の状態管理・通信路

---

## 2. 全体アーキテクチャ

```text
┌─────────────────────────────────────────────────────────────┐
│ Scheduler Layer                                             │
│ PM2常駐 + Windows Task Scheduler(復旧保険)                  │
│ 15m / 1h / 1d / 1w で ThreadsOS Job を起動                  │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ ThreadsOS Core (Node.js + TS)                               │
│ - job orchestration                                          │
│ - queue / retry / quarantine / rollback                      │
│ - funnel diagnosis                                           │
│ - experiment selection                                       │
│ - state management                                           │
│ - policy guard                                               │
│ - session health                                             │
└───────────────┬──────────────────────────┬──────────────────┘
                │                          │
                ▼                          ▼
┌──────────────────────────────┐  ┌───────────────────────────┐
│ Execution Adapters           │  │ LLM Runner Abstraction    │
│ - Playwright(note)           │  │ - ClaudeCodeRunner        │
│ - Threads Graph API          │  │ - CodexCLIRunner          │
│ - Local file/session ops     │  │ - CopilotCLIRunner        │
└───────────────┬──────────────┘  └──────────────┬────────────┘
                │                                │
                └──────────────┬─────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ SQLite State                                                │
│ funnel_metrics / campaigns / posts / notes / experiments    │
│ winning_patterns / revenue_events / session_health / assets │
└─────────────────────────────────────────────────────────────┘
```

既存 repo も `job:heartbeat`、`job:daily-*`、`job:nightly-note-pipeline`、`job:weekly-retro`、`start:daemon` をすでに持っているため、この方向が自然な進化になる。  
参考: README でも Node.js + TypeScript + SQLite + Playwright + PM2 が現行スタックとして定義されている。fileciteturn55file0

---

## 3. スケジューリング仕様

### 15分ごと
LLM呼び出しなし。TypeScriptだけで回す。

- session health check
- Threads metrics sync
- note metrics / 売上 sync
- token refresh check
- error scan
- quarantine queue check

### 1時間ごと
収益改善の中核。

- funnel diagnosis
- bottleneck を1つだけ選定
- experiment を1つだけ実行
- Threads投稿 / reply / note導線更新
- 24h後採点タスク登録

### 1日ごと
- note生成 / 公開
- 翌日のテーマ配分更新
- winning pattern の資産化
- 負け型の停止候補整理

### 1週ごと
- 価格最適化
- テーマ配分の再編
- 長期失敗パターン削除
- strategy summary 更新

### 原則
**1時間 heartbeat = 1ボトルネック改善だけやる。**  
毎回全部署をフル稼働させない。

---

## 4. 売上ファネル定義
最低この6段を固定する。

1. `impressions`
2. `profile_transitions`
3. `note_clicks`
4. `note_views`
5. `purchases`
6. `revenue`

ThreadsOS の司令塔は、この6段のうち  
**いま一番弱い段を1つだけ改善対象にする。**

---

## 5. LLM Runner 抽象層
LLMは差し替え可能にする。  
主系固定ではなく、役割別ルーティング。

### 共通I/O
```ts
type RunnerTask = {
  task_type:
    | "funnel_advice"
    | "threads_generation"
    | "note_generation"
    | "reply_generation"
    | "audit"
    | "strategy_review"
    | "failure_analysis";
  tier: "light" | "medium" | "heavy";
  role:
    | "executive"
    | "research"
    | "competitor"
    | "threads"
    | "note"
    | "auditor";
  json_schema: Record<string, unknown>;
  context_bundle: Record<string, unknown>;
};

type RunnerResult = {
  decision: string;
  confidence: number;
  reasons: string[];
  artifacts: Record<string, unknown>;
  next_actions: string[];
};
```

### 実装
- `ClaudeCodeRunner`
- `CodexCLIRunner`
- `CopilotCLIRunner`

### fallback
- timeout → 副系へ
- JSON不正 → 1回だけ再生成
- 2回失敗 → safe fallback
- confidence 低 → 実行しない

---

## 6. 役割別ルーティング

### Claude Code
主系。

- note長文生成
- audit
- strategy要約
- 少し重い判断
- executive補助

### Codex CLI
副系。

- JSON厳格出力
- 構造化変換
- 変種生成
- failure analysis
- Claude timeout時の代替

### Copilot CLI
予備。

- 軽量な文面修正
- 補助調査
- 簡易fallback

### 原則
**単独固定じゃなく、役割別ルーティング。**

---

## 7. 部署仕様
部署構造は維持する。

- 管理・指揮系統
- 外部リサーチ部署
- 競合リサーチ分析部署
- Threads運用部署
- note運用部署
- 監査機能

ただし実装上は**人格会話しない**。  
全部 **契約ワーカー** にする。

### 各部署が持つもの
- 入力JSON
- 出力JSON
- success criteria
- forbidden
- llm_budget
- confidence rule
- fallback rule

### frontmatter 例
```yaml
name: threads-publisher
role: Threads投稿実行ユニット
input_schema:
  bottleneck: string
  target_note: object
  winning_patterns: array
  competitor_diff: array
output_schema:
  posts:
    - hook: string
      body: string
      cta: string
      schedule_ts: string
success_criteria: profile_transition_rate > baseline * 1.1
forbidden:
  - 誇大表現
  - 規約違反
  - 曖昧CTA
llm_budget: 1_call_per_invocation
fallback: auto-skip
```

---

## 8. ディレクトリ構成
`.claude/agents` を正本にしない。  
ベンダー中立で持つ。

```text
/agents
  executive.md
  research.md
  competitor.md
  threads.md
  note.md
  auditor.md

/playbooks
  funnel-diagnosis.md
  experiment-selection.md
  threads-generation.md
  note-generation.md
  reply-generation.md
  rollback-policy.md

/policies
  brand.md
  safety.md
  pricing.md
  monetization.md
```

必要なら各CLI向けに変換して使う。  
**正本は vendor-neutral。**

---

## 9. SQLite スキーマ

### 既存強化 + 追加
最低ほしい主要テーブル群。

- `campaigns`
- `drafts`
- `posts`
- `notes`
- `funnel_snapshots`
- `funnel_metrics`
- `threads_metrics`
- `note_metrics`
- `revenue_events`
- `winning_patterns`
- `experiments`
- `experiment_results`
- `agent_artifacts`
- `session_health`
- `pricing_variants`
- `rollbacks`
- `executive_decisions`

### 既存テーブルに追加するキー
- `campaign_id`
- `angle_id`
- `cta_id`
- `price_variant_id`

これがないと、
何が売れたか、
どの角度が効いたか、
どのCTAが弱いか、
が取れない。

---

## 10. 実験エンジン

### ループ
1. ファネル集計
2. 最弱段特定
3. その段に効く仮説を3つ出す
4. 低リスク高期待値を1つ選ぶ
5. 実行
6. 24h / 72h で採点
7. 勝ち型を資産DBに保存
8. 負け型を停止

### 実験対象
- hook
- CTA
- 投稿時間
- noteタイトル
- note導入
- 価格
- 導線文
- テーマ切り口

### 学習
- Thompson Sampling か軽量bandit
- 初期は seed hypothesis を priors として投入

---

## 11. Executive Engine
今の「最大3アクション」骨格は活かす。  
ただし入力を funnel 駆動に変える。

### 入力
- current funnel summary
- weakest stage
- current active experiments
- winning patterns
- recent failures
- session health
- budget status

### 出力
- 実行する改善対象 1つ
- 実行アクション 最大3つ
- 優先度
- deploy可否
- rollback条件

---

## 12. 安全仕様
human_review は廃止。  
代わりに4択だけ持つ。

- `auto-execute`
- `auto-rewrite`
- `auto-skip`
- `auto-quarantine`

### 追加ルール
- confidence低 → 実行しない
- session異常 → note系停止
- purchase / CTR 急落 → 直前の勝ち型に rollback
- 連続失敗 → その戦術を quarantine

**迷ったら人間に上げる** は禁止。  
**迷ったら止める or 安全化する**。

---

## 13. note / Threads 観測

### note
- Playwright
- 既存 `note-storage-state.json` 利用
- 売上ダッシュボード取得
- 閲覧 / 購入 / 売上を article 単位で回収
- storage state 失効時は自動降格

### Threads
- Graph API insights
- post 単位で metrics 回収
- `campaign_id / angle_id / cta_id` と必ず紐付け

---

## 14. 常駐・復旧

### 常駐
- PM2 を主
- `start:daemon` を使う

### 保険
- Windows Task Scheduler で再起動復旧
- 異常終了時の PM2 再起動
- ログローテーション

### 原則
**Task Scheduler が直接 CLI LLM を叩かない。**  
**Task Scheduler / PM2 は ThreadsOS job を起動するだけ。**

---

## 15. OpenClaw の扱い
本体には入れない。  
今は不要。

使うなら将来、
- 外部ワーカー管理
- 別マシン実行
- 監視基盤拡張

だけ。

---

## 16. 実装順

### Phase 0
- `llm_runner` 抽象層
- runner共通I/O
- vendor-neutral contracts

### Phase 1
- 6段ファネルSQLite
- asset DB
- campaign / angle / cta キー追加

### Phase 2
- note売上スクレイパ
- session health / 自動降格

### Phase 3
- Threads insights 回収
- tracking 紐付け

### Phase 4
- 15m / 1h / 1d / 1w job 分割
- PM2常駐に統合

### Phase 5
- human_review 全廃
- auto-rewrite / skip / quarantine / rollback

### Phase 6
- Executive Engine funnel駆動化

### Phase 7
- `/agents /playbooks /policies` 契約化

### Phase 8
- ダッシュボードを承認UIから観測UIへ変更

---

## 17. 最終結論
**ThreadsOS の最終設計図は、ローカル常駐の deterministic な運用OSを本体にし、CLI型LLMを差し替え可能な思考ワーカーとして扱い、売上ファネル最適化ループを完全自律で回す構成。**

言い切るとこれ。

**本体が OS、LLM は脳の一部。**  
**CLI を OS にしない。**  
**収益閉ループを DB 駆動で回す。**
