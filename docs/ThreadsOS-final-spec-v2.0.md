# ThreadsOS 最終設計図 v2.0

**確定日**: 2026-04-14  
**位置づけ**: v1 系統の統合強化版  
**目的**: 収益最適化ループを、完全自律・人間非介入・サブスクCLI LLM縛りのまま、より壊れにくく、再現性高く、運用事故に強い形へ引き上げる

---

## 1. 一行定義

**ThreadsOS = Node.js + TypeScript + SQLite + Playwright + PM2 を本体にしたローカル常駐OSが、状態管理・実行管理・収益判定・安全制御を握り、Claude Code / Codex CLI / Copilot CLI を pluggable な推論ワーカーとして役割別ルーティングし、売上ファネル最適化ループを完全自律で回す収益運用基盤。**

短く言うとこう。

> **骨格は deterministic、思考だけ CLI LLM に委譲**

---

## 2. v2.0 で追加した強化点

v1 系の設計はかなり強かったが、v2.0 ではさらに以下を追加する。

1. **Job Lease / Idempotency**
   - PM2再起動やTask Scheduler再実行で heartbeat が重複しても二重投稿しない
2. **Outbox Pattern**
   - 投稿予定と実投稿を分離し、失敗時も再送・監査ができる
3. **Runner Budget Governor**
   - Claude / Codex / Copilot ごとの日次・時間帯予算を DB で管理
4. **Runner Circuit Breaker**
   - 連続失敗やJSON崩壊が続いた runner は自動隔離
5. **Degrade Modes**
   - note停止時も Threads 側だけで回るなど、部分停止でOS全停止を防ぐ
6. **Decision Evidence Ledger**
   - すべての意思決定に「なぜそうしたか」の証跡を残す
7. **Contract Compiler**
   - `agents/` `playbooks/` `policies/` を起動前に lint / compile して schema 整合性を担保
8. **Canary Rollout**
   - 新パターンをいきなり全量投入せず、まず少量配信してから昇格
9. **Anomaly Watcher**
   - 売上だけでなく、急激なCTR低下・炎上兆候・note session劣化も別系統で監視
10. **Observation-first Dashboard**
   - 観測UIをさらに強化し、意思決定・失敗理由・rollback理由が全部見えるようにする

---

## 3. 絶対原則

- 5部署構造は維持
- 完全自律
- 人間非介入
- LLM はサブスクCLI経由
- human_review 全廃
- Scheduler が直接 LLM CLI を叩かない
- ThreadsOS 本体が状態・実行・収益判定を握る
- SQLite を唯一の通信路にする
- 部署同士の自由会話は禁止
- 契約書は vendor-neutral に保持
- 迷ったら人に上げず、**止める / 安全化する**

### 5部署の固定

5部署は以下で固定する。

- 管理・指揮系統
- 外部リサーチ部署
- 競合リサーチ分析部署
- Threads運用部署
- note運用部署

`監査 / 安全` は第6部署ではなく、全体を横断する安全レイヤーとして扱う。

---

## 4. 全体アーキテクチャ

```text
Windows Task Scheduler / PM2
  -> ThreadsOS Core
    -> Job Scheduler
    -> Revenue Brain
    -> Experiment Engine
    -> Policy Guard
    -> Session Health
    -> Budget Governor
    -> Circuit Breaker
    -> LLM Runner Router
      -> Claude Code
      -> Codex CLI
      -> Copilot CLI
    -> Execution Outbox
      -> Threads Graph API
      -> Playwright note client
    -> SQLite
```

### Layer 1: Scheduler
- PM2 常駐を主系
- Windows Task Scheduler は復旧保険
- Scheduler は **ThreadsOS 本体だけ** 起動する

### Layer 2: ThreadsOS Core
- multi-tier scheduling
- heartbeat orchestration
- revenue brain
- experiment engine
- policy guard
- retry / quarantine / rollback
- job lease / idempotency
- session health
- runner budget / circuit breaker
- DB整合性の最終責任

### Layer 3: LLM Runner
- Claude 主系
- Codex 副系
- Copilot 予備
- 同一 JSON I/O 契約

### Layer 4: Execution
- Threads Graph API
- Playwright note client
- outbox consumer

### Layer 5: State
- SQLite
- agents / playbooks / policies
- migrations
- decision evidence

---

## 5. スケジューリング仕様

### 15分ごと
LLMなし。

- session health check
- Threads metrics sync
- note metrics / sales sync
- runner health check
- rate / budget sync
- stuck job 検知
- anomaly scan

### 1時間ごと
収益改善の中核。

- funnel diagnosis
- bottleneck 1つ選定
- experiment 1つだけ選ぶ
- Threads投稿 / reply / note導線更新
- 24h / 72h 採点予約

### 1日ごと
- note生成 / 公開
- winning pattern 資産化
- 翌日配分更新
- memory compression
- asset pruning

### 1週ごと
- 価格最適化
- テーマ配分更新
- loser整理
- strategy refresh
- policy drift review

