# ThreadsOS 最終設計図 v3.1

**確定日**: 2026-04-14  
**ステータス**: 正式版  
**位置づけ**: v2.0 の信頼性設計と v3.0 の統合仕様をベースに、表現の揺れと固定値依存を除去した最終確定版

---

## 0. 目的

**収入を生むこと。**

Threads と note の運用を完全自律で回し、売上ファネルを観測し、ボトルネックを特定し、改善実験を打ち、勝ち型だけを資産化し続ける。  
投稿自動化そのものは目的ではなく、**収益最適化ループ**を回すことが目的。

---

## 1. 一行定義

**ThreadsOS = Node.js + TypeScript + SQLite + Playwright + PM2 を本体にしたローカル常駐の deterministic な運用OSが、状態管理・実行管理・収益判定・安全制御を握り、Claude Code / Codex CLI / Copilot CLI を pluggable な推論ワーカーとして役割別ルーティングし、売上ファネル最適化ループを完全自律で回す収益運用基盤。**

短く言うとこれ。

> **骨格は deterministic、思考だけ CLI LLM に委譲**

---

## 2. 絶対条件

- 初期ThreadsOS構想は変えない
- 5部署構造を維持する
- 完全自律
- 人間非介入
- human_review 全廃
- Scheduler が直接 CLI LLM を叩かない
- ThreadsOS 本体が状態・実行・収益判定を握る
- SQLite を唯一の通信路にする
- 部署間の自由会話は禁止
- LLM はサブスクCLI経由のみ
- 契約書は vendor-neutral に保持
- 迷ったら人間に上げず、**止める / 安全化する**
- 運用中の note 手動再ログイン依存を仕様に持ち込まない

---

## 3. 5部署の固定

### 5部署
- 管理・指揮系統
- 外部リサーチ部署
- 競合リサーチ分析部署
- Threads運用部署
- note運用部署

### 横断機能
- **監査 / 安全機能**

監査 / 安全は **第6部署ではない**。  
全部署・全ジョブ・全出力に適用される **横断安全レイヤー** として扱う。

---

## 4. 採用 / 非採用

### 採用
- 収益閉ループ中心
- Multi-tier scheduling（15m / 1h / 1d / 1w）
- 1 heartbeat = 1ボトルネック改善
- SQLite を唯一の台帳にする
- 役割別ルーティング
- JSON契約ワーカー
- Job Lease / Outbox / Budget Governor / Circuit Breaker
- Degrade Modes
- Decision Evidence Ledger
- Contract Compiler
- Canary Rollout
- Observation-first Dashboard

### 非採用
- Scheduler から直接 `claude -p` / `codex` を叩く構成
- OpenClaw を本体中核に置く構成
- 部署同士の自由会話
- human_review 前提
- LLM に DB整合性を握らせる設計
- CLI を OS とみなす設計
- 運用中の note 再ログイン前提
- 1回の heartbeat で全部やる設計

---

## 5. 全体アーキテクチャ

```text
Windows Task Scheduler / PM2
  -> ThreadsOS Core
    -> Job Scheduler
    -> Job Lease Manager
    -> Revenue Brain
    -> Experiment Engine
    -> Policy Guard
    -> Session Health Monitor
    -> Anomaly Watcher
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
    -> Decision Evidence Ledger
```

### Layer 1: Scheduler
- PM2 常駐を主系
- Windows Task Scheduler は復旧保険
- Scheduler は **ThreadsOS 本体だけ** 起動する

### Layer 2: ThreadsOS Core
- multi-tier scheduling
- revenue brain
- experiment engine
- retry / quarantine / rollback
- job lease / idempotency
- session health
- budget governor
- circuit breaker
- anomaly watcher
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

## 6. deterministic と LLM の責務分離

### deterministic にやること
- scheduling
- queue 制御
- retry
- quarantine
- rollback
- DB更新
- メトリクス集計
- funnel 一次診断
- confidence 閾値判定
- session health 判定
- budget / rate 判定
- Job Lease
- Outbox / Consumer
- anomaly 検知
- circuit breaker 制御

### LLM にやらせること
- Threads投稿文生成
- note本文生成
- 返信文生成
- 競合分析の要約
- 改善仮説生成
- rewrite
- audit補助
- failure analysis

### LLM にやらせないこと
- DB整合性管理
- 実投稿の最終制御
- retry 制御
- lease 管理
- session 管理
- human review 待ち判断

---

## 7. スケジューリング仕様

### 15分ごと
LLM呼び出しなし。

- session health check
- Threads metrics sync
- note metrics / sales sync
- runner health check
- rate / budget sync
- stuck job scan
- anomaly scan
- quarantine queue recheck

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

## 8. 1時間 heartbeat 固定フロー

