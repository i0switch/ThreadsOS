# ThreadsOS 仕様準拠 監査レポート

- 監査日: 2026-04-11
- 対象: ThreadsOS リポジトリ（master ブランチ, commit a437d4d）
- 監査方式: 仕様を65要件に分解し、実装と1対1で照合

---

## 全体サマリー

### 総評

ThreadsOSは仕様の大部分を実装済み。5部署構成・ハートビートによる自律実行・LLMエグゼクティブ判断・部署間通知・Threads/note両チャネル運用の基盤が揃っている。ただし「Threads運用部署内の係構成」が仕様上の4係+リーダー制ではなくサブタスク方式で実装されている点、「スキル/プラグインの自律的発見・導入」が未実装である点が主な乖離。

### 実装済みの中心領域

- ハートビート実行基盤（1時間1回、PM2/タスクスケジューラ対応）
- 管理・指揮系統（LLMエグゼクティブ、ボトムアップ＋トップダウン）
- 5部署構成（command, external-research, competitive-analysis, threads, note）
- Threads運用全機能（投稿生成・エンゲージメント・リプライ・頻度調整・内容調整）
- note運用全機能（記事生成・エンゲージメント・競合リサーチ・頻度調整・価格設定）
- 部署間通知（`departmentNotifications`テーブル）
- 安全機構（force-stop、budget、duplicate検出、auto-approval）

### 弱い領域

- Threads運用部署の「係」構成が仕様とズレている（独立した係ではなくサブタスク方式）
- 外部リサーチ部署の「他部署への情報共有」がDB経由の間接共有で、明示的push通知がない
- note記事テーマ起点のThreads投稿は`buildThreadsStrategyFromNoteThemes()`フォールバックで自動実行される（修正済み）

### 未実装の大項目

- スキル/プラグインのネット調査・自律導入機能

---

## 監査結果集計

| 判定 | 件数 |
|------|------|
| 実装済み | 45件 |
| 一部実装 | 10件 |
| 実装はあるが仕様ズレ | 8件 |
| 未実装 | 2件 |
| **合計** | **65件** |

---

## 要件別監査結果

### 要件1

- **要件:** ユーザーが運用テーマ・ジャンルを決めて共有する仕組み
- **判定:** 実装済み
- **根拠:** `humanInputs`テーブル（`src/db/schema.ts`）にユーザー入力を保存。`command`部署の`process_human_inputs`アクションで`orchestration.processHumanInputs()`が呼ばれ、`inputType === "directive"`の場合は`topics`テーブルにトピック作成、それ以外は`researchItems`テーブルに追加する（LLMは使用せず、DB操作で直接反映）。
- **不足点:** なし
- **該当ファイル:** `src/db/schema.ts`, `src/services/department-execution/index.ts`, `src/services/orchestration/index.ts`
- **該当関数/構造:** `humanInputs`テーブル, `createCommandExecutor()`, `processHumanInputs()`

---

### 要件2

- **要件:** ユーザーが参考資料や競合リサーチ結果を提供する仕組み
- **判定:** 実装済み
- **根拠:** `humanInputs`テーブルに自由テキストで投入可能。`competitorSnapshots`テーブルで外部から競合データを登録できる。`orchestration.processHumanInputs()`でLLMが解釈し、トピック生成・リサーチ反映に使われる。
- **不足点:** なし
- **該当ファイル:** `src/db/schema.ts`, `src/services/orchestration/index.ts`
- **該当関数/構造:** `humanInputs`, `competitorSnapshots`, `processHumanInputs()`

---

### 要件3

- **要件:** Threadsのアカウント情報、noteのアカウント情報を設定する仕組み
- **判定:** 実装済み
- **根拠:** Threads: `.env`の`THREADS_ACCESS_TOKEN`, `THREADS_USER_ID`で設定（`src/config/env.ts`でZodバリデーション）。note: `NOTE_SESSION_COOKIE`または`NOTE_STORAGE_STATE_PATH`で設定。`pnpm note:login`（`src/cli/note-login.ts`）でPlaywrightベースの対話的ログインも可能。
- **不足点:** なし
- **該当ファイル:** `src/config/env.ts`, `src/cli/note-login.ts`, `src/adapters/note-api/playwright-client.ts`
- **該当関数/構造:** `loadEnv()`, `note-login.ts`のCLI

---

### 要件4

- **要件:** 投稿したnote記事にヘッダー画像を追加する（ユーザー手動）
- **判定:** 実装済み
- **根拠:** `thumbnailTasks`テーブルで公開後のサムネイル設定タスクを管理。note公開後に`createNoteThumbnailTasks()`が自動的にタスクを作成し、`NotificationService`経由でユーザーに「サムネ設定して」と通知する。
- **不足点:** なし
- **該当ファイル:** `src/services/department-execution/index.ts`, `src/db/schema.ts`
- **該当関数/構造:** `createNoteThumbnailTasks()`, `thumbnailTasks`テーブル

---

### 要件5

- **要件:** ハートビートのループ実行
- **判定:** 実装済み
- **根拠:** PM2の`ecosystem.config.cjs`で`cron_restart: "0 * * * *"`を設定。毎時0分に`hourly-heartbeat.ts`を起動する。`autorestart: false`で1回実行→停止→cronで再起動のパターン。
- **不足点:** なし
- **該当ファイル:** `ecosystem.config.cjs`, `src/jobs/hourly-heartbeat.ts`
- **該当関数/構造:** PM2 cron_restart設定

---

### 要件6

- **要件:** ハートビートのスケジュール実行
- **判定:** 実装済み
- **根拠:** `scripts/setup-scheduler.ps1`でWindows タスクスケジューラに`RepetitionInterval (New-TimeSpan -Hours 1)`で毎時実行タスクを登録。PM2が使えない環境向けフォールバック。
- **不足点:** なし
- **該当ファイル:** `scripts/setup-scheduler.ps1`
- **該当関数/構造:** `Register-ScheduledTask` + `New-ScheduledTaskTrigger`

