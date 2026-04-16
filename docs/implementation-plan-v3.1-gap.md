# ThreadsOS v3.1 仕様ギャップ 追加実装指示書

> **作成日**: 2026-04-15
> **根拠仕様書**: `docs/ThreadsOS-final-spec-v3.1.md`（= `C:/Users/i0swi/Downloads/ThreadsOS-implementation-prompt-pack-v1/00-design/01-ThreadsOS-final-spec-v3.1.md`）
> **根拠監査**: 2026-04-15 Claude Opus 4.6 による全コード突合監査
> **実装完了率（監査時点）**: 約 85〜90%
> **この指示書の対象**: 監査で検出された未実装項目の補完と、旧仕様ドキュメントの整理

---

## 0. 前提

### 0.1 仕様書の読み順
1. `docs/ThreadsOS-final-spec-v3.1.md` を **正本** とする
2. `docs/ThreadsOS-final-spec-v2.0.md` `docs/ThreadsOS-final-spec-v1.md` `仕様書.md`（プロジェクトルート）は **旧版**。参照禁止
3. `agents/` `playbooks/` `policies/` のMarkdown群が契約書の実体

### 0.2 実装の大原則（v3.1より再掲）
- human_review を**復活させない**
- 5部署構造を維持（management / external-research / competitor-research / threads / note）
- 監査/安全は**横断レイヤー**（第6部署ではない）
- Scheduler が直接 LLM CLI を叩かない
- 状態の真実は **SQLite**
- deterministic と LLM の責務を混ぜない
- **固定値を仕様に焼き込まない**（policy/DB で制御）

### 0.3 実装時のブランチ運用
- 各Phase完了ごとに個別コミット
- Phaseまたがる一括コミット禁止（rollback容易性のため）

---

## Part 1: 🔴 Critical — `campaigns` テーブル新設

### 1.1 目的
`thread_post_drafts` / `note_drafts` / `threads_metrics` / `note_metrics` / `publication_events` / `content_slots` などに既存の `campaign_id TEXT` カラムがあるのに **実体テーブルが無い**。集計・参照整合性・ダッシュボード集計が成立しない。

### 1.2 依存
- 既存 migration: `0005_phase1_runtime_ledger.sql` で各テーブルに `campaign_id` カラムは追加済み
- 本タスクは「実体」と「最小限のCRUD経路」を追加する

### 1.3 実装指示

#### 1.3.1 Migration 追加
**ファイル**: `src/db/migrations/0008_campaigns.sql`（新規）

```sql
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  theme TEXT NOT NULL,
  bottleneck_focus TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  started_at TEXT NOT NULL,
  ended_at TEXT,
  reasoning TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS campaigns_status_started_idx
ON campaigns (status, started_at);
```

**制約**:
- `status` enum: `active | paused | archived`
- `bottleneck_focus` enum: `Reach | Click | Read | Buy | null`
- 固定値（enum列挙）は schema.ts 側の TypeScript 定数で定義、DB レベルでは CHECK 制約を付けない（SQLite migration の簡素化のため）

#### 1.3.2 schema.ts 追記
**ファイル**: `src/db/schema.ts`（既存）

既存の状態 enum の近くに：
```ts
export const CAMPAIGN_STATUSES = ["active", "paused", "archived"] as const;
export const CAMPAIGN_BOTTLENECKS = ["Reach", "Click", "Read", "Buy"] as const;
```

テーブル定義を `funnelSnapshots` の近くに追加：
```ts
export const campaigns = sqliteTable(
  "campaigns",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    theme: text("theme").notNull(),
    bottleneckFocus: text("bottleneck_focus"),
    status: text("status").notNull().default("active"),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
    reasoning: text("reasoning"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    statusStartedIdx: index("campaigns_status_started_idx").on(
      table.status,
      table.startedAt,
    ),
  }),
);
```

#### 1.3.3 repository 追加
**ファイル**: `src/db/repositories/campaigns.ts`（新規）

最低限必要なメソッド:
- `listActive()` — status='active' を startedAt DESC で返す
- `findById(id)` — 単一取得
- `create(input)` — id は `randomUUID()` で自動採番
- `updateStatus(id, status, reasoning?)` — archive/pause遷移
- `setBottleneckFocus(id, bottleneck)` — executive が書く

全メソッド deterministic（LLM呼び出し禁止）。

#### 1.3.4 bootstrap 更新
**ファイル**: `src/db/bootstrap.ts`

