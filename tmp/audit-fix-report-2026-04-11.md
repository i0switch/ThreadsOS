# 監査レポート修正結果

作成日時: 2026-04-11
対象監査: audit-report-2026-04-11-221622.md

## 修正サマリー

| # | 修正項目 | 対象要件 | ステータス |
|---|---------|---------|-----------|
| 1 | ハートビート本体のループ実行モード追加 | 要件18, 21 | 完了 |
| 2 | Threads部署の競合リサーチ実行パス接続 | 要件54, 59, 24 | 完了 |
| 3 | エグゼクティブ多軸ポリシー拡張 | 要件42, 83, 9 | 完了 |
| 4 | 管理系統のコンテンツ・返信介入強化 | 要件40, 41 | 完了 |
| 5 | 外部リサーチの市場動向・ジャンル理解強化 | 要件44, 45 | 完了 |

## 検証結果

- TypeScript型チェック: エラーなし
- テスト: 33ファイル 162テスト 全パス

---

## 修正詳細

### 1. ハートビート本体のループ実行モード追加

**対象要件:**
- 要件18: 実行方式としてループ実行を想定する → **未実装 → 実装済み**
- 要件21: 1時間に1回をアプリ内部でも保証 → **一部実装 → 実装済み**

**変更ファイル:**
- `src/jobs/heartbeat-loop.ts` (新規作成)
- `package.json` (スクリプト追加)
- `ecosystem.config.cjs` (PM2設定追加)

**実装内容:**
- `heartbeat-loop.ts`: 子プロセス方式のループ実行モジュール。`child_process.fork` でハートビートを毎回独立プロセスとして起動し、`HEARTBEAT_LOOP_INTERVAL_MS` 環境変数（デフォルト3,600,000ms = 1時間）で間隔を制御。SIGINT/SIGTERMによるグレースフルシャットダウン対応。
- `package.json`: `job:heartbeat:loop` と `job:heartbeat:loop:dry` スクリプトを追加。
- `ecosystem.config.cjs`: `heartbeat-loop` アプリ定義を追加。`autorestart: true` で常駐化し、内部タイマーで1時間間隔を自律的に保証。

**設計判断:**
- 既存の `hourly-heartbeat.ts` は600行超のインライン関数であるため、リファクタリングではなく別モジュール＋子プロセス方式を採用。メモリリーク防止とプロセス分離を両立。
- 既存のPM2 cron_restart方式 (`threads-heartbeat`) は互換性維持のため残置。

---

### 2. Threads部署の競合リサーチ実行パス接続

**対象要件:**
- 要件54: Threads運用部署の競合リサーチ係 → **仕様ズレ → 実装済み**
- 要件59: 競合アカウントの調査 → **仕様ズレ → 実装済み**
- 要件24: Threads競合リサーチ → **一部実装 → 実装済み**

**変更ファイル:**
- `src/services/department-execution/index.ts`
- `src/services/orchestration/index.ts`

**実装内容:**
- `createThreadsExecutor` のサポートアクション配列に `"research_threads"` を追加。
- `research_threads` アクションハンドラを追加。`threads-competitor-researcher` エージェントを使用し、`runTrackedSubJob` で追跡される `orchestration.runThreadsResearch()` を実行。
- `OrchestrationService` インターフェースと `OrchestrationServiceImpl` に `runThreadsResearch()` メソッドを追加。
  - 複数トピックに対し `${topicName} Threads投稿 人気 バズ` でWeb検索
  - 結果を `threads_search:` prefix付きで `competitorSnapshots` に保存
  - `analyzeCompetitorSnapshots(llm, "threads")` で Threads専用の競合分析を実行
  - 分析結果をファイル保存

**設計判断:**
- `research_threads` は既に `ActionType` と `content-scheduler` の候補アクション生成に定義済みだったが、Threads executor に接続されていなかった。今回の修正で接続完了。
- `threads-competitor-researcher` エージェント（runtime-state に既存定義）が実行パスに接続された。

---

### 3. エグゼクティブ多軸ポリシー拡張

**対象要件:**
- 要件42: 今後のアカウント運用方針を統括する → **一部実装 → 実装済み**
- 要件83: 今後のアカウント運用方針を継続的に最適化する → **一部実装 → 実装済み**
- 要件9: 方針調整をシステム側が継続的に実行する → **一部実装 → 強化**

**変更ファイル:**
- `src/services/executive/index.ts`
- `src/services/content-scheduler/index.ts`

**実装内容:**

#### executive/index.ts
- **新規型定義:**
  - `BrandPolicy`: tone, topicsToAvoid, topicsToEmphasize, contentGuards
  - `GrowthPolicy`: channelFocus, contentFrequency, audienceStrategy
  - `MonetizationPolicy`: priceStrategy, conversionFocus, revenueTarget
  - `StrategyPolicies`: brand + growth + monetization の3軸統合
  - `ContentGuidance`: topicsToEmphasize, topicsToAvoid, recommendedTone, replyPolicy
  - `DEFAULT_POLICIES`: デフォルトポリシー値
- **StrategyStateSnapshot** に `policies: StrategyPolicies` フィールドを追加。
- **HeartbeatCyclePlan** に `contentGuidance` と `policyUpdates` フィールドを追加。
- **LlmExecutiveDecision** に `contentGuidance` と `policyUpdates` フィールドを追加。
- **buildExecutivePrompt** に多軸ポリシーの説明と、contentGuidance / policyUpdates の出力形式を追加。
- **beginHeartbeatCycle** のLLMレスポンスパースで、policyUpdates を既存ポリシーにマージし、contentGuidance を抽出してCyclePlanに含める。
- **loadCurrentPolicies()** ヘルパーメソッド: `strategyStates` テーブルから現在のポリシーを読み込み、なければデフォルトを返す。
- **buildFallbackPlan** にも `policies` フィールドを追加。