---

### 要件7

- **要件:** デスクトップアプリのスケジュール機能による実行
- **判定:** 一部実装
- **根拠:** Claude Codeデスクトップアプリの`/loop`や`/schedule`機能を想定した設計がCLAUDE.mdに記載されている。`src/jobs/hourly-heartbeat.ts`はCLI実行可能な単独スクリプトとして設計されており、外部スケジューラから呼び出し可能。ただし、デスクトップアプリ固有の統合コード（Claude Code Desktop APIとの直接接続等）は存在しない。
- **不足点:** Claude Codeデスクトップアプリとのネイティブ統合が明示的には実装されていない（ただし外部からの`pnpm job:heartbeat`実行で対応可能）
- **該当ファイル:** `ecosystem.config.cjs`, `scripts/setup-scheduler.ps1`, `package.json`
- **該当関数/構造:** `pnpm job:heartbeat`コマンド

---

### 要件8

- **要件:** ハートビートの実行頻度は1時間に1回
- **判定:** 実装済み
- **根拠:** PM2: `cron_restart: "0 * * * *"`（毎時0分）。タスクスケジューラ: `RepetitionInterval (New-TimeSpan -Hours 1)`。ダッシュボードにも`cadenceLabel: "1時間に1回のハートビート"`と表示。ロック機構で同時実行を防止（`heartbeatStates`テーブル、stale lock 50分閾値）。
- **不足点:** なし
- **該当ファイル:** `ecosystem.config.cjs`, `scripts/setup-scheduler.ps1`, `src/jobs/hourly-heartbeat.ts`
- **該当関数/構造:** PM2 cron設定, `heartbeatStates`ロック機構

---

### 要件9

- **要件:** Threads投稿の生成
- **判定:** 実装済み
- **根拠:** `PostGenerationServiceImpl.generateDrafts()`でLLMによる投稿ドラフト生成。`PostAuditServiceImpl.auditDraft()`で品質審査（pass/revise/reject）。審査通過後`AutoPublisherServiceImpl.publishApprovedThreadDrafts()`でThreads API経由公開。hookType, ctaType, noteTransitionなどメタデータも生成。
- **不足点:** なし
- **該当ファイル:** `src/services/post-generation/index.ts`, `src/services/post-audit/index.ts`, `src/services/auto-publisher/index.ts`
- **該当関数/構造:** `generateDrafts()`, `auditDraft()`, `publishApprovedThreadDrafts()`

---

### 要件10

- **要件:** Threadsエンゲージメントの調査
- **判定:** 実装済み
- **根拠:** `EngagementAnalysisServiceImpl`で実装。`fetchAndStoreResults()`でThreads API経由のメトリクス取得、`analyzePostPerformance()`でLLMによる改善インサイト生成、`measureReplyEffectiveness()`で返信効果測定、`generateWeeklyReport()`で週次レポート。impressions/likes/replies/shares/sentiment分析すべて対応。
- **不足点:** なし
- **該当ファイル:** `src/services/engagement-analysis/index.ts`
- **該当関数/構造:** `fetchAndStoreResults()`, `analyzePostPerformance()`, `generateWeeklyReport()`

---

### 要件11

- **要件:** Threads競合リサーチ
- **判定:** 実装済み
- **根拠:** `ResearchServiceImpl.analyzeCompetitorSnapshots(llm, "threads")`で競合スナップショットを分析。Jina Search APIによるウェブ検索統合。`competitorSnapshots`テーブルにデータ蓄積、`competitorAnalyses`テーブルに分析結果保存。勝ちパターン抽出あり。
- **不足点:** なし
- **該当ファイル:** `src/services/research/index.ts`, `src/adapters/web-search/index.ts`
- **該当関数/構造:** `analyzeCompetitorSnapshots()`, `saveCompetitorSnapshot()`

---

### 要件12

- **要件:** リプライ返信
- **判定:** 実装済み
- **根拠:** `ReplyExecutionServiceImpl.executeSafeReplies()`で安全な自動返信を実行。`EngagementAnalysisServiceImpl.fetchAndClassifyReplies()`で返信を分類（safe_auto_reply / human_review / ignore）。攻撃・医療・法的・投資相談はブロック。`MAX_REPLIES_PER_HOUR`でレート制限。
- **不足点:** なし
- **該当ファイル:** `src/services/reply-execution/index.ts`, `src/services/engagement-analysis/index.ts`
- **該当関数/構造:** `executeSafeReplies()`, `fetchAndClassifyReplies()`

---

### 要件13

- **要件:** Threads投稿頻度の調整
- **判定:** 実装済み
- **根拠:** `CadenceOptimizerServiceImpl`で実装。`analyzeOptimalTimes()`でJST曜日x時間帯のエンゲージメント率分析、`adjustFrequency()`でLLMによる頻度最適化、`generateSchedule()`で最適スロット生成。デフォルト: Threads 3投稿/日、最小間隔8時間。`optimizationDecisions`テーブルに判断記録。
- **不足点:** なし
- **該当ファイル:** `src/services/cadence-optimizer/index.ts`
- **該当関数/構造:** `analyzeOptimalTimes()`, `adjustFrequency()`, `generateSchedule()`

---

### 要件14

- **要件:** Threads投稿内容の調整
- **判定:** 実装済み
- **根拠:** `PostAuditServiceImpl`による品質審査（12次元の評価基準）で投稿内容を自動改善。`improvementInsights`テーブルに蓄積されたインサイトが次回の投稿生成プロンプトに反映。`ContentSchedulerServiceImpl.applyStrategyBias()`で戦略バイアスを適用。リビジョンループあり（最大3回）。
- **不足点:** なし
- **該当ファイル:** `src/services/post-audit/index.ts`, `src/services/content-scheduler/index.ts`
- **該当関数/構造:** `auditDraft()`, `applyStrategyBias()`, `improvementInsights`