`ensureAutonomyTables()` に campaigns テーブルの存在チェック追加。DDL は migration と同じSQL。

#### 1.3.5 ダッシュボード集計
**ファイル**: `src/services/dashboard-observation/index.ts`

既存の集計メソッドに `getCampaignRevenue(campaignId)` / `listCampaignSummaries()` を追加:
- campaigns と revenue_events を join
- campaigns と funnel_snapshots を join
- 6段ファネルを campaign_id 別に返す

### 1.4 受け入れ基準
- [ ] `pnpm test` が新規テストを含めて全pass
- [ ] `campaigns` テーブルが migration 再適用でも冪等に作成される
- [ ] ダッシュボードで "アクティブキャンペーン一覧" が表示される（最低1件の seed でも可）
- [ ] 既存の `thread_post_drafts.campaign_id` が campaigns.id を参照する結線が 1 本以上ある（executive or content-scheduler から）

### 1.5 テスト
**ファイル**: `tests/campaigns.test.ts`（新規）

- campaign create → listActive で取得できる
- updateStatus('archived') で listActive から除外される
- setBottleneckFocus で bottleneck_focus が更新される

---

## Part 2: 🟠 High-1 — `pricing_variants` テーブル新設

### 2.1 目的
v3.1 §16 学習系に必須定義。`note_drafts.price_variant_id` / `note_metrics.price_variant_id` / `revenue_events.price_variant_id` が各所で参照されているが実体無し。価格A/B テスト（§19 実験対象「価格」）が成立しない。

### 2.2 依存
- pricing policy (`policies/pricing.md` の `maxSingleStepPercent: 20`) に適合する価格変動管理が前提
- `rollback-policy` playbook の「価格変更後のCV低下でrollback」と連動する

### 2.3 実装指示

#### 2.3.1 Migration 追加
**ファイル**: `src/db/migrations/0009_pricing_variants.sql`（新規）

```sql
CREATE TABLE IF NOT EXISTS pricing_variants (
  id TEXT PRIMARY KEY NOT NULL,
  article_id TEXT NOT NULL,
  campaign_id TEXT,
  price_yen INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'canary',
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  baseline_price_yen INTEGER,
  evidence_json TEXT,
  activated_at TEXT NOT NULL,
  superseded_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS pricing_variants_article_idx
ON pricing_variants (article_id, activated_at);

CREATE INDEX IF NOT EXISTS pricing_variants_status_idx
ON pricing_variants (status);
```

**status enum**: `canary | promoted | rolled_back | archived`

#### 2.3.2 schema.ts 追記
```ts
export const PRICING_VARIANT_STATUSES = [
  "canary",
  "promoted",
  "rolled_back",
  "archived",
] as const;

export const pricingVariants = sqliteTable(
  "pricing_variants",
  {
    id: text("id").primaryKey(),
    articleId: text("article_id").notNull(),
    campaignId: text("campaign_id"),
    priceYen: integer("price_yen").notNull(),
    status: text("status").notNull().default("canary"),
    wins: integer("wins").notNull().default(0),
    losses: integer("losses").notNull().default(0),
    baselinePriceYen: integer("baseline_price_yen"),
    evidenceJson: text("evidence_json"),
    activatedAt: text("activated_at").notNull(),
    supersededAt: text("superseded_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    articleIdx: index("pricing_variants_article_idx").on(
      table.articleId,
      table.activatedAt,
    ),
    statusIdx: index("pricing_variants_status_idx").on(table.status),
  }),
);
```

#### 2.3.3 repository 追加
**ファイル**: `src/db/repositories/pricing-variants.ts`（新規）

メソッド:
- `createCanary(articleId, newPriceYen, baselinePriceYen, campaignId?)` — 新価格canary投入
- `promote(id, evidence)` — canary→promoted
- `rollback(id, reason)` — promoted→rolled_back、baseline に戻す副作用あり
- `recordOutcome(id, won: boolean)` — wins/losses インクリメント（Thompson Samplingで使用）
- `getActiveFor(articleId)` — 現時点の有効variant

#### 2.3.4 auto-publisher 連携
**ファイル**: `src/services/auto-publisher/index.ts`

note投稿時の価格決定ロジックで、`pricing_variants` から article_id に対する `promoted` または `canary` を取得し `priceYen` を引いて投稿に流す。policy の `maxSingleStepPercent: 20` を deterministic に検証し、超過時は canary 作成を拒否する（degrade_mode へ escalate）。

