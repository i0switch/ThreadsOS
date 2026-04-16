# ThreadsOS 最終設計図 v3.0

**確定日**: 2026-04-14
**ステータス**: 正式版（以降揺るがさない）
**位置づけ**: v1/v2 系統 + 外部意見7件 + 補強4ファイルを全統合した壊れにくい収益最適化OSの確定仕様
**統合元**:
- 外部意見5件（ドキュメント配管/収益ループ/heartbeat単一目的/Scheduler順序/Runner pluggable）
- `docs/ThreadsOS_final_spec.md` → task_type enum / ディレクトリ役割
- `docs/ThreadsOS-最終設計図.md`（v1） → 採用対照表 / note storage原則 / 4軸改善対象
- `docs/ThreadsOS-final-spec-v2.0.md` → Job Lease / Outbox / Budget Governor / Circuit Breaker / Degrade Modes / Decision Evidence / Contract Compiler / Canary / Anomaly Watcher
- `docs/ThreadsOS-最終設計図.md`（正式版） → 監査=横断機能 / 状態機械 / 収益スコア式 / 責務分離 / SLO

---

## 0. 目的（1つだけ）

**収入を生むこと**。
そのために Threads と note の運用を完全自律で回し、売上ファネルを観測しながらボトルネックを特定し、改善実験を打ち続ける。

---

## 1. 一行定義

ThreadsOS = Node.js + TypeScript + SQLite + Playwright + PM2 を本体にしたローカル常駐の deterministic な運用OSが状態管理・実行管理・収益判定・安全制御を握り、Claude Code（主系）/ Codex CLI（副系）/ Copilot CLI（予備）を pluggable な推論ワーカーとして役割別ルーティングし、売上ファネル最適化ループを完全自律で回す収益運用基盤。

短く言うと: **骨格は deterministic、思考だけ CLI LLM に委譲**。

---

## 2. v3.0 の強化点（v2 からの差分）

v2 系の設計に加え、**壊れにくく・再現性高く・運用事故に強い**形へ引き上げる16項目を追加：

| # | 強化項目 | 意義 |
|---|---|---|
| 1 | Job Lease / Idempotency | PM2再起動・Task Scheduler再実行時の二重投稿防止 |
| 2 | Outbox Pattern | 投稿予定と実投稿を分離、失敗時再送・監査可 |
| 3 | Runner Budget Governor | Claude/Codex/Copilot の日次・時間帯予算をDB管理 |
| 4 | Runner Circuit Breaker | 連続失敗runnerの自動隔離 |
| 5 | Degrade Modes (A/B/C/D) | 部分障害でOS全停止しない |
| 6 | Decision Evidence Ledger | 全意思決定の「なぜ」を証跡化 |
| 7 | Contract Compiler | 起動前 lint/compile、schema不整合はブロック |
| 8 | Canary Rollout | 新パターンは少量配信→昇格 |
| 9 | Anomaly Watcher | 急激な指標悪化を別系統で監視 |
| 10 | 補助メトリクス6種 | インプレ最適化モンスター化防止 |
| 11 | 監査=横断機能 | 「5部署維持」と「監査必要」を両立 |
| 12 | 状態機械明示化 | asset/experiment/session の遷移を deterministic 管理 |
| 13 | 収益スコア式 | 遅延指標と代理指標を重み付き統合 |
| 14 | 責務分離リスト | deterministic / LLM / LLM禁止を3カテゴリ明示 |
| 15 | SLO 数値化 | 運用SLOと収益SLOを数値目標化 |
| 16 | task_type 8種化 | rewrite 追加 |

---

## 3. 絶対条件

| 原則 | 内容 |
|---|---|
| 概念固定 | 初期ThreadsOS構想（5部署・完全自律・人間非介入）は変更しない |
| 人間非介入 | 運用中の human 介入禁止。human_review 全廃 |
| 収益最大化が目的 | 投稿数や活動量ではなく **収益** を目的関数に置く |
| 収益閉ループ中心 | 本体は部署ごっこではなく、観測→診断→実験→実行→採点→学習→次回反映 |
| Scheduler順序 | Scheduler → ThreadsOS Core → LLM Runner の順序固定 |
| Scheduler直叩き禁止 | Task Scheduler / PM2 が直接 `claude -p` / `codex` を叩かない |
| 状態管理 | SQLiteが唯一の通信路。部署間の会話経路は禁止 |
| DB最終責任 | DB整合性の最終責任は ThreadsOS Core が握る（LLMに書かせない） |
| サブスク縛り | LLMはサブスク経由（claude / codex / gh copilot）。API課金は使わない |
| vendor-neutral | 契約書は `agents/` `playbooks/` `policies/` 配置 |
| 再ログイン依存禁止 | note-storage-state 失効は quarantine。運用中の再ログイン依存禁止 |
| 迷ったら止める | 「迷ったら人間に上げる」は禁止。「止める or 安全化する」のみ |