---

### 要件15

- **要件:** note記事の生成
- **判定:** 実装済み
- **根拠:** `NoteGenerationServiceImpl`で実装。`createIdea()`→`generateTitleCandidates()`→`generateOutline()`→`generateDraft()`のフルパイプライン。LLM温度0.7-0.8でバリエーション生成。`NoteAuditServiceImpl`で12次元品質審査、最大3回リビジョンループ。`PlaywrightNoteApiClient`でブラウザ自動公開。
- **不足点:** なし
- **該当ファイル:** `src/services/note-generation/index.ts`, `src/services/note-audit/index.ts`, `src/adapters/note-api/playwright-client.ts`
- **該当関数/構造:** `createIdea()`, `generateDraft()`, `auditDraft()`, `publishArticle()`

---

### 要件16

- **要件:** noteエンゲージメントの調査
- **判定:** 実装済み
- **根拠:** `NoteEngagementAnalysisServiceImpl`で実装。`fetchAndStoreNoteResults()`でviews/likes/comments/purchases/revenue/conversion rateを取得。`generateNoteImprovements()`でLLMによる改善インサイト生成。`connectToThreadsInsights()`でThreadsとの相関分析。`channelPerformanceSnapshots`テーブルにスナップショット保存。
- **不足点:** なし
- **該当ファイル:** `src/services/note-engagement-analysis/index.ts`
- **該当関数/構造:** `fetchAndStoreNoteResults()`, `generateNoteImprovements()`, `connectToThreadsInsights()`

---

### 要件17

- **要件:** note競合リサーチ
- **判定:** 実装済み
- **根拠:** `NoteResearchClientImpl.searchNotes()`でJina Search API経由のnote.com限定検索（6時間キャッシュ）。`fetchPublicPage()`で記事本文抽出。`ResearchServiceImpl.analyzeCompetitorSnapshots(llm, "note")`で競合分析。`note-competitor-researcher`エージェントとして`createNoteExecutor()`内で実行。
- **不足点:** なし
- **該当ファイル:** `src/adapters/note-research/index.ts`, `src/services/research/index.ts`
- **該当関数/構造:** `searchNotes()`, `analyzeCompetitorSnapshots(llm, "note")`

---

### 要件18

- **要件:** note投稿頻度の調整
- **判定:** 実装済み
- **根拠:** `CadenceOptimizerServiceImpl.analyzeAndUpdate(llm, "note")`でnoteチャネル固有の頻度最適化。デフォルト: 1投稿/日、最小間隔24時間。直近30本のnote公開データからLLMが最適頻度を推奨。`contentSlots`テーブルでスケジュール管理。
- **不足点:** なし
- **該当ファイル:** `src/services/cadence-optimizer/index.ts`
- **該当関数/構造:** `analyzeAndUpdate()`, チャネル別デフォルト値 `{ postsPerDay: 1, minIntervalHours: 24 }`

---

### 要件19

- **要件:** note投稿内容の調整
- **判定:** 実装済み
- **根拠:** `NoteAuditServiceImpl.auditDraft()`で12次元品質審査（タイトル強度、導入品質、インサイト密度、構成一貫性、信頼性シグナル、エビデンス、CTA自然さ、収益化角度など）。pass/revise/reject/human_review判定。リビジョンループ最大3回。`improvementInsights`テーブルからの学習反映。
- **不足点:** なし
- **該当ファイル:** `src/services/note-audit/index.ts`
- **該当関数/構造:** `auditDraft()`

---

### 要件20

- **要件:** note価格設定の調整
- **判定:** 実装済み
- **根拠:** `AutoPublisherServiceImpl`内の`determineNotePrice()`で動的価格設定。文字数ベースの基本価格（<3000字=無料, 3000-5000=690円, 5000-8000=980円, 8000+=1480円）。過去のCV率・購入実績に基づく調整（CV>=4%なら+300円, CV<=1%なら-200円）。価格ティア正規化: [490, 690, 980, 1480, 1980]。先頭30%（最大2000字）を無料プレビュー。
- **不足点:** なし
- **該当ファイル:** `src/services/auto-publisher/index.ts`
- **該当関数/構造:** `determineNotePrice()`

---

### 要件21

- **要件:** 必要なスキル・プラグインをネット上から調査して導入する
- **判定:** 未実装
- **根拠:** リポジトリ内に`plugin`, `skill.*discover`, `self.*implement`, `dynamic.*capabilit`のいずれもヒットせず。`runtimeState`サービスのエージェントカタログはハードコードされた静的定義。動的なスキル発見・評価・インストール機構は存在しない。
- **不足点:** スキル/プラグインの検索・評価・自動導入パイプラインが全く存在しない
- **該当ファイル:** なし
- **該当関数/構造:** なし

---

### 要件22

- **要件:** 必要なスキル・プラグインを自ら生成・実装する
- **判定:** 未実装
- **根拠:** コード生成やセルフモディフィケーションの仕組みが存在しない。エージェントカタログ（`runtimeState.ensureCatalog()`）は静的で、実行時に新しいアクションタイプやサービスを動的に追加する機能はない。
- **不足点:** 自己拡張・コード生成・動的機能追加の仕組み全般
- **該当ファイル:** `src/services/runtime-state/index.ts`
- **該当関数/構造:** `ensureCatalog()` — 静的エージェント定義のみ

---

### 要件23