#### content-scheduler/index.ts
- **PersistedStrategyState** 型に `policies` フィールドを追加。
- **applyStrategyBias** に多軸ポリシーバイアスを追加:
  - Growth policy: `contentFrequency` が aggressive なら生成系アクション優先、conservative なら抑制
  - Growth policy: `channelFocus` に含まれないチャネルのアクションを大幅抑制（delta +2）
  - Monetization policy: `revenueTarget` が growth なら note生成を優先

**設計判断:**
- objective/funnelStage の2軸から brand/growth/monetization の3軸ポリシーに拡張。
- ポリシーは `strategyStates.stateJson` 内に保持し、新テーブルは作らない（既存構造を活用）。
- LLMが `policyUpdates` を返した場合のみ既存ポリシーを更新（差分マージ方式）。

---

### 4. 管理系統のコンテンツ・返信介入強化

**対象要件:**
- 要件40: 返信内容を統括する → **一部実装 → 強化**
- 要件41: 生成内容を統括する → **一部実装 → 強化**

**変更ファイル:**
- `src/services/engagement-analysis/index.ts`
- `src/jobs/hourly-heartbeat.ts`

**実装内容:**

#### engagement-analysis/index.ts
- `strategyStates` テーブルのインポートを追加。
- 返信分類プロンプトに**エグゼクティブポリシーの動的注入**を追加:
  - `strategyStates` から現在の `policies.brand.tone` と `topicsToAvoid` を取得
  - 現在の運用方針サマリーを取得
  - これらをLLMの返信分類プロンプトに注入
  - 判定基準に「ブランドポリシーに反する内容 → human_review」を追加

#### hourly-heartbeat.ts
- **contentGuidance通知の自動配信**: ハートビート実行時に、エグゼクティブが出力した `contentGuidance` を threads/note 部署に `content_guidance` タイプの `departmentNotifications` として保存。

**設計判断:**
- 返信分類は固定ルールから**ポリシー参照型**に進化。エグゼクティブの判断が返信品質に直接反映される。
- contentGuidanceは `departmentNotifications` 経由で配信し、各部署の既存通知読み取り機構を活用。

---

### 5. 外部リサーチの市場動向・ジャンル理解強化

**対象要件:**
- 要件44: 市場動向の把握 → **一部実装 → 強化**
- 要件45: ジャンル理解の更新 → **一部実装 → 強化**

**変更ファイル:**
- `src/services/research/index.ts`
- `src/domain/threads/index.ts`

**実装内容:**

#### research/index.ts
- **複数クエリ検索**: 従来の1クエリから3クエリに拡張:
  1. `${topicName} Threads 投稿 コツ` (従来のコンテンツ素材)
  2. `${topicName} 市場動向 トレンド ${year}` (市場動向)
  3. `${topicName} 需要 競争 ニッチ` (競争環境)
- **リサーチプロンプト拡張**: 3つのリサーチ観点を明示:
  1. コンテンツ素材（5件目安）
  2. 市場動向（2-3件目安）
  3. ジャンル理解（1-2件目安）
- 目標件数を5-8件から8-12件に拡張。
- **専用メモリ蓄積**:
  - `market` / `trend` 型のリサーチ結果を `persistent_policy` レイヤーの `market_trend:{topicId}` に保存
  - `genre_insight` 型のリサーチ結果を `persistent_policy` レイヤーの `genre_understanding:{topicId}` に保存
  - これにより市場動向とジャンル理解が永続化され、次回以降のリサーチや生成で参照可能に

#### domain/threads/index.ts
- `ResearchItem` の `evidenceType` に `"market"` と `"genre_insight"` を追加。

---

## 対処しなかった項目と理由

| 要件 | 内容 | 理由 |
|------|------|------|
| 要件20 | デスクトップアプリのスケジュール機能 | Electron/Tauri等のデスクトップフレームワーク導入が必要。アーキテクチャ変更が大規模すぎるため、仕様側での整理を推奨 |
| 要件34-35 | スキル・プラグインの自動導入/自動実装 | 自己改変コード生成はリスクが高く、設計議論が必要。仕様側での扱い整理を推奨 |
| 要件5,10-11,84-91 | 「テーマ・資料だけで自律」の仕様ズレ | 仕様本文内に矛盾あり（アカウント設定も必要と記載）。仕様側の整理が先決 |
| 要件76 | Threads→noteの実流入attribution | Threadsリファラの実測にはメタデータ付きURL短縮やUTMパラメータ等の基盤が必要。独立した設計タスクとして推奨 |

## 変更ファイル一覧

| ファイル | 変更種別 |
|---------|---------|
| `src/jobs/heartbeat-loop.ts` | 新規作成 |
| `src/jobs/hourly-heartbeat.ts` | 修正（contentGuidance配信追加） |
| `src/services/department-execution/index.ts` | 修正（research_threadsアクション追加） |
| `src/services/orchestration/index.ts` | 修正（runThreadsResearchメソッド追加） |
| `src/services/executive/index.ts` | 修正（多軸ポリシー、contentGuidance追加） |
| `src/services/content-scheduler/index.ts` | 修正（多軸ポリシーバイアス追加） |
| `src/services/engagement-analysis/index.ts` | 修正（ポリシー参照型返信分類） |
| `src/services/research/index.ts` | 修正（市場動向・ジャンル理解強化） |
| `src/domain/threads/index.ts` | 修正（evidenceType拡張） |
| `package.json` | 修正（ループスクリプト追加） |
| `ecosystem.config.cjs` | 修正（heartbeat-loopアプリ追加） |