```text
1. Job Lease 取得
2. ファネル集計（LLM 0回）
3. 最弱段を1つだけ選定
4. LLM 1回で改善アクション生成
5. Policy Guard
   - pass -> auto-execute
   - 軽微fail -> auto-rewrite
   - confidence低 -> auto-skip
   - session異常 / 危険 -> auto-quarantine
6. Canary 対象なら少量配信
7. execution_outbox に enqueue
8. outbox consumer が実行
9. publication_events / decision_evidence / experiment_log 更新
10. 24h / 72h 採点タスクを enqueue
11. Job Lease 解放
```

---

## 9. 売上ファネル定義

### 主ファネル6段
1. `impressions`
2. `profile_transitions`
3. `note_clicks`
4. `note_views`
5. `purchases`
6. `revenue`

### 補助メトリクス
- `reply_rate`
- `save_rate`
- `follow_conversion`
- `refund_rate`
- `complaint_signal`
- `session_integrity_score`

### ボトルネック別改善軸
#### Reach 弱い
- テーマ
- フック
- 投稿時間
- 競合角度

#### Click 弱い
- CTA
- 導線文
- プロフ文
- 1投稿目構成

#### Read 弱い
- noteタイトル
- 導入
- 見出し
- サムネ訴求

#### Buy 弱い
- 記事テーマ
- 価格
- オファー
- 販売前教育

---

## 10. 収益評価の考え方

最終目的関数は **revenue**。  
ただし revenue は遅延指標なので、短期判断には代理指標も使う。

### 優先順位
1. `revenue`
2. `purchases`
3. `note_views`
4. `note_clicks`
5. `profile_transitions`

### 重要ルール
- 固定係数の RevenueScore を仕様に焼き込まない
- 代理指標の重みは `policies/monetization.md` に置く
- これは目的関数ではなく **tie-breaker / 補助判断** に使う
- 週次で重みを再調整できる

---

## 11. LLM Runner 抽象層