### 固定原則
**1時間 heartbeat = 1ボトルネック改善**  
**毎回全部署フル稼働は禁止**

---

## 6. 売上ファネル定義

最低この6段を固定する。

1. `impressions`
2. `profile_transitions`
3. `note_clicks`
4. `note_views`
5. `purchases`
6. `revenue`

さらに内部診断用として補助メトリクスも持つ。

- `reply_rate`
- `save_rate`
- `follow_conversion`
- `refund_rate`
- `complaint_signal`
- `session_integrity_score`

---

## 7. LLM Runner 抽象層

```ts
type RunnerTask = {
  task_type:
    | "funnel_advice"
    | "threads_generation"
    | "note_generation"
    | "reply_generation"
    | "audit"
    | "strategy_review"
    | "failure_analysis"
    | "rewrite";
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
  confidence_required: "low" | "medium" | "high";
};

type RunnerResult = {
  decision: Record<string, unknown>;
  confidence: number;
  reasons: string[];
  artifacts: Record<string, unknown>;
  next_actions: string[];
  runner_meta: {
    runner: "claude" | "codex" | "copilot";
    duration_ms: number;
    retry_count: number;
    token_budget_bucket?: string;
  };
};
```

### fallback
- timeout → fallback runner
- JSON不正 → 同 runner で1回だけ再生成
- 2回失敗 → quarantine
- confidence不足 → skip
- 連続失敗閾値超え → circuit breaker 開放

---

## 8. 役割別ルーティング

### Claude Code
主系。
- note本文生成
- Threads投稿生成
- audit
- executive補助
- strategy要約

### Codex CLI
副系。
- JSON厳格出力
- failure analysis
- 週次戦略補助
- 構造化変換
- Claude timeout代替

### Copilot CLI
予備。
- 軽量rewrite
- 軽量文面修正
- 補助用途

### 追加原則
- 投稿の「大量生成」は必ず budget governor 経由
- JSON厳格性が必要な job は Codex 優先に寄せてもよい
- 監査 job は Claude 優先

---

## 9. 部署 = JSON契約ワーカー

部署構造は5部署で維持する。

- 管理・指揮系統
- 外部リサーチ部署
- 競合リサーチ分析部署
- Threads運用部署
- note運用部署

ただし実装上は**人格会話しない**。  
全部 **JSON契約ワーカー** にする。

監査 / 安全は横断レイヤーとして全部署と全ジョブに適用する。

### 共通契約
- `input_schema`
- `output_schema`
- `success_criteria`
- `forbidden`
- `llm_budget`
- `confidence_rule`
- `fallback`
- `primary_runner`
- `fallback_runner`

### frontmatter 例
```yaml
name: threads-publisher
role: Threads投稿実行ユニット
input_schema:
  bottleneck: string
  target_campaign_id: string
  winning_patterns_ref: string
  competitor_diff_ref: string
output_schema:
  posts:
    - hook: string
      body: string
      cta_id: string
      schedule_ts: string
success_criteria:
  metric: profile_transition_rate
  target: baseline * 1.1
  eval_window: 24h
forbidden:
  - 誇大表現
  - 規約違反
  - 曖昧CTA
llm_budget: 1
primary_runner: claude
fallback_runner: codex
fallback: auto-skip
```

---

## 10. ディレクトリ構成

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
  reply-policy.md
  rollback-policy.md
  degrade-modes.md
  canary-rollout.md

/policies
  brand.md
  safety.md
  pricing.md
  monetization.md
  rate-budget.md
  runner-health.md
