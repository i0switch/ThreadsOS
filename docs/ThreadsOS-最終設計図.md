# ThreadsOS 最終設計図

更新日: 2026-04-14
状態: 正式版
位置づけ: `ThreadsOS_final_spec.md` と `ThreadsOS-final-spec-v1.md` を統合し、正式な基準仕様として採用する

## 0. 一文定義

ThreadsOS は、`Node.js + TypeScript + SQLite + Playwright + PM2` を本体にしたローカル常駐の deterministic な運用OSであり、`Claude Code / Codex CLI / Copilot CLI` を差し替え可能な推論ワーカーとして役割別に呼び分けながら、売上ファネル最適化ループを完全自律で回す。

短く言うとこう。

`本体がOS、LLMは脳の一部`

## 1. 絶対条件

- 初期構想の 5 部署構造は維持する
- 人間は運用中に介入しない
- LLM はサブスク型 CLI を使う
- Scheduler が直接 LLM CLI を叩かない
- ThreadsOS 本体が状態管理と実行管理を握る
- SQLite を唯一の通信路にする
- `human_review` は最終形で全廃する
- 部署同士の自由会話は禁止する
- 本体の目的は投稿数ではなく収益最大化に置く

## 2. 用語の固定

設計内の言葉をここで固定する。

### 5部署

- 管理・指揮系統
- 外部リサーチ部署
- 競合リサーチ分析部署
- Threads運用部署
- note運用部署

### 横断機能

- 監査 / 安全機能

監査 / 安全は「第6部署」ではなく、全体を横断する安全レイヤーとして扱う。  
これで「5部署維持」と「監査の必要性」を両立させる。

## 3. 最上位方針

ThreadsOS の本体は「部署」でも「会話するエージェント」でもない。

本体はこの閉ループ。

1. 観測
2. 診断
3. 実験選定
4. 自動実行
5. 採点
6. 学習
7. 次回反映

このループを安定して回すために、部署を実行ユニットとして使う。

## 4. 全体アーキテクチャ

```text
Windows Task Scheduler / PM2
  -> ThreadsOS Core
    -> Revenue Brain
    -> Experiment Engine
    -> Policy Guard
    -> LLM Runner Router
      -> Claude Code
      -> Codex CLI
      -> Copilot CLI
    -> Threads Graph API
    -> Playwright note client
    -> SQLite
```

### Layer 1: Scheduler

- PM2 を主系にする
- Windows Task Scheduler は復旧保険にする
- Scheduler の責務は ThreadsOS job を起動することだけ
- Scheduler が `claude -p` や `codex` を直接叩く構成は採用しない

### Layer 2: ThreadsOS Core

- multi-tier scheduling
- publish orchestration
- metrics collection
- revenue funnel diagnosis
- experiment logging
- retry / quarantine / rollback
- session health
- DB整合性の最終責任

### Layer 3: LLM Runner Router

- `PRIMARY_RUNNER=claude`
- `FALLBACK_RUNNER=codex`
- `OPTIONAL_RUNNER=copilot`
- 役割別ルーティング
- 失敗時のフォールバック

### Layer 4: Execution Adapters

- Threads Graph API
- Playwright note automation
- local file / session guard

### Layer 5: State

- SQLite が唯一の真実
- 全部署の入力は DB から取る
- 全部署の出力は DB に保存する

## 5. deterministic と LLM の責務分離

ここを曖昧にしない。

### deterministic にやること

- スケジューリング
- queue 制御
- retry
- quarantine
- rollback
- DB更新
- メトリクス集計
- funnel 診断の一次判定
- confidence しきい値判定
- session health 判定
- 予算 / レート監視

### LLM にやらせること

- Threads文案生成
- note本文生成
- 返信文生成
- 競合からの示唆抽出
- 実験案生成
- 監査補助
- 失敗理由の要約

### LLM にやらせないこと

- DB更新の最終決定
- 投稿処理そのもの
- 実行キューの整合性管理
- セッション管理
- リトライ制御
- 人間レビュー待ち判断

## 6. スケジューリング仕様

### 15分ごと

LLM は呼ばない。

- session health check
- Threads metrics sync
- note metrics / 売上 sync
- error scan
- stuck job 検知
- quarantine queue 再判定

### 1時間ごと

収益最適化の中心。

- funnel diagnosis
- 最弱ステージを 1つだけ選ぶ
- experiment を 1つだけ採用する
- Threads投稿 / reply / note導線更新
- 24h / 72h 採点タスクを予約する

### 1日ごと

- note生成
- note公開
- 勝ち型資産化
- 翌日の配分更新

### 1週ごと

- 価格最適化
- テーマ配分見直し
- 長期失敗パターン整理
- strategy summary 更新

### 原則

`1時間 heartbeat = 1ボトルネック改善`

毎回全部署をフル稼働させない。

## 7. ファネル定義

最低この 6 段を固定する。

1. `impressions`
2. `profile_transitions`
3. `note_clicks`
4. `note_views`
5. `purchases`
6. `revenue`

ThreadsOS の司令塔は、この6段のうち一番弱い箇所を毎回 1つだけ改善する。

