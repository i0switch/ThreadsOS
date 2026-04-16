# ThreadsOS 自律運用基盤改修 作業プロンプト

## 背景

ThreadsOSは「ユーザーは初期設定だけ、以降はシステムが自律運用」が設計思想。しかし現在の実装には以下の問題がある。

1. Executive LLMにエラー情報が渡されておらず、障害の自律解決ができない
2. プロポーザルの承認者が `dashboard-human` にハードコードされており、Executive自律承認パスが存在しない
3. エージェント配置が仕様と乖離（競合調査員がthreads/noteに分散、幽霊エージェントが残存）
4. 競合リサーチ分析部署のエージェントが `analyze_competitors` のみ対応で、7日に1回しか起動しない
5. 部署名・エージェント名・役割名がすべて英語で、日本語化されていない

### 現在の部署構成（確認済み）

DepartmentName型はすでに5部署: `command`, `external-research`, `competitive-analysis`, `threads`, `note`
DepartmentExecutionServiceImplのexecutorも5つ。部署構造自体の変更は不要。

---

## 改修1: Executive LLMへのエラー情報注入 + 自律エラー解決

### 目的

Executiveが「今何が壊れているか」を認識し、自律的にエラー対処を判断できるようにする。

### 対象ファイル

- `src/services/executive/index.ts` — `buildExecutivePrompt()`
- `src/jobs/hourly-heartbeat.ts` — エラー情報収集・承認済みプロポーザル自動実行
- `src/services/proposal-flow/index.ts` — Executive自律承認パスの追加
- `src/services/engagement-analysis/index.ts` — LLMパース失敗時のフォールバック改善

### 作業内容

#### 1-A: Executiveプロンプトにエラー情報を追加

ファイル: `src/services/executive/index.ts` の `buildExecutivePrompt()` (L207-292)

現在のプロンプトは部署レポートと候補アクションのみ。以下を追加入力する:

- `diff.newErrors` の件数と直近エラーメッセージ（`scheduled_job_runs` テーブルから `status='failed'` の直近5件）
- `human_review_items` テーブルの `status='pending'` 件数と概要
- `proposals` テーブルの `status='pending'` 件数と概要
- `consecutiveFailures` の現在値

プロンプトに「エラー解消アクション」を返せる選択肢を追加:

```
## 直近のエラー状況
- 失敗ジョブ: {件数}件（直近: {エラーメッセージ}）
- 未処理レビュー: {件数}件
- 未処理プロポーザル: {件数}件
- 連続失敗数: {consecutiveFailures}

エラーが存在する場合、以下の対処を検討せよ:
- 回復可能なエラー（一時的なAPI障害等）→ 該当アクションを再スケジュール
- pending レビューの自律判断 → 安全と判断できるものは自動承認
- pending プロポーザルの自律承認 → Executiveとして承認可能なものは承認
```

**実装メモ:** `buildExecutivePrompt()` の引数を拡張し、heartbeatから収集したエラー情報を受け取れるようにする。現在は `(reports, candidateActions)` の2引数。

#### 1-B: Executive自律承認パスの追加

ファイル: `src/services/proposal-flow/index.ts`

- `createHierarchicalProposal()` の L84-85 を変更:
  - 現在: `currentStage: "human_review"`, `currentApproverId: "dashboard-human"` 固定
  - 変更後: まず `currentStage: "executive_review"`, `currentApproverId: "executive-director"` とする
  - Executiveが「人間確認が必要」と明示判断した場合のみ `currentStage: "human_review"` に昇格

- ハートビート冒頭（`hourly-heartbeat.ts`）に以下を追加:
  - `proposals` テーブルから `currentStage='executive_review'` かつ `status='pending'` のレコードを取得
  - ExecutiveのLLM判断コンテキストに含め、承認/却下/人間エスカレーションを判断させる
  - 承認された場合は対応アクションを実行キューに追加

#### 1-C: 承認済みプロポーザルの自動実行

ファイル: `src/jobs/hourly-heartbeat.ts`

- ハートビートのStep 2付近（L335以降）に追加:
  - `proposals.status = 'approved'` かつ未実行のレコードを取得
  - 対応する `actionType` を実行キューに追加して通常のアクション実行フローに乗せる