#### 2.3.5 Thompson Sampling 連携
**ファイル**: `src/services/executive-experiment/index.ts`

`rankByThompson` を `pricing_variants` に適用するエントリポイントを追加。  
既存 bandit.ts の `BanditPriorInput { wins, losses }` シグネチャを流用するだけ（新規実装不要）。

### 2.4 受け入れ基準
- [ ] canary → promoted / rolled_back 遷移のテスト
- [ ] `maxSingleStepPercent: 20` の policy 適合検証（超過時は reject）
- [ ] auto-publisher が実投稿で `pricing_variants` の promoted 価格を使用する
- [ ] ダッシュボードに "価格実験中のarticle一覧" が表示される

### 2.5 テスト
**ファイル**: `tests/pricing-variants.test.ts`（新規）

---

## Part 3: 🟠 High-2 — `memory_summaries` テーブル新設

### 3.1 目的
v3.1 §16 運用系で明示。`src/services/memory/` は存在するが、**永続化先が無い**。ハートビート間で要約を再利用するにはDB書き戻しが必要。仕様§7「1日ごと: memory compression」が成立しない。

### 3.2 依存
- 既存 `src/services/memory/index.ts` （メモリ組立ロジックあり）
- 1日tier (`src/jobs/tier-1d.ts`) に summary 更新フックを追加

### 3.3 実装指示

#### 3.3.1 Migration 追加
**ファイル**: `src/db/migrations/0010_memory_summaries.sql`（新規）

```sql
CREATE TABLE IF NOT EXISTS memory_summaries (
  id TEXT PRIMARY KEY NOT NULL,
  scope TEXT NOT NULL,
  period_type TEXT NOT NULL,
  period_key TEXT NOT NULL,
  summary TEXT NOT NULL,
  raw_ref_ids_json TEXT,
  token_estimate INTEGER NOT NULL DEFAULT 0,
  generated_by TEXT NOT NULL DEFAULT 'deterministic',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS memory_summaries_scope_period_unique
ON memory_summaries (scope, period_type, period_key);

CREATE INDEX IF NOT EXISTS memory_summaries_scope_type_idx
ON memory_summaries (scope, period_type, updated_at);
```

**enums**:
- `scope`: `executive | research | competitor | threads | note | cross_cutting`
- `period_type`: `hourly | daily | weekly | ad_hoc`
- `generated_by`: `deterministic | claude | codex | copilot`

#### 3.3.2 schema.ts 追記
上記 enum 定数 + `memorySummaries` sqliteTable を追加。

#### 3.3.3 memory service 拡張
**ファイル**: `src/services/memory/index.ts`

追加メソッド:
- `writeSummary(scope, periodType, periodKey, summary, rawRefIds, tokenEstimate, generatedBy)` — UPSERT
- `readLatestSummary(scope, periodType)` — 直近の summary 取得
- `compressDailyMemory()` — 1日tier から呼ぶ。過去24hの生イベントを要約して summary に落とす
- `pruneStaleSummaries(olderThanDays)` — 期限切れ削除

`generated_by: 'deterministic'` の場合はLLM呼び出しなし（件数/件名の統計的要約）。`generated_by: 'claude' | 'codex'` の場合は runner-router 経由でLLMに要約依頼（budget governor 通過必須）。

#### 3.3.4 tier-1d.ts 連携
```ts
// tier-1d.ts 内で daily-topic-research 実行後に追加
await memoryService.compressDailyMemory();
```

#### 3.3.5 working-memory-builder 参照
hourly-heartbeat のコンテキスト組立時に `readLatestSummary` を引いて、生データではなく要約を流し込む経路を確保する（仕様§11 「E. KPIスナップショット」「B. 部署別要約メモリ」）。

### 3.4 受け入れ基準
- [ ] 1日tier実行後に `memory_summaries` に少なくとも1レコード入る
- [ ] 同一 `(scope, period_type, period_key)` は UPSERT で重複しない
- [ ] hourly-heartbeat が過去summaryを読んでトークン削減する（ログで確認）

### 3.5 テスト
**ファイル**: `tests/memory-summaries.test.ts`（新規）

---

## Part 4: 🟡 Medium — 補助テーブル追加（まとめて1マイグレーション）

### 4.1 目的
v3.1 §16 で明示されている残りのテーブルを補完。運用の最低要件ではないが、仕様整合性のため追加。