```ts
type TaskType =
  | "funnel_advice"
  | "threads_generation"
  | "note_generation"
  | "reply_generation"
  | "audit"
  | "strategy_review"
  | "failure_analysis"
  | "rewrite";

type RunnerTask = {
  task_type: TaskType;
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

---

## 12. 役割別ルーティング

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
- 構造化変換
- 週次戦略補助
- Claude timeout代替

### Copilot CLI
予備。
- 軽量rewrite
- 軽量文面修正
- 補助用途

### ルール
- 投稿の大量生成は必ず budget governor 経由
- JSON厳格性が必要な job は Codex 優先可
- 監査系は Claude 優先
- 固定回数の運用を仕様に書かない
- 実際の可否は `runner_budget` と `runner_health` で判定する

---

## 13. 部署 = JSON契約ワーカー

### 部署一覧
- executive
- research
- competitor
- threads
- note

### 横断機能
- auditor

### 契約項目
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
  bottleneck: enum[Reach, Click, Read, Buy]
  target_campaign_id: uuid
  winning_patterns_ref: query
  competitor_diff_ref: query
output_schema:
  posts:
    - hook: string
      body: string
      cta_id: uuid
      schedule_ts: iso8601
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

### 通信原則
- 部署間通信は **SQLite のみ**
- 自由会話禁止
- md は人格ではなく契約書

---

## 14. ディレクトリ構成

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

### 起動前検査
- Contract Compiler が lint / compile
- schema 不整合は起動ブロック
- `agents/` が正本
- CLI別変換物は生成物

---

## 15. 状態機械

### Threads asset
`drafted -> audited -> scheduled -> published -> measured -> scored -> archived`

### note asset
`drafted -> audited -> scheduled -> published -> measured -> scored -> archived`

### experiment
`planned -> active -> measuring -> completed -> promoted | rejected | quarantined`

### session
`healthy -> degraded -> quarantined -> recovered`

### 原則
- 状態遷移は deterministic
- LLM は遷移理由の提案はできる
- 遷移実行は ThreadsOS 本体だけが行う

---

## 16. SQLite スキーマ

### 実体系
- `campaigns`
- `content_assets`
- `drafts`
- `publication_events`

### 計測系
- `threads_metrics`
- `note_metrics`
- `revenue_events`
- `funnel_snapshots`

### 学習系
- `experiments`
- `experiment_results`
- `winning_patterns`
- `losing_patterns`
- `pricing_variants`

### 運用系
- `executive_decisions`
- `agent_artifacts`
- `session_health`
- `rollbacks`
- `memory_summaries`

### 信頼性系
- `job_runs`
- `job_leases`
- `execution_outbox`
- `decision_evidence`
- `runner_health`
- `runner_budget`
- `feature_flags`
- `anomaly_events`

### 追加必須カラム
- `campaign_id`
- `angle_id`
- `cta_id`
- `price_variant_id`
- `canary_group`

### exactly-once-ish のための必須制約
#### job_leases
- `lease_key` UNIQUE
- `expires_at`
- `owner_id`
- `heartbeat_scope`

#### execution_outbox
- `idempotency_key` UNIQUE
- `payload_hash`
- `target_platform`
- `status`

#### publication_events
- `external_fingerprint` UNIQUE
- `published_at`
- `campaign_id`

---

## 17. Outbox Pattern

```text
1. Policy Guard 通過
2. execution_outbox に enqueue
3. outbox consumer が順次実行
4. Threads / note へ実投稿
5. 成功 -> publication_events
6. 失敗 -> retry / quarantine
```

### 効果
- 投稿予定と実投稿を分離
- 失敗時の再送が可能
- 二重投稿を防ぎやすい
- reply も同じ outbox 管理下に置く

---

## 18. Budget Governor / Circuit Breaker

### Budget Governor
管理対象:
- runner ごとの日次上限
- 時間帯上限
- 5時間窓上限
- 緊急バジェット

### Circuit Breaker
監視対象:
- timeout率
- JSON不正率
- 連続失敗数

### 原則
- 固定メッセージ数を仕様書に書かない
- 実運用の可否は DB と policy で制御する
- runner 障害時は fallback
- 両系統不全時は degrade mode に移行

---

## 19. Experiment Engine

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
- 初期2週間は探索強め
- seed hypotheses を priors として投入

### 実験対象
- hook
- CTA
- 投稿時間
- noteタイトル
- note導入
- 価格
- 導線文
- テーマ切り口

---

## 20. 安全仕様

### human_review の代替
- `auto-execute`
- `auto-rewrite`
- `auto-skip`
- `auto-quarantine`

### 追加安全層
- confidence低 -> 実行しない
- 危険表現 -> rewrite
- 危険価格変更 -> skip
- runner 障害 -> fallback / circuit breaker
- 指標急落 -> rollback

### rollback 条件例
- CTR 急落
- purchase rate 急落
- complaint signal 急増
- 価格変更後の CV 低下

---

## 21. Degrade Modes

### Mode A: Full Autonomy
- すべて正常

### Mode B: Threads-only
- note session 異常
- note生成 / 公開 / 売上同期停止
- Threads は既存note導線で継続

### Mode C: Observe-only
- 投稿系 adapter に障害
- 計測だけ継続
- 新規 experiment 停止

### Mode D: Safe Freeze
- 複数系統障害
- 投稿停止
- DB / metrics / health のみ継続

### note session の正式ルール
- session失効時は `quarantined`
- 運用中に手動再ログインを要求しない
- 自動復帰手段が事前実装されている場合のみ recovered へ戻す
- 復帰できない間は Threads-only で継続する

---

## 22. note / Threads 観測

### Threads
- Graph API で insights 回収
- 投稿ごとに `campaign_id / angle_id / cta_id / canary_group` を紐付ける

### note
- Playwright + `note-storage-state.json`
- article 単位で `views / purchases / revenue / conversion` を保存
- 15分ジョブで session health を監視
- 失効時は quarantine

---

## 23. ダッシュボード

承認UIではなく **観測UI**。

### 表示項目
- 今日の bottleneck
- 今回の experiment
- runner health / budget
- current mode
- session health
- 直近勝ち型 / 負け型
- 6段ファネル
- anomaly events
- quarantine jobs
- rollback history
- decision evidence
- outbox / stuck jobs

---

## 24. OpenClaw の扱い

本体には入れない。  
今は不要。

### 理由
- 今必要なのは gateway ではなく収益OS
- 完全自律と chat 操作中心は相性が悪い
- 既存 Node/TS + DB + heartbeat を伸ばすほうが合理的

### 将来の保留用途
- 外部ワーカー管理
- 別マシン実行
- 監視基盤拡張

---

## 25. 実装順

### Phase 0
- llm_runner 抽象層
- runner router
- budget governor
- circuit breaker
- 最小スキーマ追加

### Phase 1
- SQLite拡張
- 6段ファネル
- job leases
- execution outbox
- decision evidence
- anomaly events

### Phase 2
- note売上スクレイパ
- session guard
- Threads insights
- note / Threads metrics の安定化

### Phase 3
- 15m / 1h / 1d / 1w 分割
- degrade modes
- rollback 自動化

### Phase 4
- executive funnel駆動化
- experiment engine
- canary rollout

### Phase 5
- agents / playbooks / policies 契約化
- contract compiler
- dashboard 観測UI化

---

## 26. 最終結論

**ThreadsOS v3.1 は、5部署構造・完全自律・人間非介入を維持したまま、収益閉ループを中心に、重複実行・runner障害・session失効・計測欠損・指標急落に耐える壊れにくい収益最適化OSとして定義する。**

言い切るとこれ。

> **本体がOS、LLMは差し替え可能な推論ワーカー、DBは唯一の台帳、Outbox と Lease で事故を防ぎ、Experiment Engine で売上を伸ばし、Degrade Modes で止まらず、Decision Evidence で全判断を追跡する。**