---

## 4. 用語の固定

### 4.1 5部署（概念構造・維持）

- 管理・指揮系統
- 外部リサーチ部署
- 競合リサーチ分析部署
- Threads運用部署
- note運用部署

### 4.2 横断機能

- **監査 / 安全機能**（第6部署ではなく、全体を横断する安全レイヤー）

これで「5部署維持」と「監査の必要性」を両立させる。

---

## 5. 採用 / 非採用

### 採用

- 5部署構造維持 + 横断監査
- 完全自律
- 収益閉ループ中心
- SQLite を唯一の通信路
- Claude 主系 / Codex 副系 / Copilot 任意
- Multi-tier scheduling（15m / 1h / 1d / 1w）
- human_review 全廃（auto-rewrite / skip / quarantine / rollback 4択）
- 1 heartbeat = 1ボトルネック改善
- ベンダー中立ディレクトリ（`agents/` `playbooks/` `policies/`）
- JSON契約ワーカー
- 状態機械ベース運用
- Job Lease / Outbox / Budget Governor / Circuit Breaker / Degrade Modes / Contract Compiler / Canary / Anomaly Watcher

### 非採用

- Scheduler が直接 LLM CLI を叩く構成
- OpenClaw 中核採用
- 部署同士の自由会話
- human_review 前提運用
- Claude 単独固定ランナー
- 1つの heartbeat で全部やる設計
- LLM に DB を直接書かせる設計
- 運用中の note 再ログイン依存
- CLI を OS とみなす設計

---

## 6. 全体アーキテクチャ

```
Windows Task Scheduler / PM2
  -> ThreadsOS Core
    -> Job Scheduler (multi-tier)
    -> Job Lease Manager (idempotency)
    -> Revenue Brain (funnel router)
    -> Experiment Engine (Thompson sampling + Canary)
    -> Policy Guard (auto-rewrite/skip/quarantine/rollback)
    -> Session Health Monitor
    -> Anomaly Watcher
    -> Budget Governor
    -> Circuit Breaker
    -> LLM Runner Router
      -> Claude Code   (PRIMARY)
      -> Codex CLI     (FALLBACK)
      -> Copilot CLI   (OPTIONAL)
    -> Execution Outbox
      -> Threads Graph API
      -> Playwright note client
    -> SQLite (唯一の台帳)
    -> Decision Evidence Ledger
```

### Layer 構成

| Layer | 責務 |
|---|---|
| 1. Scheduler | PM2常駐（主系）+ Windows Task Scheduler（復旧保険）。ThreadsOS本体だけ起動 |
| 2. ThreadsOS Core | heartbeat / revenue brain / experiment / policy guard / retry / quarantine / rollback / lease / outbox / circuit breaker / budget / anomaly / DB整合性の最終責任 |
| 3. LLM Runner | Claude/Codex/Copilot を同一JSON I/O契約で切替 |
| 4. Execution | Threads Graph API / Playwright note / outbox consumer |
| 5. State | SQLite（唯一の真実）/ agents・playbooks・policies / migrations / decision evidence |

---

## 7. ディレクトリ構造