- **要件:** 管理・指揮系統 — 各部署からの情報を監視する
- **判定:** 実装済み
- **根拠:** `ExecutiveServiceImpl.beginHeartbeatCycle()`の冒頭で`departmentExecution.collectReports()`を呼び、全5部署の`DepartmentReport`（summary, metrics, recommendation, lastExecutedAt）を収集。これをLLMプロンプトに含めて判断する。各部署は`departmentRuns`, `departmentSummaries`テーブルに実行結果を蓄積し、エグゼクティブが参照可能。
- **不足点:** なし
- **該当ファイル:** `src/services/executive/index.ts`, `src/services/department-execution/index.ts`
- **該当関数/構造:** `collectReports()`, `buildExecutivePrompt()`

---

### 要件24

- **要件:** 管理・指揮系統 — 運用方針の意思決定を行う
- **判定:** 実装済み
- **根拠:** `ExecutiveServiceImpl.beginHeartbeatCycle()`でLLM（temperature=0.3）が戦略判断を下す。`objective`（directive_assimilation / funnel_expansion / engagement_compounding）と`funnelStage`（bootstrap / distribution / conversion / optimization）を決定。`strategyHistory`テーブルに判断理由と共に永続化。直近5サイクルの一貫性チェックも実装。
- **不足点:** なし
- **該当ファイル:** `src/services/executive/index.ts`
- **該当関数/構造:** `beginHeartbeatCycle()`, `LlmExecutiveDecision`, `saveStrategyHistory()`

---

### 要件25

- **要件:** 管理・指揮系統 — 必要に応じて修正指示を出す
- **判定:** 実装済み
- **根拠:** LLMエグゼクティブの出力に`departmentInstructions: Record<string, string>`が含まれ、部署ごとの具体的指示を発行。ハートビート実行時に`departmentNotifications`テーブルに`instruction`タイプとして挿入され、各部署の`execute()`に`instruction`パラメータとして渡される。
- **不足点:** なし
- **該当ファイル:** `src/services/executive/index.ts`, `src/jobs/hourly-heartbeat.ts`（L589-602）
- **該当関数/構造:** `departmentInstructions`, `departmentNotifications`へのinstruction挿入

---

### 要件26

- **要件:** 管理・指揮系統 — 投稿頻度、返信内容、生成内容、今後のアカウント運用方針を統括
- **判定:** 実装済み
- **根拠:** エグゼクティブLLMプロンプト（`buildExecutivePrompt()`）に全部署のメトリクス（pendingDrafts, dueSlots, pendingReplies, avgEngagement等）と推奨事項を含む。`approvedActionTypes`で実行するアクションを選択し、`departmentInstructions`で方針を伝達。`strategyStates`テーブルで戦略状態を永続化し、`ContentSchedulerServiceImpl.applyStrategyBias()`で次サイクルの優先度に反映。
- **不足点:** なし
- **該当ファイル:** `src/services/executive/index.ts`, `src/services/content-scheduler/index.ts`
- **該当関数/構造:** `buildExecutivePrompt()`, `applyStrategyBias()`, `strategyStates`テーブル

---

### 要件27

- **要件:** 外部リサーチ部署 — 最新情報の収集
- **判定:** 実装済み
- **根拠:** `createExternalResearchExecutor()`が`research_threads`アクションを担当。`orchestration.runDailyTopicResearch()`でJina Search APIによるウェブ検索とLLMによるリサーチ結果解析を実行。`researchItems`テーブルにevidence type（data, anecdote, expert, trend）付きで保存。
- **不足点:** なし
- **該当ファイル:** `src/services/department-execution/index.ts`, `src/services/research/index.ts`, `src/adapters/web-search/index.ts`
- **該当関数/構造:** `createExternalResearchExecutor()`, `researchTopic()`

---

### 要件28

- **要件:** 外部リサーチ部署 — 市場動向の把握
- **判定:** 実装済み
- **根拠:** `researchTopic()`でウェブ検索結果をLLMが分析し、テーマ/エビデンス/トレンドを抽出。evidence type `trend`として分類・保存。`topics`テーブルの`priorityScore`更新で市場動向を反映。
- **不足点:** なし
- **該当ファイル:** `src/services/research/index.ts`
- **該当関数/構造:** `researchTopic()`, evidence type分類

---

### 要件29

- **要件:** 外部リサーチ部署 — ジャンル理解の更新
- **判定:** 実装済み
- **根拠:** `researchTopic()`の結果が`topics`テーブルと`researchItems`テーブルに蓄積され、次回の投稿生成・記事生成プロンプトに含まれる。`topicId`を介してドラフト生成時のコンテキストとして使用。`improvementInsights`テーブルのinsight_focus情報もジャンル理解に活用。
- **不足点:** なし
- **該当ファイル:** `src/services/research/index.ts`, `src/services/orchestration/index.ts`
- **該当関数/構造:** `researchTopic()`, `collectPriorityTopics()`

---

### 要件30

- **要件:** 外部リサーチ部署 — 他部署への情報共有
- **判定:** 一部実装
- **根拠:** リサーチ結果は`researchItems`テーブルに保存され、他部署（threads, note）がドラフト生成時にDB経由で参照可能。ただし`competitive-analysis`部署のように`departmentNotifications`テーブルへの明示的push通知は`external-research`部署から実装されていない。共有はDB読み取りによる暗黙的な間接共有。
- **不足点:** `external-research` → 他部署への明示的`departmentNotifications` push通知がない
- **該当ファイル:** `src/services/department-execution/index.ts`（L255-318）
- **該当関数/構造:** `createExternalResearchExecutor()` — 通知送信コードなし

---

### 要件31

- **要件:** 競合リサーチ分析部署 — 競合の投稿内容分析
- **判定:** 実装済み
- **根拠:** `createCompetitiveAnalysisExecutor()`が`analyze_competitors`アクションを実行。`research.analyzeCompetitorSnapshots(llm, "threads")`と`research.analyzeCompetitorSnapshots(llm, "note")`で両チャネルの競合投稿を分析。`competitorSnapshots`テーブルから蓄積データを取得してLLMで分析。
- **不足点:** なし
- **該当ファイル:** `src/services/department-execution/index.ts`（L321-441）, `src/services/research/index.ts`
- **該当関数/構造:** `createCompetitiveAnalysisExecutor()`, `analyzeCompetitorSnapshots()`