## 8. 収益スコア

単純なインプレ最適化に落ちないように、内部で重み付きスコアを持つ。

例:

```text
RevenueScore =
  revenue * 1.0
  + purchases * 300
  + note_views * 5
  + note_clicks * 8
  + profile_transitions * 3
  + high_quality_follows * 10
  - safety_penalty
  - session_penalty
  - repeated_failure_penalty
```

最終目的は `revenue`。  
ただし遅延指標なので、近接代理指標もスコアに含める。

## 9. 状態機械

### Threads asset state

`drafted -> audited -> scheduled -> published -> measured -> scored -> archived`

### note asset state

`drafted -> audited -> scheduled -> published -> measured -> scored -> archived`

### experiment state

`planned -> active -> measuring -> completed -> promoted | rejected | quarantined`

### session state

`healthy -> degraded -> quarantined -> recovered`

各状態遷移は deterministic に処理する。  
LLM は遷移理由の提案はできるが、遷移実行は本体がやる。

## 10. LLM Runner 抽象層

ThreadsOS 本体に `llm_runner` 抽象層を置く。

### 共通入力

```json
{
  "task_type": "generate|analyze|audit|rewrite|summarize",
  "tier": "light|medium|heavy",
  "role": "executive|research|competitor|threads|note|auditor",
  "json_schema": {},
  "context_bundle": {},
  "confidence_required": "low|medium|high"
}
```

### 共通出力

```json
{
  "decision": {},
  "confidence": 0.0,
  "reasons": [],
  "artifacts": [],
  "next_actions": [],
  "runner_meta": {
    "runner": "claude|codex|copilot",
    "duration_ms": 0,
    "retry_count": 0
  }
}
```

### 実行ルール

- まず主系 runner で実行
- timeout なら副系 runner に切替
- JSON 不正なら 1回だけ再生成
- それでも失敗なら safe fallback
- confidence が閾値未満なら実行しない

## 11. Runner の役割分担

### Claude Code

- 主系
- Threads投稿生成
- note長文生成
- executive 補助
- audit
- 要約

### Codex CLI

- 副系
- 重い再分析
- 失敗原因深掘り
- 週次戦略補助
- JSON 厳格整形

### Copilot CLI

- 任意補助
- 軽量 rewrite
- 文面修正
- 補助用途

### 原則

単独固定にしない。  
役割別ルーティングで使う。

## 12. 部署仕様

部署構造は維持する。  
ただし人格会話は禁止。

部署 = `JSON契約ワーカー`

### 各部署が持つもの

- `input_schema`
- `output_schema`
- `success_criteria`
- `forbidden`
- `llm_budget`
- `confidence_rule`
- `failure_mode`

### frontmatter 例

```yaml
name: threads-publisher
role: Threads投稿実行ユニット
input_schema:
  bottleneck: enum[Reach, Click, Read, Buy]
  target_campaign_id: uuid
  winning_patterns_ref: query
  budget_llm_calls: int
output_schema:
  posts:
    - hook: string
      body: string
      cta_id: uuid
      schedule_ts: iso8601
  confidence: float
success_criteria:
  metric: profile_transition_rate
  target: baseline * 1.1
  eval_window: 24h
forbidden:
  - 誇大表現
  - 規約違反
  - 曖昧CTA
llm_budget: 1
failure_mode: auto-skip
```

### 通信ルール

- 部署間通信は DB のみ
- ワーカーは DB を読んで DB に書く
- 自由会話禁止

## 13. ディレクトリ設計

ベンダー中立で持つ。

```text
agents/
  executive.md
  research.md
  competitor.md
  threads.md
  note.md
  auditor.md

playbooks/
  funnel-diagnosis.md
  experiment-selection.md
  threads-generation.md
  note-generation.md
  reply-policy.md
  rollback-policy.md

policies/
  brand.md
  safety.md
  pricing.md
  monetization.md
```

### 方針

- `agents/` は契約
- `playbooks/` は手順書
- `policies/` は全体制約
- `.claude/agents` は正本にしない

## 14. データモデル

### 新規の中核テーブル

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
- `pricing_variants`
- `rollbacks`
- `memory_summaries`

### 既存テーブルへの追加キー

- `campaign_id`
- `angle_id`
- `cta_id`
- `price_variant_id`

### DB の役割

- 状態の唯一の真実
- 部署間通信路
- 勝ち型 / 負け型の資産庫
- 次回 heartbeat の入力元

## 15. 投稿・計測・売上観測

### Threads

- Graph API で metrics 回収
- 投稿単位で `campaign_id / angle_id / cta_id` を必ず紐付ける
- post ごとの performance を experiment に結びつける

### note

- Playwright + storage state を使う
- 記事公開
- 記事 stats 回収
- article 単位で `views / purchases / revenue / conversion_rate` を保存する

### note 運用の注意

- `note-storage-state.json` は初期セットアップ資産として使う
- 15分ジョブで session 失効を監視する
- 失効時は note 系 job を quarantine する
- 運用中に手動再ログインを前提にしない

## 16. Experiment Engine

ThreadsOS の魂はここ。