```
ThreadsOS/
├── src/
│   ├── core/
│   │   ├── heartbeat.ts
│   │   ├── job-lease.ts              # idempotency
│   │   ├── revenue-brain.ts
│   │   ├── experiment-engine.ts
│   │   ├── canary-rollout.ts
│   │   ├── policy-guard.ts
│   │   ├── session-health.ts
│   │   ├── anomaly-watcher.ts
│   │   ├── budget-governor.ts
│   │   ├── circuit-breaker.ts
│   │   ├── degrade-modes.ts
│   │   └── contract-compiler.ts      # 起動前 lint
│   ├── llm/
│   │   ├── runner.interface.ts
│   │   ├── claude-code.runner.ts
│   │   ├── codex-cli.runner.ts
│   │   ├── copilot-cli.runner.ts
│   │   └── router.ts
│   ├── outbox/
│   │   ├── enqueue.ts
│   │   └── consumer.ts
│   ├── adapters/
│   │   ├── threads-graph.ts
│   │   ├── note-playwright.ts
│   │   └── note-session-guard.ts
│   ├── db/
│   │   ├── schema.ts
│   │   └── migrations/
│   └── dashboard/                    # 観測UI
├── agents/                           # ワーカー契約書
│   ├── executive.md
│   ├── research.md
│   ├── competitor.md
│   ├── threads.md
│   ├── note.md
│   └── auditor.md
├── playbooks/                        # 手順書
│   ├── funnel-diagnosis.md
│   ├── experiment-selection.md
│   ├── threads-generation.md
│   ├── note-generation.md
│   ├── reply-policy.md
│   ├── rollback-policy.md
│   ├── degrade-modes.md
│   └── canary-rollout.md
└── policies/                         # 全体制約
    ├── brand.md
    ├── monetization.md
    ├── safety.md
    ├── pricing.md
    ├── rate-budget.md
    └── runner-health.md
```

### 起動前検査

- Contract Compiler が `agents/` `playbooks/` `policies/` を lint / compile
- schema 不整合 → 起動ブロック
- `agents/` が正本、CLI別変換物は生成物

---

## 8. deterministic と LLM の責務分離

### 8.1 deterministic にやること

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
- Job Lease
- Outbox / Consumer
- Anomaly 検知
- Circuit Breaker 開閉

### 8.2 LLM にやらせること

- Threads文案生成
- note本文生成
- 返信文生成
- 競合からの示唆抽出
- 実験案生成
- 監査補助
- 失敗理由の要約

### 8.3 LLM にやらせないこと

- DB更新の最終決定
- 投稿処理そのもの
- 実行キューの整合性管理
- セッション管理
- リトライ制御
- 人間レビュー待ち判断

---

## 9. Multi-tier Schedule

| 周期 | ジョブ | LLM呼出 |
|---|---|---|
| 15分 | session_health / metrics_sync / runner_health / rate_budget_sync / stuck_job / anomaly_scan / quarantine_queue 再判定 | 0回 |
| 1時間 | funnel_diagnosis → bottleneck選定 → 実験1つ → Threads投稿/reply → note導線更新 → 24h/72h採点予約 | 1-2回 |
| 1日 | note記事生成・公開 / 勝ち型資産化 / 翌日配分更新 / memory compression / asset pruning | 3-5回 |
| 1週 | 価格最適化 / テーマ配分更新 / loser整理 / strategy refresh / policy drift review | 1-3回 |

### 9.1 固定原則

**1時間 heartbeat = 1ボトルネック改善。毎回全部署フル稼働は禁止。**

### 9.2 レート試算（Claude Max サブスク前提）

- 1h × 24 × 2 = 48 calls
- 1d × 5 = 5 calls
- 1w × 3 / 7 ≈ 0.4 calls
- **計 ≈ 53 calls/day** → Max プラン内で回る

---

## 10. 1時間 heartbeat 固定仕様

```
1. [Job Lease 取得] 二重起動ガード
   ↓
2. [ルール] ファネル集計（LLM呼出 0回）
   ↓
3. [ルール] 最弱段を1つだけ選定：Reach / Click / Read / Buy の1つ
   ↓
4. [LLM 1回] 該当段に対し、runner router 経由で改善アクション生成
   ↓
5. [ルール] Policy Guard 通過チェック
   pass → auto-execute
   軽微fail → auto-rewrite (LLM 1回)
   session異常 → auto-quarantine
   confidence低 → auto-skip
   ↓
6. [ルール] Canary 対象なら少量配信モードで実行
   ↓
7. [Outbox] 投稿予定を execution_outbox に enqueue
   ↓
8. [Consumer] outbox consumer が実投稿
   ↓
9. [ルール] DB更新 + Decision Evidence 記録
   ↓
10. [ルール] 24h / 72h 採点タスクを enqueue
   ↓
11. [Job Lease 解放]
```

---

## 11. 収益ファネル定義

### 11.1 主ファネル6段（固定）

```
impressions
  → profile_transitions
    → note_clicks
      → note_views
        → purchases
          → revenue
```

### 11.2 補助メトリクス