#### 1-D: LLMパース失敗時のフォールバック改善

ファイル: `src/services/engagement-analysis/index.ts`

- L749付近: JSON解析失敗時のデフォルトを `human_review` から `ignore` に変更
  - 現在: `parseJsonObject(raw) ?? { decision: "human_review", sentiment: "neutral" }`
  - 変更後: 1回目のパース失敗時は再試行（最大1回）を実施。2回目も失敗したら `ignore` として記録

#### 1-E: human_review_items の自動再評価

ファイル: `src/jobs/hourly-heartbeat.ts`

- ハートビート内に追加:
  - `human_review_items.status = 'pending'` のレコードを取得
  - 現在のコンテキストでLLM再評価し、安全と判断されれば `status='approved'` に自動更新
  - 判断できない場合のみ pending のまま残す（ただしユーザーには通知しない — Executiveが次サイクルで再評価する）

---

## 改修2: エージェント配置の整理

### 目的

現在の5部署構造を維持しつつ、エージェントの所属・ID・不要エージェントを整理する。

### 現状の問題点

| エージェントID | 現在のdepartment | 問題 |
|---|---|---|
| `threads-competitor-researcher` | `threads` | 競合調査員なのにthreadsに所属 |
| `note-competitor-researcher` | `note` | 競合調査員なのにnoteに所属 |
| `community-director` | `competitive-analysis` | IDが旧部署名のまま |
| `reply-manager` | `threads` | `actions: []` — 何も実行できない幽霊エージェント |
| `optimization-director` | `command` | `notify`のみ。executive-directorと重複 |
| `cadence-optimizer` | `threads` | 独立エージェントの必要性が低い |
| `engagement-analyst` | `competitive-analysis` | `leaderId: "community-director"` — 旧ID参照 |

### 対象ファイル

- `src/services/runtime-state/index.ts` — AGENTS配列とresolveAgents()

### 作業内容

#### 2-A: エージェントの再配置・削除

**移動:**

| エージェントID | 変更前department | 変更後department | leaderId変更 |
|---|---|---|---|
| `threads-competitor-researcher` | `threads` | `competitive-analysis` | `"threads-operations-director"` → `"competitive-analysis-director"` |
| `note-competitor-researcher` | `note` | `competitive-analysis` | `"note-operations-director"` → `"competitive-analysis-director"` |

**ID変更:**

| 変更前ID | 変更後ID | 理由 |
|---|---|---|
| `community-director` | `competitive-analysis-director` | 実態に合わせる |

**注意:** `engagement-analyst` の `leaderId` も `"community-director"` → `"competitive-analysis-director"` に更新する。

**削除:**

| エージェントID | 理由 |
|---|---|
| `reply-manager` | `actions: []` で機能なし。reply_safeは `threads-reply-generator` が担当 |
| `optimization-director` | `notify` のみ。`executive-director` のactions に `notify` を含めるか、削除 |
| `cadence-optimizer` | `optimize_schedule`, `weekly_retro` は `threads-operations-director` が既にsupports |

**削除時の確認:** `resolveAgents()` の `preferredWorkers` マッピングで削除エージェントを参照している箇所を更新:
- `weekly_retro: "cadence-optimizer"` → `"threads-operations-director"`
- `optimize_schedule: "cadence-optimizer"` → `"threads-operations-director"`
- `notify: "optimization-director"` → `"executive-director"`

**DB既存レコードのクリーンアップ:** `ensureCatalog()` は upsert 方式のため、ID変更・削除したエージェントの旧レコードが `agent_states` テーブルに残り続ける。改修2の実装後に以下のDELETE文を1回実行すること:

```sql
DELETE FROM agent_states WHERE id IN ('community-director', 'reply-manager', 'optimization-director', 'cadence-optimizer');
```

または `ensureCatalog()` の末尾に、AGENTS配列に存在しないIDを削除するクリーンアップロジックを追加する。

#### 2-B: 整理後の5部署構成（全フィールド記載）

**管理・指揮系統（command）— 1名**