---

### 要件32

- **要件:** 競合リサーチ分析部署 — 競合の反応分析
- **判定:** 実装済み
- **根拠:** `analyzeCompetitorSnapshots()`でLLMがスナップショットからengagement patterns（反応パターン）を抽出。`competitorAnalyses`テーブルに分析結果を保存。エンゲージメントパターン（いいね率、コメント傾向等）を`winningPatterns`として抽出。
- **不足点:** なし
- **該当ファイル:** `src/services/research/index.ts`
- **該当関数/構造:** `analyzeCompetitorSnapshots()`, `competitorAnalyses`テーブル

---

### 要件33

- **要件:** 競合リサーチ分析部署 — 勝ちパターンの抽出
- **判定:** 実装済み
- **根拠:** `analyzeCompetitorSnapshots()`の返り値に`winningPatterns: string[]`が含まれる。LLMが競合データからテーマ・フック・エンゲージメントの勝ちパターンを抽出し、配列として返す。
- **不足点:** なし
- **該当ファイル:** `src/services/research/index.ts`, `src/services/department-execution/index.ts`（L403-434）
- **該当関数/構造:** `analyzeCompetitorSnapshots()` → `winningPatterns`

---

### 要件34

- **要件:** 競合リサーチ分析部署 — Threads運用部署、note運用部署、管理指揮系統への分析結果共有
- **判定:** 一部実装
- **根拠:** Threads/noteへの共有は実装済み: `departmentNotifications`テーブルに`fromDepartment: "competitive-analysis"`, `toDepartment: "threads"/"note"`, `notificationType: "analysis_complete"`で勝ちパターンを送信（L403-434）。ただし管理・指揮系統（command）への直接通知は実装されていない。管理はボトムアップの`DepartmentReport`で間接的に把握する。
- **不足点:** 管理・指揮系統への直接push通知がない（間接的にはDepartmentReport経由で把握）
- **該当ファイル:** `src/services/department-execution/index.ts`（L401-434）
- **該当関数/構造:** `departmentNotifications`へのinsert — `toDepartment`がthreadsとnoteのみ

---

### 要件35

- **要件:** Threads運用部署 構成 — 投稿生成係
- **判定:** 実装はあるが仕様ズレ
- **根拠:** `createThreadsExecutor()`内で`threads-post-generator`エージェントIDを使ったサブタスク実行がある（L585-594）。ただし仕様が想定する「独立した係（チーム）」としての構造ではなく、Threads部署の`execute()`メソッド内の条件分岐で呼ばれるサブタスク。独立した状態管理・メトリクス・レポートは持たない。
- **不足点:** 投稿生成係が独立したエンティティとしてレポートや状態を持っていない
- **該当ファイル:** `src/services/department-execution/index.ts`（L585-594）
- **該当関数/構造:** `runAgentSubtask("threads-post-generator", ...)`

---

### 要件36

- **要件:** Threads運用部署 構成 — 返信生成係
- **判定:** 実装はあるが仕様ズレ
- **根拠:** `threads-reply-generator`エージェントIDでサブタスク実行（L545-553）。`ReplyExecutionServiceImpl.executeSafeReplies()`を呼ぶ。ただし独立した「係」ではなくThreads部署内のサブタスク。
- **不足点:** 返信生成係が独立したエンティティとしてレポートや状態を持っていない
- **該当ファイル:** `src/services/department-execution/index.ts`（L544-553）
- **該当関数/構造:** `runAgentSubtask("threads-reply-generator", ...)`

---

### 要件37

- **要件:** Threads運用部署 構成 — エンゲージメント調査係
- **判定:** 実装はあるが仕様ズレ
- **根拠:** `threads-engagement-analyst`エージェントIDでサブタスク実行（L531-541）。`orchestration.runPostPublishFollowup()`を呼ぶ。独立した「係」ではなくサブタスク。
- **不足点:** エンゲージメント調査係が独立したエンティティとして管理されていない
- **該当ファイル:** `src/services/department-execution/index.ts`（L531-541）
- **該当関数/構造:** `runAgentSubtask("threads-engagement-analyst", ...)`

---

### 要件38

- **要件:** Threads運用部署 構成 — 競合リサーチ係
- **判定:** 実装はあるが仕様ズレ
- **根拠:** Threads運用部署自体は`generate_and_post`, `fetch_engagement`, `reply_safe`, `optimize_schedule`, `weekly_retro`をサポートするが、「Threads運用部署内の競合リサーチ係」は独立していない。競合リサーチは`competitive-analysis`部署が担当しており、Threads運用部署の内部係としては存在しない。
- **不足点:** 仕様ではThreads運用部署内に競合リサーチ係があるが、実装では別部署（competitive-analysis）に分離されている
- **該当ファイル:** `src/services/department-execution/index.ts`（L444-613）
- **該当関数/構造:** `createThreadsExecutor()` — 競合リサーチアクションを含まない

---

### 要件39

- **要件:** Threads運用部署 構成 — 各係を取りまとめるリーダー
- **判定:** 一部実装
- **根拠:** `createThreadsExecutor()`の`report()`メソッドがリーダーの機能を担っている。pendingDrafts, dueSlots, pendingReplies, avgEngagementのメトリクスを集約し、推奨アクションを判断（公開実行推奨/リプライ処理推奨/ドラフト生成が必要/在庫十分）。ただし「リーダー」として独立したエージェント・意思決定ロジックではなく、`report()`関数内の条件分岐。
- **不足点:** リーダーが明示的なエージェントやサービスとして分離されていない
- **該当ファイル:** `src/services/department-execution/index.ts`（L458-521）
- **該当関数/構造:** `createThreadsExecutor().report()`