- `reply_rate`
- `save_rate`
- `follow_conversion`
- `refund_rate`
- `complaint_signal`
- `session_integrity_score`

### 11.3 ファネル × 改善対象軸マッピング

| ボトルネック | 改善対象 |
|---|---|
| **Reach 弱い**（impressions低） | テーマ / フック / 投稿時間 / 競合角度 |
| **Click 弱い**（profile→click低） | CTA / 導線文 / プロフ文 / 1投稿目構成 |
| **Read 弱い**（click→view低） | noteタイトル / 導入 / 見出し / サムネ訴求 |
| **Buy 弱い**（view→purchase低） | 記事テーマ / 価格 / オファー / 販売前教育 |

---

## 12. 収益スコア（Revenue Score）

単純なインプレ最適化に落ちないよう、重み付きスコアを持つ：

```
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

- 最終目的は `revenue`
- 遅延指標なので近接代理指標もスコアに含める
- 重みは運用データから週次で自動キャリブレーション

---

## 13. 状態機械

### 13.1 Threads asset state

```
drafted → audited → scheduled → published → measured → scored → archived
```

### 13.2 note asset state

```
drafted → audited → scheduled → published → measured → scored → archived
```

### 13.3 Experiment state

```
planned → active → measuring → completed → promoted | rejected | quarantined
```

### 13.4 Session state

```
healthy → degraded → quarantined → recovered
```

### 13.5 原則

- 状態遷移は deterministic に処理
- LLM は遷移理由の提案はできるが、**遷移実行は本体がやる**

---

## 14. LLM Runner 抽象層

### 14.1 統一I/O契約

```typescript
type TaskType =
  | 'funnel_advice'
  | 'threads_generation'
  | 'note_generation'
  | 'reply_generation'
  | 'audit'
  | 'strategy_review'
  | 'failure_analysis'
  | 'rewrite';

interface LLMRunnerInput {
  task_type: TaskType;
  tier: 'light' | 'medium' | 'heavy';
  role: 'executive' | 'threads' | 'note' | 'research' | 'competitor' | 'auditor';
  json_schema: JSONSchema;
  context_bundle: {
    funnel_snapshot: FunnelSnapshot;
    winning_patterns: Pattern[];
    current_bottleneck: 'Reach' | 'Click' | 'Read' | 'Buy';
    recent_failures: Failure[];
    budget_remaining: number;
  };
  confidence_required: 'low' | 'medium' | 'high';
}