| ID | name | role | leaderId | actions |
|---|---|---|---|---|
| executive-director | Executive Director | executive | — | `["process_human_inputs", "notify"]` |

**外部リサーチ（external-research）— 2名**

| ID | name | role | leaderId | actions |
|---|---|---|---|---|
| research-director | Research Director | leader | — | `["research_threads"]` |
| trend-researcher | Trend Researcher | researcher | `research-director` | `["research_threads"]` |

**競合リサーチ分析（competitive-analysis）— 4名**

| ID | name | role | leaderId | actions |
|---|---|---|---|---|
| competitive-analysis-director | Competitive Analysis Director | leader | — | `["analyze_competitors"]` |
| threads-competitor-researcher | Threads Competitor Researcher | competitor_research | `competitive-analysis-director` | `["research_threads"]` |
| note-competitor-researcher | note Competitor Researcher | competitor_research | `competitive-analysis-director` | `["research_note"]` |
| engagement-analyst | Competitive Signal Analyst | analyst | `competitive-analysis-director` | `["analyze_competitors"]` |

**Threads運用（threads）— 4名**

| ID | name | role | leaderId | actions |
|---|---|---|---|---|
| threads-operations-director | Threads Operations Director | leader | — | `["research_threads", "generate_and_post", "fetch_engagement", "reply_safe", "optimize_schedule", "weekly_retro"]` |
| threads-post-generator | Threads Post Generator | generator | `threads-operations-director` | `["generate_and_post"]` |
| threads-engagement-analyst | Threads Engagement Analyst | analyst | `threads-operations-director` | `["fetch_engagement"]` |
| threads-reply-generator | Threads Reply Generator | reply_generator | `threads-operations-director` | `["reply_safe"]` |

**note運用（note）— 3名**

| ID | name | role | leaderId | actions |
|---|---|---|---|---|
| note-operations-director | note Operations Director | leader | — | `["research_note", "generate_note", "optimize_schedule"]` |
| note-article-generator | note Article Generator | generator | `note-operations-director` | `["generate_note"]` |
| note-engagement-analyst | note Engagement Analyst | analyst | `note-operations-director` | `["generate_note", "optimize_schedule"]` |

合計: 14名（現在の17名から3名削減）

---

## 改修3: 全名称の日本語化

### 目的

部署名・エージェント名・役割名をすべて日本語に統一する。

### 対象ファイル

- `src/services/runtime-state/index.ts` — AGENTS配列のname
- `src/services/dashboard-query/index.ts` — ダッシュボード向け表示名
- `src/dashboard/public/index.html` — UI上の表示

### 作業内容

#### 3-A: エージェント定義の日本語化

ファイル: `src/services/runtime-state/index.ts` のAGENTS配列

| 現在のname | 新しいname |
|---|---|
| Executive Director | 総合指揮官 |
| Research Director | リサーチ部長 |
| Trend Researcher | トレンド調査員 |
| Competitive Analysis Director | 競合分析部長 |
| Threads Competitor Researcher | Threads競合調査員 |
| note Competitor Researcher | note競合調査員 |
| Competitive Signal Analyst | エンゲージメント分析官 |
| Threads Operations Director | Threads運用部長 |
| Threads Post Generator | Threads投稿生成員 |
| Threads Engagement Analyst | Threadsエンゲージメント調査員 |
| Threads Reply Generator | Threads返信生成員 |
| note Operations Director | note運用部長 |
| note Article Generator | note記事生成員 |
| note Engagement Analyst | noteエンゲージメント調査員 |

#### 3-B: ダッシュボードの表示名マッピング更新

ファイル: `src/services/dashboard-query/index.ts`

- workstreamSnapshots、departmentHighlights等のlabel/nameを日本語に統一

**注意:** エージェントIDは英語のまま維持する（DBキー・コード内参照に使われるため）。日本語化するのは `name` フィールドのみ。

---

## 改修4: 競合リサーチ分析部署の強化

### 目的

7日に1回しか動かない競合分析を、毎ハートビートで何かしらの仕事をする活性部署にする。

### 対象ファイル

- `src/services/content-scheduler/index.ts` — `analyze_competitors` の生成条件 + ActionType追加
- `src/services/department-execution/index.ts` — competitive-analysis executorのsupports拡充
- `src/services/research/index.ts` — 競合スナップショット収集の分離