```

### 追加
- 起動前に contract compiler が lint する
- schema 不整合は起動ブロック
- `agents/` が正本、CLI別変換物は生成物にする

---

## 11. SQLite スキーマ v2

### 中核テーブル
- `campaigns`
- `content_assets`
- `publication_events`
- `threads_metrics`
- `note_metrics`
- `revenue_events`
- `funnel_snapshots`
- `experiments`
- `experiment_results`
- `winning_patterns`
- `losing_patterns`
- `executive_decisions`
- `agent_artifacts`
- `session_health`

### v2 追加テーブル
- `job_runs`
- `job_leases`
- `execution_outbox`
- `decision_evidence`
- `runner_health`
- `runner_budget`
- `feature_flags`
- `anomaly_events`
- `rollbacks`
- `memory_summaries`

### 既存テーブル追加キー
- `campaign_id`
- `angle_id`
- `cta_id`
- `price_variant_id`
- `canary_group`

### 役割
#### `job_leases`
- 重複起動防止
- 同じ heartbeat の二重実行阻止

#### `execution_outbox`
- 投稿、reply、note公開などの外部副作用予定を先に書き込む
- 実行成功後に `publication_events` へ反映
- 失敗時も再送可能

#### `decision_evidence`
- そのアクションを選んだ理由
- 参照した metrics
- runner 出力の要約
- rollback 理由

#### `runner_budget`
- 日次呼び出し上限
- 5時間窓上限
- 緊急バジェット

#### `runner_health`
- timeout率
- JSON不正率
- 連続失敗数
- circuit breaker 状態

---

## 12. Experiment Engine

### ループ
1. funnel 集計
2. 最弱段特定
3. 改善仮説 3つ生成
4. 低リスク高期待値を 1つ採用
5. canary で少量投入
6. 24h / 72h 採点
7. 勝ちなら昇格
8. 負けなら rollback / loser 登録

### 学習
- Thompson Sampling
- 最初の2週間は探索強め
- seed hypotheses を priors として投入

### 改善対象
- hook
- CTA
- 投稿時間
- noteタイトル
- note導入
- 価格
- 導線文
- テーマ切り口

---

## 13. 安全仕様

human_review は使わない。  
4択だけ。

- `auto-execute`
- `auto-rewrite`
- `auto-skip`
- `auto-quarantine`

### 追加安全層
- confidence低 → 実行しない
- note session異常 → note系停止、Threads側だけ継続
- Threads token異常 → observation-only モードへ移行
- 指標急落 → rollback
- 危険表現 → rewrite
- 危険価格変更 → skip
- runner 障害 → fallback / circuit breaker

---

## 14. Degrade Modes

### Mode A: Full Autonomy
すべて正常

### Mode B: Threads-only
note session 異常時
- note生成 / 公開停止
- Threads は既存note導線付きで継続

遷移条件:
- note session health が連続2回失敗
- note publish / sales sync が連続3回失敗

復帰条件:
- 15分 health check が2回連続成功
- note metrics sync が1回成功

### Mode C: Observe-only
投稿系 adapter に障害
- 計測だけ継続
- 新規 experiment 停止

遷移条件:
- Threads API または note publish adapter が連続2回失敗
- outbox consumer が連続2回異常終了

復帰条件:
- adapter health check が2回連続成功
- outbox backlog が閾値未満に戻る

### Mode D: Safe Freeze
複数系統障害
- 投稿停止
- DB / metrics / health のみ継続
- 自動復帰条件を監視

遷移条件:
- 複数adapter同時障害
- primary / fallback runner の circuit breaker が両方開放
- schema compile failure または migration mismatch

復帰条件:
- adapter / runner / schema の健全性がすべて回復
- freeze要因が1サイクル消失

---

## 15. note / Threads 実行

### note
- Playwright
- storage state 利用
- 売上 / 閲覧 / conversion を article 単位で回収
- 失効時は quarantine
- 15分ジョブで監視

完全自律を守るため、note系は quarantine の先を定義する。

- 短期: `Threads-only` モードへ自動降格
- 中期: 既存note導線を使った Threads 集客だけ継続
- 長期: session health が回復するまで note生成 / note公開 / 売上同期を停止

運用中に手動再ログインを要求しない。

### Threads
- Graph API
- post 単位で metrics 回収
- `campaign_id / angle_id / cta_id` と紐付け

### 投稿実行
- 直接即時 publish しない
- まず `execution_outbox` に enqueue
- consumer が実行
- 成否を `publication_events` に書く

reply も外部副作用なので、同じ outbox / idempotency 管理下に置く。

---

## 16. ダッシュボード

承認UIではなく観測UI。

### 表示
- 今日の bottleneck
- 今回の experiment
- runner health
- runner budget
- current mode
- session health
- 直近勝ち型 / 負け型
- anomaly events
- rollback history
- decision evidence
- outbox / stuck jobs

---

## 17. OpenClaw の扱い
本体には入れない。  
今は不要。

将来使うなら
- 外部ワーカー管理
- 遠隔実行
- 監視拡張

だけ。

---

## 18. 実装順

### Phase 0
- `llm_runner` 抽象層
- runner router
- budget governor
- circuit breaker
- 最小スキーマ追加
  - `runner_budget`
  - `runner_health`
  - `job_leases`
  - `execution_outbox`

### Phase 1
- SQLite拡張
- 6段ファネル
- decision evidence
- anomaly events
- rollbacks
- memory_summaries

### Phase 2
- note売上スクレイパ
- session guard
- Threads insights
- anomaly watcher

### Phase 3
- 15m / 1h / 1d / 1w 分割
- degrade modes
- rollback 自動化

### Phase 4
- executive funnel駆動化
- experiment engine
- canary rollout

### Phase 5
- `agents/` `playbooks/` `policies/` 契約化
- contract compiler
- dashboard 観測UI化

---

## 19. 最終結論

**v2.0 の ThreadsOS は、単に「完全自律で回る」だけじゃなく、重複実行・runner障害・session失効・計測欠損・急激な指標悪化にも耐える、壊れにくい収益最適化OSとして定義する。**

言い切るとこれ。

> **本体がOS、LLMは差し替え可能な推論ワーカー、DBは唯一の台帳、OutboxとLeaseで事故を防ぎ、Experiment Engineで売上を伸ばす。**