interface LLMRunnerOutput {
  decision: object;
  confidence: number;
  reasons: string[];
  artifacts: {
    draft_id?: string;
    patch?: string;
    query?: string;
  };
  next_actions: Action[];
  runner_meta: {
    runner: 'claude' | 'codex' | 'copilot';
    duration_ms: number;
    retry_count: number;
    token_budget_bucket?: string;
  };
}
```

### 14.2 役割別ルーティング表

| task_type | Primary | Fallback | 理由 |
|---|---|---|---|
| funnel_advice | Claude | Codex | 戦略判断の文脈保持 |
| threads_generation | Claude | Copilot | 長文・トーン安定 |
| note_generation (2000字+) | Claude | Codex | 構成力 |
| reply_generation | Claude | Copilot | トーン・共感 |
| JSON 厳格構造化 | **Codex** | Claude | schema 遵守強い |
| failure_analysis | **Codex** | Claude | 思考深度 |
| strategy_review（週次） | **Codex** | Claude | 重い再分析 |
| audit / policy違反検知 | Claude | Codex | 倫理判断 |
| rewrite（軽量文面修正） | **Copilot** | Claude | レート節約 |

### 14.3 Fallback ポリシー

1. Primary timeout（>60秒）→ Fallback へ
2. JSON schema 不合格 → 同 runner で1回再生成
3. 2回失敗 → `auto-quarantine` + `failure_reason` 記録
4. 連続失敗閾値超過 → **Circuit Breaker 開放**（該当runner隔離）
5. confidence < threshold → 実行せずDB保留
6. Budget Governor が日次/時間帯上限到達 → 該当runner一時停止

---

## 15. Budget Governor / Circuit Breaker

### 15.1 Budget Governor

| runner | 管理対象 |
|---|---|
| Claude | 日次呼出上限 / 5h窓上限 / 緊急バジェット |
| Codex | 日次呼出上限 / 5h窓上限 |
| Copilot | 日次呼出上限 |

- `runner_budget` テーブルで管理
- 15分ジョブで rate/budget sync
- 超過時は該当 runner への呼出を停止し、fallback へ切替

### 15.2 Circuit Breaker

- `runner_health` テーブルで timeout率・JSON不正率・連続失敗数を追跡
- 閾値超過 → Circuit Open（該当 runner 隔離）
- 一定時間経過後 → Half-Open（試験呼出）→ 成功なら Close

---

## 16. Degrade Modes

### Mode A: Full Autonomy
すべて正常稼働

### Mode B: Threads-only
note session 異常時
- note生成 / 公開 停止
- Threads は既存note導線付きで継続

### Mode C: Observe-only
投稿系 adapter に障害
- 計測だけ継続
- 新規 experiment 停止

### Mode D: Safe Freeze
複数系統障害
- 投稿停止
- DB / metrics / health のみ継続
- 自動復帰条件を監視

**モード遷移は deterministic。**LLMは遷移提案はできるが実行しない。

---

## 17. 部署 = JSON契約ワーカー

### 17.1 部署一覧（5部署 + 横断監査）

| 部署 | 役割 | 区分 |
|---|---|---|
| 管理・指揮系統 (executive) | heartbeat毎の意思決定・実験選定・予算配分 | 5部署 |
| 外部リサーチ (research) | テーマ・市場動向調査 | 5部署 |
| 競合リサーチ分析 (competitor) | 勝ちパターン抽出 | 5部署 |
| Threads運用 (threads) | 上流ファネル改善 | 5部署 |
| note運用 (note) | 下流ファネル改善 | 5部署 |
| 監査/安全 (auditor) | 誇張・炎上・規約違反・低品質の自動排除 | **横断機能** |

### 17.2 契約 frontmatter テンプレート

```yaml
---
name: threads-publisher
role: Threads投稿実行ユニット
layer: execution
input_schema:
  bottleneck: enum[Reach, Click, Read, Buy]
  target_campaign_id: uuid
  winning_patterns_ref: query
  competitor_diff_ref: query
  budget_llm_calls: int
output_schema:
  posts:
    - hook: string
      body: string
      cta_id: uuid
      schedule_ts: iso8601
  confidence: 0.0-1.0
success_criteria:
  metric: profile_transition_rate
  target: baseline * 1.1
  eval_window: 24h
forbidden:
  - 誇大表現
  - 規約違反ワード
  - 曖昧CTA
llm_budget: 1
primary_runner: claude
fallback_runner: codex
failure_mode: auto-skip
confidence_rule:
  high: auto-execute
  medium: canary-only
  low: skip
---
```

### 17.3 通信ルール

- 部署間通信は **SQLite のみ**
- 自由会話禁止
- 各部署は DB を読んで DB に書くだけ
- md は人格設定ではなく契約書

---

## 18. SQLiteスキーマ（26テーブル）

### 18.1 実体系
| テーブル | 役割 |
|---|---|
| campaigns | テーマ × 角度 × 価格 × CTA の実験単位 |
| content_assets | 全コンテンツ資産の親 |
| drafts | 未公開の投稿・記事下書き |
| publication_events | 投稿実行履歴 |

### 18.2 計測系
| テーブル | 役割 |
|---|---|
| threads_metrics | imp / like / reply / share / view per post |
| note_metrics | view / like / purchase per article |
| revenue_events | 売上発生イベント |
| funnel_snapshots | 時系列6段スナップショット |

### 18.3 学習系
| テーブル | 役割 |
|---|---|
| experiments | AB実験定義 |
| experiment_results | 採点結果（24h / 72h） |
| winning_patterns | 勝ち hook / CTA / price / theme DB |
| losing_patterns | 負け型・炎上・低品質パターン |
| pricing_variants | 価格AB試験の履歴 |

### 18.4 運用系
| テーブル | 役割 |
|---|---|
| executive_decisions | heartbeat毎の意思決定ログ |
| agent_artifacts | 部署ワーカー出力JSON |
| session_health | storage_state / API token 健康度 |
| rollbacks | rollback実行履歴 |
| memory_summaries | 戦略要約・週次振り返り |

### 18.5 v3追加系（信頼性）
| テーブル | 役割 |
|---|---|
| job_runs | 各ジョブ実行記録 |
| job_leases | 二重起動防止 |
| execution_outbox | 投稿予定enqueue → consumer実行 |
| decision_evidence | 意思決定の証跡（参照metrics・runner出力要約・rollback理由） |
| runner_health | timeout率 / JSON不正率 / 連続失敗数 / circuit breaker状態 |
| runner_budget | 日次・5h窓・緊急バジェット |
| feature_flags | 機能フラグ |
| anomaly_events | 指標急変・炎上兆候・session劣化 |

### 18.6 既存テーブル追加必須カラム

- `campaign_id` / `angle_id` / `cta_id` / `price_variant_id` / `canary_group`

---

## 19. Outbox Pattern

```
1. Policy Guard 通過
   ↓