### 4.2 実装指示

#### 4.2.1 Migration 追加
**ファイル**: `src/db/migrations/0011_remaining_spec_tables.sql`（新規）

```sql
-- v3.1 §16 運用系: executive の判断ログ（現状 executiveCycles で代替中だが仕様準拠のため分離）
CREATE TABLE IF NOT EXISTS executive_decisions (
  id TEXT PRIMARY KEY NOT NULL,
  cycle_id TEXT NOT NULL,
  bottleneck TEXT NOT NULL,
  decision_type TEXT NOT NULL,
  selected_action TEXT NOT NULL,
  rejected_candidates_json TEXT,
  confidence REAL NOT NULL DEFAULT 0,
  reasons_json TEXT NOT NULL,
  budget_snapshot_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS executive_decisions_cycle_idx
ON executive_decisions (cycle_id, created_at);

-- v3.1 §16 実体系: content_assets（drafts の上位概念。現状 thread/note に分割されているが
-- cross-channel なアセット管理のため最小の台帳として追加）
CREATE TABLE IF NOT EXISTS content_assets (
  id TEXT PRIMARY KEY NOT NULL,
  asset_type TEXT NOT NULL,
  channel TEXT NOT NULL,
  source_draft_id TEXT,
  campaign_id TEXT,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'drafted',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS content_assets_channel_status_idx
ON content_assets (channel, status, updated_at);

-- v3.1 §16 信頼性系: feature_flags（段階的rollout制御）
CREATE TABLE IF NOT EXISTS feature_flags (
  key TEXT PRIMARY KEY NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  rollout_percent INTEGER NOT NULL DEFAULT 0,
  scope TEXT,
  notes TEXT,
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- v3.1 §16 運用系: agent_artifacts（部署ごとの中間成果物）
-- 既存の agent_states とは別に、LLM出力を保持する台帳
CREATE TABLE IF NOT EXISTS agent_artifacts (
  id TEXT PRIMARY KEY NOT NULL,
  agent_id TEXT NOT NULL,
  cycle_id TEXT,
  artifact_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  confidence REAL,
  runner TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS agent_artifacts_agent_cycle_idx
ON agent_artifacts (agent_id, cycle_id, created_at);
```

#### 4.2.2 schema.ts 追記
上記4テーブルをdrizzle sqliteTable 定義で追加。enum は同じ章で列挙。

#### 4.2.3 既存置換検討
- `proposals` テーブル（現状存続）は **v3.1仕様には無い** が、`executive_decisions` と役割重複。  
  ✳️ **今回は proposals を削除しない**（互換性維持）。将来のリファクタ時に `executive_decisions` へ集約する方針とする。

### 4.3 受け入れ基準
- [ ] 4テーブルすべて migration 適用後に存在する
- [ ] 既存テストが壊れない（新テーブルは optional 参照のみ）
- [ ] executiveCycles 実行後に `executive_decisions` にも書かれる経路を1本つなぐ

---

## Part 5: 🟠 High-3〜H5 — ドキュメント整理

### 5.1 目的
旧仕様書（v1/v2系）のドキュメントが残存していてv3.1実装と矛盾。future-self や新規参加者が誤誘導される。

### 5.2 実装指示

#### 5.2.1 旧仕様書のアーカイブ化
以下ファイルを `docs/archive/` に移動:

```
ファイル移動（git mv を使う）:
- 仕様書.md                              → docs/archive/v1-spec-legacy.md
- docs/ThreadsOS-final-spec-v1.md        → docs/archive/spec-v1.md
- docs/ThreadsOS-final-spec-v2.0.md      → docs/archive/spec-v2.0.md
- docs/ThreadsOS_final_spec.md           → docs/archive/spec-final-legacy.md
- docs/ThreadsOS-最終設計図.md           → docs/archive/design-doc-legacy.md
- docs/修正案-完全自律化.md              → docs/archive/reform-proposal-legacy.md
- docs/final-plan-v2.md                  → docs/archive/final-plan-v2.md
- docs/improvement-plan-2026-04-05.md    → docs/archive/improvement-plan-v2.md
- docs/audit-report-v2-2026-03-29.md     → docs/archive/audit-report-v2.md
- docs/implementation-prompts.md         → docs/archive/implementation-prompts-v2.md
- SPEC_GAP_ANALYSIS.md                   → docs/archive/spec-gap-analysis-v2.md
- ARCHITECTURE.md                        → docs/archive/architecture-v2.md
```