---

### 要件40

- **要件:** Threads投稿の生成（Threads運用部署の役割として）
- **判定:** 実装済み
- **根拠:** 要件9と同一。`generate_and_post`アクションで`threads-post-generator`サブタスクが実行される。`orchestration.runDailyThreadsPlan()`→`postGeneration.generateDrafts()`→`postAudit.auditDraft()`→`autoPublisher.publishApprovedThreadDrafts()`のフルパイプライン。
- **不足点:** なし
- **該当ファイル:** `src/services/department-execution/index.ts`（L584-611）
- **該当関数/構造:** `createThreadsExecutor().execute()` の `generate_and_post` ブランチ

---

### 要件41

- **要件:** リプライ返信文の生成（Threads運用部署の役割として）
- **判定:** 実装済み
- **根拠:** 要件12と同一。`reply_safe`アクションで`threads-reply-generator`サブタスクが実行される。
- **不足点:** なし
- **該当ファイル:** `src/services/department-execution/index.ts`（L544-553）
- **該当関数/構造:** `createThreadsExecutor().execute()` の `reply_safe` ブランチ

---

### 要件42

- **要件:** エンゲージメント状況の分析（Threads運用部署の役割として）
- **判定:** 実装済み
- **根拠:** 要件10と同一。`fetch_engagement`アクションで`threads-engagement-analyst`サブタスクが実行される。
- **不足点:** なし
- **該当ファイル:** `src/services/department-execution/index.ts`（L530-541）
- **該当関数/構造:** `createThreadsExecutor().execute()` の `fetch_engagement` ブランチ

---

### 要件43

- **要件:** 競合アカウントの調査（Threads運用部署の役割として）
- **判定:** 実装はあるが仕様ズレ
- **根拠:** 競合調査はThreads運用部署ではなく`competitive-analysis`部署が担当。Threads運用部署は`analyze_competitors`アクションをサポートしない（`supportsAction`に含まれない）。仕様はThreads運用部署内に競合リサーチ係を置くと定義しているが、実装は独立部署に分離。
- **不足点:** Threads運用部署の役割として競合調査が統合されていない
- **該当ファイル:** `src/services/department-execution/index.ts`（L444-457）
- **該当関数/構造:** `createThreadsExecutor().supports()` — `analyze_competitors`を含まない

---

### 要件44

- **要件:** Threads投稿頻度や投稿内容の改善（Threads運用部署の役割として）
- **判定:** 実装済み
- **根拠:** `optimize_schedule`アクションでThreads運用部署が`cadence-optimizer`サブタスクを実行。`weekly_retro`アクションで週次ふりかえりも実行。投稿内容は`postAudit`のリビジョンループと`improvementInsights`フィードバックで改善。
- **不足点:** なし
- **該当ファイル:** `src/services/department-execution/index.ts`（L556-581）
- **該当関数/構造:** `optimize_schedule`と`weekly_retro`のブランチ

---

### 要件45

- **要件:** note記事テーマ案を起点としたThreads投稿戦略
- **判定:** 実装済み
- **根拠:** `PostGenerationServiceImpl.generateDrafts()`に`noteThemeContext`パラメータが存在し、`orchestration.runDailyThreadsPlan()`からオプションで渡せる。渡された場合、プロンプトに`## note起点の集客コンテキスト`セクションが追加される。`createThreadsExecutor().execute()`内の`generate_and_post`ブランチでは`orchestration.runDailyThreadsPlan()`を`noteThemeContext`なしで呼ぶが、`runDailyThreadsPlan()`内部（L507-509）で`noteThemeContext ?? (await this.buildThreadsStrategyFromNoteThemes(3))`のフォールバックにより、noteテーマが自動取得される。
- **不足点:** なし（部署executor側から明示的に渡していないが、orchestration層のフォールバックで機能する）
- **該当ファイル:** `src/services/post-generation/index.ts`（L19, L48-49）, `src/services/orchestration/index.ts`（L507-509）, `src/services/department-execution/index.ts`（L588-593）
- **該当関数/構造:** `generateDrafts(noteThemeContext?)`, `buildThreadsStrategyFromNoteThemes()` — フォールバックで自動渡し

---

### 要件46

- **要件:** note運用部署 構成 — 記事生成係
- **判定:** 実装はあるが仕様ズレ
- **根拠:** `createNoteExecutor()`内で`note-article-generator`エージェントIDでサブタスク実行（L725-737）。ただし要件35-38と同様、独立した「係」ではなくサブタスク方式。
- **不足点:** 記事生成係が独立したエンティティとして管理されていない
- **該当ファイル:** `src/services/department-execution/index.ts`（L725-737）
- **該当関数/構造:** `runAgentSubtask("note-article-generator", ...)`

---

### 要件47

- **要件:** note運用部署 構成 — エンゲージメント調査係
- **判定:** 実装はあるが仕様ズレ
- **根拠:** `note-engagement-analyst`エージェントIDでサブタスク実行（L755-764）。`noteEngagement.fetchAndStoreNoteResults()`と`generateNoteImprovements()`を呼ぶ。独立した「係」ではなくサブタスク。
- **不足点:** エンゲージメント調査係が独立したエンティティとして管理されていない
- **該当ファイル:** `src/services/department-execution/index.ts`（L755-764）
- **該当関数/構造:** `runAgentSubtask("note-engagement-analyst", ...)`

---

### 要件48

- **要件:** note運用部署 構成 — 競合リサーチ係
- **判定:** 実装はあるが仕様ズレ
- **根拠:** `note-competitor-researcher`エージェントIDでサブタスク実行（L696-708）。`research_note`アクションで呼ばれる。ただし要件38と同様、実態は`competitive-analysis`部署と共通のリサーチサービスを使うサブタスク。
- **不足点:** 競合リサーチ係が独立したエンティティとして管理されていない
- **該当ファイル:** `src/services/department-execution/index.ts`（L696-708）
- **該当関数/構造:** `runAgentSubtask("note-competitor-researcher", ...)`