2. execution_outbox に enqueue（この時点ではまだ投稿されていない）
   ↓
3. Outbox Consumer が order 通りに取り出し
   ↓
4. Threads Graph API / Playwright note で実投稿
   ↓
5. 成功 → publication_events 書込
   失敗 → retry / quarantine
```

### 利点

- 投稿予定と実投稿を分離
- 失敗時の再送・監査が容易
- Job Lease と組合せて二重投稿を防止

---

## 20. Revenue Brain + Experiment Engine + Canary

### 20.1 Revenue Brain 入力

- current funnel summary（6段 + 補助6種）
- weakest stage（Reach / Click / Read / Buy）
- current active experiments
- winning patterns
- recent failures
- session health
- budget status
- current degrade mode

### 20.2 Revenue Brain 出力

- 改善対象 stage 1つ
- 実行アクション 最大3つ
- 優先度
- deploy可否
- rollback条件
- canary group 指定

### 20.3 Experiment Engine ループ

1. funnel 集計
2. 最弱段特定
3. 改善仮説 3つ生成
4. 低リスク高期待値を 1つ採用
5. **Canary で少量投入**
6. 24h / 72h 採点
7. 勝ちなら昇格（全量展開）
8. 負けなら rollback + `losing_patterns` 登録

### 20.4 実験対象リスト

- hook / CTA / 投稿時間 / noteタイトル / note導入 / 価格 / 導線文 / テーマ切り口

### 20.5 学習アルゴリズム

- **Thompson Sampling**（軽量 multi-armed bandit）
- 初期2週間：探索70% / 活用30%（seed hypothesis を priors として投入）
- 以降：探索30% / 活用70%

---

## 21. 完全自律・安全仕様

### 21.1 human_review 全廃 → 4択のみ

| 状況 | アクション |
|---|---|
| Policy Guard pass + confidence high | `auto-execute` |
| Policy Guard fail（軽微） | `auto-rewrite`（LLM 1回再生成） |
| confidence low | `auto-skip`（次heartbeatで再評価） |
| confidence low + 連続失敗 / session異常 | `auto-quarantine` |

### 21.2 追加ガード

- confidence 低 → 実行しない
- note session 異常 → note系隔離（Mode B へ）
- Threads token 異常 → observation-only（Mode C へ）
- 指標急落 → rollback
- 危険表現検知 → rewrite
- 危険な価格変更 → skip
- runner 障害 → fallback / circuit breaker
- 複数系統障害 → Mode D (Safe Freeze)

### 21.3 自動 rollback 発動条件

直近24hで以下のどれかが発生 → 直前の勝ちパターンへ自動復帰
- CTR 前週比 -30%
- 購入率 前週比 -50%
- クレーム系ワード出現率 +100%
- note価格変更後CV悪化

### 21.4 コールドスタート対策

- `docs/inputs/` + `docs/research/` の仮説をベイズ事前分布に変換
- 初期2週間：探索70% / 活用30%
- 以降：探索30% / 活用70%

---

## 22. note / Threads 観測

### 22.1 Threads

- Graph API で insights 回収
- 投稿単位で `campaign_id / angle_id / cta_id / canary_group` 必ず紐付け

### 22.2 note

- Playwright + `note-storage-state.json`
- 記事公開
- 売上ダッシュボード取得
- article 単位で `views / purchases / revenue / conversion` 保存

### 22.3 note 運用の絶対原則

- `note-storage-state.json` は **初期セットアップ資産としてのみ** 使う
- session 失効を 15分ジョブで監視
- 失効時は note 系ジョブを **quarantine**
- **運用中の再ログイン依存を持ち込まない**
- 失効検知ロジックは `note-session-guard.ts` に集約

### 22.4 投稿実行フロー（Outbox経由）

1. 直接即時 publish しない
2. まず `execution_outbox` に enqueue
3. consumer が実行
4. 成否を `publication_events` に書く

---

## 23. SLO（Service Level Objective）

### 23.1 運用SLO

| 項目 | 目標 |
|---|---|
| 15分ジョブ成功率 | 99% 以上 |
| 1時間ジョブ成功率 | 95% 以上 |
| note session 健全率 | 90% 以上 |
| JSON schema 準拠率 | 98% 以上 |
| quarantine からの自動復帰率 | 80% 以上 |

### 23.2 収益SLO

- 売上ゼロ日を減らす
- note 公開後 72h で最低1回は計測更新
- 実験ごとの 24h / 72h 採点欠損率 5% 未満

---

## 24. 常駐・復旧

### 24.1 常駐

- **PM2 を主系**
- `start:daemon` コマンドで常駐起動

### 24.2 復旧保険

- Windows Task Scheduler で PM2 再起動復旧
- 異常終了時の PM2 再起動
- ログローテーション

### 24.3 原則

- **Task Scheduler が直接 CLI LLM を叩かない**
- Task Scheduler / PM2 は ThreadsOS job を起動するだけ

---

## 25. ダッシュボード（観測UI）

完全自律なので、ダッシュボードは **承認UIではなく観測UI**。

### 表示項目

- 今日のボトルネック
- 今回の実験（+ canary 状況）
- runner health / budget
- current degrade mode
- session health
- 直近勝ち型 / 負け型
- 売上ファネル（6段 + 補助6種）
- anomaly events
- quarantine 中ジョブ
- rollback 履歴
- decision evidence
- outbox / stuck jobs

既存 README の承認/却下機能は、最終形ではオフにする。

---

## 26. OpenClaw の扱い

**本体には入れない。今は不要。**

理由:
- 今必要なのは gateway ではなく収益OS
- ローカル deterministic 実行を先に固める段階
- 完全自律と相性が悪い（chat操作UI = 人間介入を誘発）
- 既存 Node/TS + DB + heartbeat を活かす方が速い

将来のオプションとして保留:
- 外部ワーカー管理
- 別マシン実行
- 監視基盤拡張

---

## 27. Phase 実装順（10段階）

| # | Phase | 主作業 | 委譲先 | 期間 |
|---|---|---|---|---|
| 0 | Runner抽象 + Budget + Breaker | `runner.interface.ts` + 3 runners + router + budget governor + circuit breaker | Gemini | 5日 |
| 1 | DB拡張 + Lease + Outbox | 26テーブル追加 + job_lease + execution_outbox + decision_evidence | Gemini | 4日 |
| 2 | 計測基盤 | Threads Graph insights + note Playwright sales scraper + session guard + anomaly watcher | Gemini | 5日 |
| 3 | Publish安定化 | auto-publisher retry + quarantine + human_review経路削除 + outbox consumer | Gemini | 3日 |
| 4 | heartbeat分割 + Degrade Modes | multi-tier (15m/1h/1d/1w) + PM2 + Mode A/B/C/D | Gemini | 3日 |
| 5 | コールドスタート | `docs/inputs/` seed注入 + 初期priors | Gemini | 2日 |
| 6 | Revenue Brain | funnel router + executive funnel駆動化 + 収益スコア | Gemini | 3日 |
| 7 | Experiment Engine + Canary | Thompson sampling + canary rollout + 24h/72h採点 | Gemini | 4日 |
| 8 | 部署契約化 + Contract Compiler | `agents/` `playbooks/` `policies/` + frontmatter統一 + 起動前lint | Claude直 | 3日 |
| 9 | 観測ダッシュボード | 承認UI → 観測UI 変換 | Gemini | 3日 |

**想定スケジュール**:
- Phase 0-3: 2.5週間（基盤＋計測＋公開）
- Phase 4-7: 2週間（ループ稼働）
- Phase 8-9: 1週間（契約化＋UI）
- **計 約5〜6週間で自律収益ループ完全稼働**

---

## 28. 確定事項サマリ

| 項目 | 決定 |
|---|---|
| 本体 | Node.js + TypeScript + SQLite（常駐） |
| トリガー | Windows Task Scheduler + PM2 |
| Scheduler直叩き | 禁止（本体起動のみ） |
| 主系LLM | Claude Code |
| 副系LLM | Codex CLI |
| 予備LLM | Copilot CLI |
| 部署構造 | 5部署維持 + 横断監査（計6ユニット） |
| 部署間通信 | SQLite のみ |
| 契約書配置 | `agents/` `playbooks/` `policies/`（vendor-neutral） |
| heartbeat | Multi-tier（15m/1h/1d/1w）、1 heartbeat = 1目的 |
| human_review | 全廃（auto-rewrite / skip / quarantine / rollback 4択） |
| ファネル | 6段固定 + 補助6種 |
| 収益スコア | 重み付き合成（revenue / purchases / views / clicks / transitions / follows - penalties） |
| 最適化 | Thompson sampling + Canary rollout |
| SQLite | **26テーブル** |
| task_type | **8種 enum** |
| 信頼性機構 | Job Lease / Outbox / Budget Governor / Circuit Breaker / Contract Compiler |
| 障害対応 | Degrade Modes (A/B/C/D) |
| 監視 | Anomaly Watcher 別系統 |
| 証跡 | Decision Evidence Ledger |
| SLO | 15分99% / 1h 95% / note session 90% / JSON 98% / quarantine復帰 80% |
| OpenClaw | 保留 |
| note 再ログイン | 運用中禁止 |

---

## 29. Phase 0 Gemini 委譲スクリプト

```powershell
& "C:\Users\i0swi\OneDrive\デスクトップ\claude.alibaba\scripts\gemini-delegate.ps1" `
    -Task "ThreadsOS Phase 0 実装: LLM Runner抽象層 + Budget Governor + Circuit Breaker" `
    -Mode implement `
    -Targets @(
        "src/llm/runner.interface.ts",
        "src/llm/claude-code.runner.ts",
        "src/llm/codex-cli.runner.ts",
        "src/llm/copilot-cli.runner.ts",
        "src/llm/router.ts",
        "src/core/budget-governor.ts",
        "src/core/circuit-breaker.ts",
        "src/db/schema.ts",
        "src/db/migrations/"
    ) `
    -Constraints @(
        "LLMはサブスク経由（claude -p / codex / gh copilot）、API課金禁止",
        "全runner 同一 JSON I/O契約、task_type 8種 enum",
        "tier は light/medium/heavy",
        "Fallback: timeout→副系、JSON不正→1回再生成、2回失敗→quarantine、連続失敗→Circuit Breaker開放",
        "Budget Governor: 日次/5h窓/緊急 をrunner_budgetテーブルで管理",
        "Circuit Breaker: timeout率/JSON不正率/連続失敗数をrunner_healthで追跡、閾値超過でOpen",
        "runner_meta に token_budget_bucket 含む",
        "既存 note-storage-state.json 流用、Windows + PM2 常駐前提"
    )