**残すもの**:
- `docs/ThreadsOS-final-spec-v3.1.md` ← 正本
- `docs/spec-completion-2026-04-10.md` ← 実装進捗記録（要Update）
- `docs/runbook.md` / `RUNBOOK.md` ← 運用手順（要Update）
- `README.md` ← 要v3.1準拠に書き換え

#### 5.2.2 ARCHITECTURE.md 書き直し
**ファイル**: `ARCHITECTURE.md`（新規に書き直し）

v3.1準拠の構成図（mermaid）を持つ。以下のセクションを含める:

1. 全体アーキテクチャ（v3.1 §5 をベース）
2. 5部署 + 横断auditor 構成図
3. Multi-tier scheduling（15m/1h/1d/1w）のフロー図
4. Outbox pattern のシーケンス図
5. Degrade mode 遷移図
6. データ層: v3.1 §16 の全テーブル一覧（本指示書完了後の最新構成）

#### 5.2.3 README.md 書き換え
**ファイル**: `README.md`

現状はレガシー情報混在。以下を反映:
- セットアップ: pnpm + Node.js + SQLite + PM2 + Playwright
- 起動: `pnpm dev` または PM2 ecosystem
- スケジューラ: Windows Task Scheduler または PM2 cron
- 環境変数: `.env.example` 参照
- note セッション: `NOTE_STORAGE_STATE_PATH` 方式（手動再ログイン不要）
- dashboard: http://localhost:PORT （Fastify + htmx）
- v3.1準拠である旨を明記

#### 5.2.4 新規 `docs/v3.1-compliance.md` 作成
本指示書完了後に、compliance 状態を別ドキュメントで記録する（監査結果の公式記録）。

### 5.3 受け入れ基準
- [ ] `docs/archive/` 配下に旧ドキュメントが移動され、ルートから参照されない
- [ ] `ARCHITECTURE.md` がv3.1の5部署+横断auditorを正しく描画
- [ ] `README.md` にv3.1の単語（deterministic, outbox, canary, degrade mode, bandit 等）が登場
- [ ] `CLAUDE.md` / `AGENTS.md` に旧仕様書への参照が残っていない（要grep）

---

## Part 6: 🟢 Low — 監査ログ・追跡整備

### 6.1 decision_evidence 書き込み網羅性の確認
現状 `decision_evidence` テーブルは存在するが、全ての deterministic判断ポイントで書かれているか未確認。以下のタイミングで必ず evidence を書く:

- executive が bottleneck を選定したとき
- experiment を promote/reject したとき
- operations-mode が遷移したとき
- rollback を適用したとき
- pricing_variant が canary→promoted したとき

**ファイル**: 各サービスの判断箇所で `decisionEvidence` への書き込みを漏れなく追加。

### 6.2 anomaly_events の発火箇所追加
- runner 連続失敗
- job_lease 取得失敗
- outbox stuck
- note session 失効
- 指標急落（CTR, purchase_rate, complaint_signal）

### 6.3 受け入れ基準
- [ ] 1hour heartbeat 1回実行で `decision_evidence` に最低3件書かれる
- [ ] runner 異常時に `anomaly_events` にレコードが残る

---

## Part 7: 実装順序とブランチ戦略

### 推奨実装順
```
Phase G1 (Critical):       Part 1 (campaigns)
Phase G2 (High-1):         Part 2 (pricing_variants)
Phase G3 (High-2):         Part 3 (memory_summaries)
Phase G4 (Medium):         Part 4 (4 tables bundle)
Phase G5 (Docs):           Part 5 (ドキュメント整理)
Phase G6 (Observability):  Part 6 (decision_evidence/anomaly 網羅)
```

### ブランチ命名
```
feat/g1-campaigns
feat/g2-pricing-variants
feat/g3-memory-summaries
feat/g4-remaining-spec-tables
chore/g5-docs-cleanup
feat/g6-observability-gaps
```

### コミット粒度
- 各Phaseで最低 2コミット（schema/migration追加 と service連携追加）
- すべて co-author 付き
- 各Phase完了時に `pnpm test` / `pnpm run build` / `pnpm run lint` が全pass であることが絶対条件（`pnpm typecheck` というscriptは存在しないので注意）

---

## Part 8: 全体完了条件（v3.1完全準拠）

以下をすべて満たせば v3.1完全準拠とみなす:

- [ ] Part 1〜6 すべての受け入れ基準を満たす
- [ ] `pnpm test` が全pass
- [ ] `pnpm run build` がエラー0（tsc が型チェックを兼ねる。専用 `typecheck` script は存在しない）
- [ ] `pnpm run lint` が warning 以外エラー0（内部で `biome check .` を実行）
- [ ] `pnpm run contracts:compile` が通る（`agents/` `playbooks/` `policies/` の Contract Compiler lint）
- [ ] `pnpm run job:heartbeat:dry` で 1時間 heartbeat を完走させ、v3.1 §8 の11ステップがログに現れる
- [ ] `pnpm dev` 起動後、Fastify dashboard で "アクティブキャンペーン" "実験中" "価格variant" "degrade mode" の4指標が表示される
- [ ] `docs/archive/` に旧ドキュメントが移動されている
- [ ] `docs/v3.1-compliance.md` が書き出され、本指示書の全タスクに ✅ が付いている

---

## 付録A: 参照コマンド集

> ⚠️ 実在scriptはすべて `package.json` に準拠。憶測のscript名を使わないこと。

### migration 適用
```bash
pnpm run db:migrate
```

### 契約書 compile / lint
```bash
pnpm run contracts:compile
```

### 1時間 heartbeat dry-run
```bash
pnpm run job:heartbeat:dry
```

### 1時間 heartbeat 本番実行
```bash
pnpm run job:heartbeat
```

### tier 手動実行（本番）
```bash
pnpm run job:tier:15m
pnpm run job:tier:1h
pnpm run job:tier:1d
pnpm run job:tier:1w
```

### tier 手動実行（dry-run）
```bash
pnpm run job:tier:15m:dry
pnpm run job:tier:1h:dry
pnpm run job:tier:1d:dry
pnpm run job:tier:1w:dry
```

### dashboard / API サーバ起動
```bash
pnpm dev
# 内部的には tsx watch src/server/index.ts で Fastify が起動する
# 専用 dashboard script は存在しない
```

### PM2 常駐（daemon）
```bash
pnpm run start:daemon   # pm2 start ecosystem.config.cjs && pm2 save
pnpm run stop:daemon    # 全tier + llm-worker 停止
pnpm run logs           # pm2 logs
```

### テスト / 型チェック / lint
```bash
pnpm test               # vitest run
pnpm run build          # tsc（型チェック兼ねる。typecheck 専用script は無い）
pnpm run lint           # biome check .
```

---

## 付録B: v3.1仕様書との対応表（差分のみ）

| v3.1仕様書 項 | 現状実装 | ギャップ | 対応タスク |
|---|---|---|---|
| §16 実体系 `campaigns` | **未実装** | 実体無し（campaign_id 参照のみ） | Part 1 |
| §16 実体系 `content_assets` | **未実装** | drafts で代替 | Part 4 |
| §16 実体系 `drafts` | `thread_post_drafts` / `note_drafts` | チャネル別分割済（許容） | — |
| §16 実体系 `publication_events` | 実装済 | ✅ | — |
| §16 計測系 `threads_metrics` `note_metrics` `revenue_events` `funnel_snapshots` | 実装済 | ✅ | — |
| §16 学習系 `experiments` `experiment_results` `winning_patterns` `losing_patterns` | 実装済 | ✅ | — |
| §16 学習系 `pricing_variants` | **未実装** | price_variant_id 参照のみ | Part 2 |
| §16 運用系 `executive_decisions` | **未実装** | executiveCycles で代替中 | Part 4 |
| §16 運用系 `agent_artifacts` | **未実装** | agent_states のみあり | Part 4 |
| §16 運用系 `session_health` | 実装済 | ✅ | — |
| §16 運用系 `rollbacks` | 実装済 | ✅ | — |
| §16 運用系 `memory_summaries` | **未実装** | memoryService はあるがDB無し | Part 3 |
| §16 信頼性系 `job_runs` `job_leases` `execution_outbox` `decision_evidence` `runner_health` `runner_budget` `anomaly_events` | 実装済 | ✅ | — |
| §16 信頼性系 `feature_flags` | **未実装** | 段階rollout不可 | Part 4 |
| その他すべての章 (§1〜§26) | 実装済 | ✅ | — |

---

**本指示書に従って実装を進めれば、v3.1 完全準拠を達成できる。**  
実装順はPart 1→2→3→4→5→6 を推奨。各Phase は独立しているので並列化可能（ただしschema変更はシリアル）。