### 作業内容

#### 4-A: ActionType に `fetch_competitor_updates` を追加

ファイル: `src/services/content-scheduler/index.ts`

- `ActionType` 型定義 (L23-34) に `"fetch_competitor_updates"` を追加
- `analyze_competitors` の生成条件を168時間→24時間に短縮 (L524)
- 新アクション `fetch_competitor_updates` のスケジュール条件を追加（6時間間隔）

#### 4-B: resolveDepartmentName に新アクション追加

ファイル: `src/domain/department/index.ts`

- `resolveDepartmentName()` のswitch文に `case "fetch_competitor_updates": return "competitive-analysis";` を追加

#### 4-C: competitive-analysis executorのsupports拡充

ファイル: `src/services/department-execution/index.ts`

- `createCompetitiveAnalysisExecutor()` (L326-479):
  - 現在: `supports: (actionType) => actionType === "analyze_competitors"` (L330)
  - 変更後: `supports: (actionType) => ["analyze_competitors", "fetch_competitor_updates"].includes(actionType)`
- `fetch_competitor_updates` のexecute実装を追加:
  - 競合スナップショットの差分更新（軽量）
  - 結果を threads/note/command へ `competitor_update` 通知として送信

#### 4-D: resolveAgents の preferredWorkers 更新

ファイル: `src/services/runtime-state/index.ts`

- `preferredWorkers` マッピング (L173-184) に追加:
  - `analyze_competitors: "engagement-analyst"`
  - `fetch_competitor_updates: "threads-competitor-researcher"`

**注意:** 現在 `analyze_competitors` は preferredWorkers に未登録で、`resolveAgents()` のフォールバックパス（L188-191: actions配列を検索して `engagement-analyst` を発見）で解決されている。明示追加で動作は変わらないが、意図を明確にするために追加する。

#### 4-E: threads executorの `research_threads` から競合スナップショット収集を分離

現在の状態:
- threads executor (L486-494): `research_threads` をsupports → `orchestration.runDailyTopicResearch()` を呼び出す
- external-research executor (L263): `research_threads` をsupports → 同じく `orchestration.runDailyTopicResearch()` を呼び出す
- competitive-analysis executor (L330): `analyze_competitors` のみsupports → `research.analyzeCompetitorSnapshots()` を呼び出す

**具体的な分離方針:**
- `research_threads` は「テーマ・トレンド調査」として external-research と threads に残す（現状維持）
- 新アクション `fetch_competitor_updates` で「競合スナップショットの差分収集」を competitive-analysis executor が担当する（4-Cで追加済み）
- threads executor の `research_threads` 実行時に、競合スナップショット収集を行わないことを確認する（現在の実装では `runDailyTopicResearch()` に含まれていないため、実質的に分離済み）
- つまり4-Eは**新たなコード変更は不要**。4-A〜4-Dの追加で目的は達成される

---

## 実行順序

1. **改修2（エージェント配置整理）** — 構造を正してから他の改修に入る
2. **改修3（日本語化）** — 配置整理後の正しい構成に対して日本語化
3. **改修4（競合分析強化）** — 部署構成・名称が確定した後に新機能を追加
4. **改修1（自律エラー解決）** — 最後。部署構成が確定した後にExecutiveのプロンプトを最終調整

**順序の根拠:** 元のプロンプトでは改修3（日本語化）が先だったが、エージェント配置が不正確な状態で日本語名を付けると、移動・削除時にdiffが複雑になる。構造整理を先に行い、確定した構成に日本語名を付ける方が安全。

## 制約

- テストは `vitest` で実行（`npx vitest run`）
- DB マイグレーションは不要（Drizzle ORM の push で対応）
- エージェントIDは英語のまま維持（DBキーのため）。ただし `community-director` → `competitive-analysis-director` のID変更は例外（旧部署名の残骸のため）
- `LLM_MODE=heartbeat` 前提（Claude Code経由のLLM呼び出し）
- 各改修後にハートビート1回実行して動作確認すること
- DepartmentName型（5部署）は変更不要。既に正しい構成