---

### 要件49

- **要件:** note運用部署 構成 — 各係を取りまとめるリーダー
- **判定:** 一部実装
- **根拠:** `createNoteExecutor()`の`report()`メソッドがリーダー機能を担当。pendingNoteDrafts, dueNoteSlots, publishedNotes, noteResearchSnapshotsを監視し、推奨アクション（記事生成最優先/競合リサーチ/公開実行推奨/動く必要なし）を判断。ただし明示的な「リーダー」エージェントではない。
- **不足点:** リーダーが明示的なエージェントとして分離されていない
- **該当ファイル:** `src/services/department-execution/index.ts`（L633-685）
- **該当関数/構造:** `createNoteExecutor().report()`

---

### 要件50

- **要件:** note記事の生成（note運用部署の役割として）
- **判定:** 実装済み
- **根拠:** 要件15と同一。`generate_note`アクションで`nightly-note-pipeline`が実行される。
- **不足点:** なし
- **該当ファイル:** `src/services/department-execution/index.ts`（L717-774）
- **該当関数/構造:** `createNoteExecutor().execute()` の `generate_note` ブランチ

---

### 要件51

- **要件:** note内での反応分析（note運用部署の役割として）
- **判定:** 実装済み
- **根拠:** 要件16と同一。note公開後に`note-engagement-analyst`サブタスクが実行される。
- **不足点:** なし
- **該当ファイル:** `src/services/department-execution/index.ts`（L755-764）
- **該当関数/構造:** `note-engagement-analyst`サブタスク

---

### 要件52

- **要件:** 競合記事の調査（note運用部署の役割として）
- **判定:** 実装済み
- **根拠:** 要件17と同一。`research_note`アクションで`note-competitor-researcher`サブタスクが実行される。
- **不足点:** なし
- **該当ファイル:** `src/services/department-execution/index.ts`（L694-714）
- **該当関数/構造:** `createNoteExecutor().execute()` の `research_note` ブランチ

---

### 要件53

- **要件:** 投稿頻度、記事内容、価格設定の改善（note運用部署の役割として）
- **判定:** 実装済み
- **根拠:** `runNoteOptimizationTasks()`で`optimizer.analyzeAndUpdate(llm, "note")`を実行し頻度最適化。`noteAudit.auditDraft()`で記事内容改善。`determineNotePrice()`で価格設定調整。すべてnote部署のexecuteフロー内で呼ばれる。
- **不足点:** なし
- **該当ファイル:** `src/services/department-execution/index.ts`（L616-626, L768-769）
- **該当関数/構造:** `runNoteOptimizationTasks()`, `determineNotePrice()`

---

### 要件54

- **要件:** 外部リサーチ部署 → 各部署への最新情報共有
- **判定:** 一部実装
- **根拠:** 要件30と同一。DB経由の間接共有は機能するが、`departmentNotifications`への明示的push通知がexternal-research部署からは送られない。
- **不足点:** 明示的push通知メカニズムの欠如
- **該当ファイル:** `src/services/department-execution/index.ts`（L255-318）
- **該当関数/構造:** `createExternalResearchExecutor()` — 通知送信なし

---

### 要件55

- **要件:** 競合リサーチ分析部署 → 各部署への分析結果共有
- **判定:** 一部実装
- **根拠:** 要件34と同一。threads/noteへの通知は実装済みだが、管理・指揮系統（command）への直接通知はない。
- **不足点:** 管理・指揮系統への直接通知
- **該当ファイル:** `src/services/department-execution/index.ts`（L401-434）
- **該当関数/構造:** `departmentNotifications`へのinsert — threads/noteのみ

---

### 要件56

- **要件:** Threads運用部署 → noteで収益化につながる記事テーマ案を起点に集客投稿
- **判定:** 実装済み
- **根拠:** 要件45と同一。`runDailyThreadsPlan()`内部の`buildThreadsStrategyFromNoteThemes()`フォールバック（L507-509）により、noteテーマが自動取得されてThreads投稿生成に反映される。
- **不足点:** なし
- **該当ファイル:** `src/services/post-generation/index.ts`（L19）, `src/services/orchestration/index.ts`（L507-509）, `src/services/department-execution/index.ts`（L584-594）
- **該当関数/構造:** `buildThreadsStrategyFromNoteThemes()` — フォールバックで自動連携

---

### 要件57

- **要件:** note運用部署 → Threadsから流入したユーザーを収益化につなげる
- **判定:** 一部実装
- **根拠:** `NoteEngagementAnalysisServiceImpl.connectToThreadsInsights()`でThreadsとnoteのパフォーマンス相関分析が実装されている。投稿にnoteTransition仮説を含める仕組みもある。ただし、Threads流入を直接追跡するアトリビューション機能（UTMパラメータ、リファラー分析等）は実装されていない。
- **不足点:** Threads → noteの流入アトリビューション追跡機能
- **該当ファイル:** `src/services/note-engagement-analysis/index.ts`
- **該当関数/構造:** `connectToThreadsInsights()`

---

### 要件58

- **要件:** 管理・指揮系統 → 全体最適の視点で改善指示を出す
- **判定:** 実装済み
- **根拠:** 要件24-26と同一。LLMエグゼクティブが全部署のレポートを統合し、objective/funnelStage/approvedActionTypes/departmentInstructionsを決定する。プロンプトに「部署の推奨を尊重しつつ、全体最適を考える」と明記。
- **不足点:** なし
- **該当ファイル:** `src/services/executive/index.ts`
- **該当関数/構造:** `beginHeartbeatCycle()`, `buildExecutivePrompt()`