```

---

## 30. 最終結論

v3.0 の ThreadsOS は、**単に「完全自律で回る」だけじゃなく、重複実行・runner障害・session失効・計測欠損・急激な指標悪化にも耐える、壊れにくい収益最適化OS**として定義する。

言い切るとこれ:

> **本体がOS、LLMは差し替え可能な推論ワーカー、DBは唯一の台帳、Outbox と Lease で事故を防ぎ、Experiment Engine で売上を伸ばし、Degrade Modes で壊れず、Decision Evidence で全部追跡する。**

---

## 付録: 統合ソース一覧

### 外部意見（5件）
1. 収益閉ループ中心・KPI資産化・自動安全層
2. heartbeat 単一目的化・human_review 3択代替
3. コールドスタート対策・note売上スクレイパ優先・サブスク縛り
4. LLM Runner pluggable 層・Multi-tier scheduling
5. Scheduler → Core → LLM 順序固定・vendor-neutral 契約書

### 補強4ファイル
- `docs/ThreadsOS_final_spec.md`：task_type 7種 / 実験対象詳細 / ディレクトリ役割
- `docs/ThreadsOS-最終設計図.md`（v1）：採用/非採用対照表 / note storage 原則 / memory_summaries
- `docs/ThreadsOS-final-spec-v2.0.md`：Job Lease / Outbox / Budget Governor / Circuit Breaker / Degrade Modes / Decision Evidence / Contract Compiler / Canary / Anomaly Watcher / 補助メトリクス / task_type 8種
- `docs/ThreadsOS-最終設計図.md`（正式版）：監査=横断 / 状態機械 / 収益スコア式 / 責務分離 / SLO / Phase 9段

これら全意見の統合と収束の結果として本設計 v3.0 を確定する。