### 毎回やること

1. funnel 集計
2. 最弱ステージを 1つ選ぶ
3. 改善仮説を 3つ出す
4. 低リスク高期待値を 1つ採用
5. 自動実行
6. 24h / 72h 後に採点
7. 勝ち型を DB に保存
8. 負け型を停止

### 主な改善対象

#### Reach が弱い

- テーマ
- フック
- 投稿時間
- 競合角度

#### Click が弱い

- CTA
- 導線文
- プロフ文

#### Read が弱い

- note タイトル
- 導入
- 見出し

#### Buy が弱い

- テーマ
- 価格
- オファー
- 教育導線

### 学習方式

- 軽量 multi-armed bandit
- 初期は Thompson Sampling を採用
- cold start 期は seed hypothesis を priors として注入する

## 17. コールドスタート対策

完全自律でも、初期統計ゼロでは動きにくい。  
なので最初の2週間は seed を使う。

### seed 元

- `docs/inputs/`
- `docs/research/`
- 既存の競合分析
- 過去 draft 資産

### 初期配分

- 探索 70%
- 活用 30%

### 移行後

- 探索 30%
- 活用 70%

これで「人間は初期入力だけ」を守りつつ、自律探索を開始できる。

## 18. 完全自律の安全仕様

`human_review` は使わない。  
代わりにこの4択だけ持つ。

- `auto-execute`
- `auto-rewrite`
- `auto-skip`
- `auto-quarantine`

### ガード

- confidence 低 -> 実行しない
- session 異常 -> note 系隔離
- 指標急落 -> rollback
- 危険表現検知 -> rewrite
- 危険な価格変更 -> skip

### rollback 発動条件

直近24hで以下のどれかが発生したら、直前の勝ち型に戻す。

- CTR が前週比 -30%
- 購入率が前週比 -50%
- クレーム系ワード出現率が急増
- 価格変更後に CV が悪化

### 原則

迷ったら人間に上げる、は禁止。  
迷ったら止めるか、安全化する。

## 19. SLO と健全性指標

最終形ではこの水準を目標にする。

### 運用SLO

- 15分ジョブ成功率: 99% 以上
- 1時間ジョブ成功率: 95% 以上
- note session 健全率: 90% 以上
- JSON schema 準拠率: 98% 以上
- quarantine からの自動復帰率: 80% 以上

### 収益SLO

- 売上ゼロ日を減らす
- note 公開後 72h で最低1回は計測更新が入る
- 実験ごとの 24h / 72h 採点欠損率を 5% 未満に抑える

## 20. ダッシュボード方針

ダッシュボードは承認UIではなく観測UIにする。

### 表示項目

- 今日のボトルネック
- 今回の実験
- 予算消費
- session health
- 直近勝ち型 / 負け型
- 売上ファネル
- quarantine 中ジョブ
- rollback 履歴
- エラー履歴

## 21. OpenClaw の扱い

中核採用しない。

理由:

- 今必要なのは gateway ではなく収益OS
- ローカル deterministic 実行を先に固めるべき
- 完全自律と相性が悪い箇所がある
- 既存の Node/TS + DB + heartbeat を活かしたほうが速い

将来のオプションとして保留にする。

## 22. 実装フェーズ

### Phase 0

- `llm_runner` 抽象層
- runner 共通I/O
- vendor-neutral contracts

### Phase 1

- 6段ファネル SQLite
- asset DB
- `campaign_id / angle_id / cta_id / price_variant_id` 追加

### Phase 2

- note 売上スクレイパ安定化
- session health
- 自動降格

### Phase 3

- Threads insights 回収
- tracking 紐付け

### Phase 4

- `15m / 1h / 1d / 1w` job 分割
- PM2 常駐統合

### Phase 5

- `human_review` 全廃
- `auto-rewrite / auto-skip / auto-quarantine / rollback`

### Phase 6

- Revenue Brain
- executive の funnel 駆動化

### Phase 7

- Experiment Engine
- Thompson Sampling
- 勝ち型 DB 反映

### Phase 8

- `agents / playbooks / policies` 契約化
- frontmatter 統一

### Phase 9

- ダッシュボードを承認UIから観測UIへ変更

## 23. 採用 / 非採用

### 採用

- 5部署構造維持
- 完全自律
- 収益閉ループ中心
- SQLite を唯一の通信路
- Claude 主系 / Codex 副系 / Copilot 任意
- `15m / 1h / 1d / 1w` multi-tier scheduling
- JSON 契約ワーカー
- state machine ベース運用

### 非採用

- Scheduler が直接 LLM CLI を叩く構成
- OpenClaw 中核採用
- 部署同士の自由会話
- `human_review` 前提運用
- CLI を OS とみなす設計

## 24. 最終結論

ThreadsOS の正式な最終設計は、Node.js + TypeScript + SQLite の本体がスケジュール・状態管理・収益判定を握り、Claude Code を主系、Codex CLI を副系にした pluggable runner 構成で、5部署を JSON 契約ワーカーとして動かし、売上ファネル最適化ループを完全自律で回す収益最適化OSとする。