---

### 要件59

- **要件:** noteおよびThreadsの投稿頻度の継続的最適化
- **判定:** 実装済み
- **根拠:** `CadenceOptimizerServiceImpl`がthreads/note両チャネルをサポート。`analyzeAndUpdate(llm, "threads"/"note")`でチャネル別に最適化。`optimizationDecisions`テーブルに判断記録。ハートビートごとに`optimize_schedule`アクションとして実行可能。
- **不足点:** なし
- **該当ファイル:** `src/services/cadence-optimizer/index.ts`
- **該当関数/構造:** `analyzeAndUpdate()`

---

### 要件60

- **要件:** 返信内容の継続的最適化
- **判定:** 一部実装
- **根拠:** `EngagementAnalysisServiceImpl.measureReplyEffectiveness()`で返信効果を測定し、`improvementInsights`に反映。ただし返信テンプレートや返信トーンの自動調整ループは明示的に実装されていない。返信はLLMが毎回新規生成するため暗黙的に改善されるが、明示的な「返信内容最適化」サイクルはない。
- **不足点:** 返信テンプレート/トーン/戦略の明示的な最適化ループ
- **該当ファイル:** `src/services/engagement-analysis/index.ts`
- **該当関数/構造:** `measureReplyEffectiveness()`

---

### 要件61

- **要件:** 投稿生成内容の継続的最適化
- **判定:** 実装済み
- **根拠:** `improvementInsights`テーブルに蓄積されたインサイトが次回の投稿生成プロンプトに反映。`postAudit`のリビジョンループで品質向上。`contentScheduler.applyStrategyBias()`で戦略に基づく優先度調整。`weeklyRetro`で週次ふりかえり。
- **不足点:** なし
- **該当ファイル:** `src/services/post-generation/index.ts`, `src/services/post-audit/index.ts`
- **該当関数/構造:** `generateDrafts()`, `auditDraft()`

---

### 要件62

- **要件:** 記事生成内容の継続的最適化
- **判定:** 実装済み
- **根拠:** `NoteAuditServiceImpl.auditDraft()`で12次元品質審査。`NoteEngagementAnalysisServiceImpl.generateNoteImprovements()`で公開後の改善インサイト生成。`improvementInsights`テーブル経由で次回の記事生成に反映。
- **不足点:** なし
- **該当ファイル:** `src/services/note-audit/index.ts`, `src/services/note-engagement-analysis/index.ts`
- **該当関数/構造:** `auditDraft()`, `generateNoteImprovements()`

---

### 要件63

- **要件:** 価格設定の継続的最適化
- **判定:** 実装済み
- **根拠:** 要件20と同一。`determineNotePrice()`で過去のCV率・購入実績に基づく動的価格調整。
- **不足点:** なし
- **該当ファイル:** `src/services/auto-publisher/index.ts`
- **該当関数/構造:** `determineNotePrice()`

---

### 要件64

- **要件:** 今後のアカウント運用方針の継続的最適化
- **判定:** 実装済み
- **根拠:** `ExecutiveServiceImpl.beginHeartbeatCycle()`でサイクルごとにobjective/funnelStageを見直し。`strategyHistory`テーブルに過去の判断理由を蓄積し、一貫性チェック。「頻繁な方針転換は避け、根拠がない限り前回の方針を継続」のプロンプト指示。`strategyStates`テーブルで戦略状態を永続化。
- **不足点:** なし
- **該当ファイル:** `src/services/executive/index.ts`
- **該当関数/構造:** `beginHeartbeatCycle()`, `saveStrategyHistory()`, `strategyStates`テーブル

---

### 要件65

- **要件:** ユーザーがテーマ共有と資料提供だけで、システムが全自律運用を継続する
- **判定:** 一部実装
- **根拠:** 基本的な自律運用ループは完成（ハートビート → 差分収集 → エグゼクティブ判断 → 部署実行 → 結果統合 → サマリー更新）。ただし、要件21-22（スキル/プラグイン自律導入）が未実装のため、新しい環境変化や機能要求に対してシステムが自ら能力を拡張することはできない。また要件45/56（noteテーマ起点のThreads投稿自動連携）が不完全で、完全な「ファネル自律運用」にはギャップがある。
- **不足点:** スキル自律導入能力の欠如、noteテーマ → Threads投稿の自動連携
- **該当ファイル:** リポジトリ全体
- **該当関数/構造:** 全体アーキテクチャ

---

## 次フェーズで改修が必要な項目

### 優先度高

| # | 要件 | 問題 |
|---|------|------|
| 30, 54 | 外部リサーチ → 各部署への明示的共有 | `external-research`部署から`departmentNotifications`へのpush通知実装が必要 |
| 35-39 | Threads運用部署の係構成 | サブタスク方式 → 独立した係（チーム）として状態・メトリクス・レポートを持つ構成への変更を検討 |
| 46-49 | note運用部署の係構成 | 同上 |

### 優先度中

| # | 要件 | 問題 |
|---|------|------|
| 34, 55 | 競合分析 → 管理指揮系統への直接通知 | `competitive-analysis`からcommand部署への`departmentNotifications`追加 |
| 57 | Threads → note流入追跡 | アトリビューション機能（UTMパラメータ、リファラー分析）の追加 |
| 60 | 返信内容最適化 | 返信トーン・戦略の明示的最適化ループの追加 |

### 優先度低

| # | 要件 | 問題 |
|---|------|------|
| 21, 22 | スキル/プラグイン自律導入 | セルフモディフィケーション機能。アーキテクチャ的に大きな変更が必要で、安全性の担保も課題。現実的にはClaude Code自体のスキルシステムで代替可能 |
| 7 | デスクトップアプリ統合 | 現行のCLI実行で実用上は問題ない。ネイティブ統合は需要次第 |
