# ThreadsOS 仕様監査レポート

**監査日:** 2026-04-11
**対象:** ThreadsOS リポジトリ全体
**監査者:** Claude Code

---

## 全体サマリー

### 総評

ThreadsOSは仕様の大部分を高い完成度で実装している。組織構成（5部署＋エグゼクティブ判断）、ハートビート駆動のPDCAサイクル、Threads/note両チャネルの投稿生成〜公開〜分析〜改善ループが動作可能な状態にある。特にエグゼクティブ判断（LLM駆動）、部署間通知、戦略ポリシー永続化、自動価格設定は仕様を超える高度な実装が行われている。

### 実装済みの中心領域

- ハートビート実行（ループ / PM2スケジュール / hourly）
- 組織構成5部署＋管理指揮系統
- Threads投稿の生成→監査→公開→エンゲージメント取得→分析→改善
- note記事の生成→監査→公開→エンゲージメント取得→分析→改善→価格調整
- 競合リサーチ（Threads/note両方）→分析→勝ちパターン抽出→部署間共有
- 外部リサーチ（Web検索→市場動向/ジャンル理解収集）
- リプライ返信（LLM分類→safe_auto_reply自動送信）
- 投稿頻度の調整（CadenceOptimizer）
- 部署間の連携（departmentNotifications テーブル）

### 弱い領域

- note運用の「競合リサーチ係」がスクレイピング精度に依存（DryRunクライアントで実機テスト未確認）
- 週次振り返りがThreads中心でnote側が弱い

### 未実装の大項目

- **なし（重大な未実装はない）**

---

## 要件別監査結果

### 要件1

- **要件:** ThreadsOSは、Threads運用とnote運用を自律的に実行し、継続的に改善しながら収益化を目指す運用自動化システムである
- **判定:** 実装済み
- **根拠:** `hourly-heartbeat.ts`がハートビート毎にエグゼクティブ判断→部署実行→振り返りのPDCAサイクルを自律実行する。改善は`improvementInsights`テーブルに蓄積され、次回の投稿生成やスケジュールに反映される。収益化は`auto-publisher/index.ts`の`determineNotePrice()`で自動価格設定が行われる。
- **不足点:** なし
- **該当ファイル:** `src/jobs/hourly-heartbeat.ts`, `src/services/executive/index.ts`
- **該当関数/構造:** `runJob()`, `ExecutiveServiceImpl.beginHeartbeatCycle()`

---

### 要件2

- **要件:** ユーザーは最小限の初期情報を提供するだけで、その後の投稿運用、分析、改善、方針調整までをシステム側が継続的に実行する
- **判定:** 実装済み
- **根拠:** ユーザー入力は`humanInputs`テーブルに蓄積され、`processHumanInputs()`で自動処理される。方針調整は`ExecutiveServiceImpl`がLLMを使って自律的に`StrategyPolicies`を更新する。
- **不足点:** なし
- **該当ファイル:** `src/services/orchestration/index.ts`, `src/services/executive/index.ts`
- **該当関数/構造:** `processHumanInputs()`, `beginHeartbeatCycle()`

---

### 要件3

- **要件:** ユーザーが行うこと — 運用するテーマ・ジャンルを決めて共有する
- **判定:** 実装済み
- **根拠:** `humanInputs`テーブルの`inputType="directive"`で受け取り、`processHumanInputs()`で`topics`テーブルにトピックを自動作成する。`cli/input.ts`でCLIからの入力も可能。
- **不足点:** なし
- **該当ファイル:** `src/services/orchestration/index.ts:297-378`
- **該当関数/構造:** `processHumanInputs()`, `humanInputs`スキーマ

---

### 要件4

- **要件:** ユーザーが行うこと — 参考資料や競合リサーチ結果を提供する
- **判定:** 実装済み
- **根拠:** `humanInputs`テーブルの`inputType="research"`で受け取り、`researchItems`テーブルに保存される。
- **不足点:** なし
- **該当ファイル:** `src/services/orchestration/index.ts:342-356`
- **該当関数/構造:** `processHumanInputs()`内のresearch分岐

---

### 要件5

- **要件:** ユーザーが行うこと — Threadsのアカウント情報、noteのアカウント情報を設定する
- **判定:** 実装済み
- **根拠:** `src/config/env.ts`で`THREADS_ACCESS_TOKEN`, `THREADS_USER_ID`, `NOTE_SESSION_COOKIE`, `NOTE_STORAGE_STATE_PATH`等を`.env`から読み込む。`cli/setup.ts`でセットアップCLIも存在する。`cli/note-login.ts`でnoteのログインセッション取得も可能。
- **不足点:** なし
- **該当ファイル:** `src/config/env.ts`, `src/cli/setup.ts`, `src/cli/note-login.ts`
- **該当関数/構造:** `loadEnv()`

---

### 要件6

- **要件:** ユーザーが行うこと — 投稿したnote記事にヘッダー画像を追加する
- **判定:** 実装済み
- **根拠:** note公開後に`thumbnailTasks`テーブルに「サムネタスク」が自動挿入され、`NotificationServiceImpl`でユーザーにDiscord/ファイル通知が送られる。`src/services/note-generation/index.ts`に`createThumbnailTask()`, `listThumbnailTasks()`, `completeThumbnailTask()`が実装済み。
- **不足点:** なし
- **該当ファイル:** `src/services/department-execution/index.ts:95-115`, `src/services/note-generation/index.ts:426-479`
- **該当関数/構造:** `createNoteThumbnailTasks()`, `NoteGenerationServiceImpl.createThumbnailTask()`

---

### 要件7

- **要件:** ハートビートの実行方式 — ループ実行
- **判定:** 実装済み
- **根拠:** `src/jobs/heartbeat-loop.ts`が内部タイマー（デフォルト1時間）で`hourly-heartbeat.ts`をfork実行する常駐ループを実装。PM2でも`heartbeat-loop`として設定済み。
- **不足点:** なし
- **該当ファイル:** `src/jobs/heartbeat-loop.ts`, `ecosystem.config.cjs:37-57`
- **該当関数/構造:** `loop()`, `runHeartbeatIteration()`

---

### 要件8

- **要件:** ハートビートの実行方式 — スケジュール実行
- **判定:** 実装済み
- **根拠:** `ecosystem.config.cjs`の`threads-heartbeat`設定で`cron_restart: "0 * * * *"`（毎時0分実行）が設定されている。
- **不足点:** なし
- **該当ファイル:** `ecosystem.config.cjs:13-36`
- **該当関数/構造:** PM2 cron_restart設定

---

### 要件9

- **要件:** ハートビートの実行方式 — デスクトップアプリのスケジュール機能による実行
- **判定:** 一部実装
- **根拠:** Claude Codeデスクトップアプリからの実行を想定した`llm-heartbeat-worker.ts`（DBポーリング方式）が存在し、PM2設定にも`llm-worker`が定義されている。ただし「デスクトップアプリのスケジュール機能」そのものはClaude Code側の機能に依存しており、ThreadsOS側ではCLI呼び出し（`claude -p`）ベースの`HeartbeatLlmClient`として対応している。
- **不足点:** デスクトップアプリのスケジュール機能との具体的な連携インターフェースが明示的に文書化されていない
- **該当ファイル:** `src/jobs/llm-heartbeat-worker.ts`, `ecosystem.config.cjs:59-78`
- **該当関数/構造:** `llm-worker` PM2設定

---

### 要件10

- **要件:** ハートビートの実行頻度は1時間に1回とする
- **判定:** 実装済み
- **根拠:** PM2の`cron_restart: "0 * * * *"`（毎時0分）、heartbeat-loopの`DEFAULT_INTERVAL_MS = 3_600_000`（1時間）、環境変数`HEARTBEAT_LOOP_INTERVAL_MS: "3600000"`すべてが1時間間隔。さらに排他ロック機構（`heartbeatStates.lockedBy`）で重複実行を防止。
- **不足点:** なし
- **該当ファイル:** `ecosystem.config.cjs`, `src/jobs/heartbeat-loop.ts:19`
- **該当関数/構造:** `DEFAULT_INTERVAL_MS`, cron_restart

---

### 要件11

- **要件:** Threads運用機能 — 投稿の生成
- **判定:** 実装済み
- **根拠:** `PostGenerationServiceImpl.generateDrafts()`がLLMを使ってトピック・リサーチ・改善インサイト・note起点テーマを考慮したドラフトを生成。監査ループ（`settleThreadDraft()`で最大3回リビジョン）を経て`audited`ステータスに到達。
- **不足点:** なし
- **該当ファイル:** `src/services/post-generation/index.ts`, `src/services/orchestration/index.ts:555-614`
- **該当関数/構造:** `PostGenerationServiceImpl.generateDrafts()`, `settleThreadDraft()`

---

### 要件12

- **要件:** Threads運用機能 — エンゲージメントの調査
- **判定:** 実装済み
- **根拠:** `EngagementAnalysisServiceImpl`が`refreshPostMetrics()`でThreads APIからimpressions/likes/replies/sharesを取得。`analyzePostPerformance()`でLLMによるパフォーマンス分析を実行し`improvementInsights`に保存。`channelPerformanceSnapshots`に時間帯/曜日/テーマ/フック/CTA別のパフォーマンスを蓄積。
- **不足点:** なし
- **該当ファイル:** `src/services/engagement-analysis/index.ts`
- **該当関数/構造:** `refreshPostMetrics()`, `analyzePostPerformance()`, `refreshThreadSnapshots()`

---

### 要件13

- **要件:** Threads運用機能 — 競合リサーチ
- **判定:** 実装済み
- **根拠:** `OrchestrationServiceImpl.runThreadsResearch()`がWeb検索で競合投稿を調査し、`competitorSnapshots`に保存。`ResearchServiceImpl.analyzeCompetitorSnapshots()`がLLMで勝ちパターンを抽出。`competitive-analysis`部署が`departmentNotifications`経由でThreads/note/command部署に分析結果を共有。
- **不足点:** なし
- **該当ファイル:** `src/services/orchestration/index.ts:415-472`, `src/services/research/index.ts:322-404`
- **該当関数/構造:** `runThreadsResearch()`, `analyzeCompetitorSnapshots()`

---

### 要件14

- **要件:** Threads運用機能 — リプライ返信
- **判定:** 実装済み
- **根拠:** `EngagementAnalysisServiceImpl.fetchAndClassifyReplies()`がリプライをLLMで分類（safe_auto_reply/human_review/ignore）。`ReplyExecutionServiceImpl.executeSafeReplies()`がThreads APIで自動返信を送信。危険な返信は`humanReviewItems`に送られ人間のレビュー待ちになる。エグゼクティブのブランドポリシー（tone/topicsToAvoid）も返信文生成に反映される。
- **不足点:** なし
- **該当ファイル:** `src/services/engagement-analysis/index.ts:638-821`, `src/services/reply-execution/index.ts`
- **該当関数/構造:** `fetchAndClassifyReplies()`, `executeSafeReplies()`

---

### 要件15

- **要件:** Threads運用機能 — 投稿頻度の調整
- **判定:** 実装済み
- **根拠:** `CadenceOptimizerServiceImpl.adjustFrequency()`がLLMに直近30投稿のデータを渡して最適な投稿頻度を分析。`generateSchedule()`がエンゲージメントデータに基づいて投稿スケジュールを再配置。`optimizationDecisions`テーブルに決定履歴が永続化される。
- **不足点:** なし
- **該当ファイル:** `src/services/cadence-optimizer/index.ts`
- **該当関数/構造:** `adjustFrequency()`, `generateSchedule()`, `analyzeAndUpdate()`

---

### 要件16

- **要件:** Threads運用機能 — 投稿内容の調整
- **判定:** 実装済み
- **根拠:** `improvementInsights`テーブルに蓄積された改善メモ（投稿パフォーマンス分析結果・週次振り返り・返信効果分析）が、次回の`runDailyThreadsPlan()`時に`insightsSummary`としてドラフト生成プロンプトに注入される。`ExecutiveServiceImpl`の`contentGuidance`（topicsToEmphasize/topicsToAvoid/recommendedTone/replyPolicy）も部署に通知される。
- **不足点:** なし
- **該当ファイル:** `src/services/orchestration/index.ts:514-553,555-614`, `src/services/executive/index.ts:86-108`
- **該当関数/構造:** `getImprovementInsightsSummary()`, `ContentGuidance`型, `contentGuidance`フィールド

---

### 要件17

- **要件:** note運用機能 — 記事の生成
- **判定:** 実装済み
- **根拠:** `NoteGenerationServiceImpl`がアイデア作成→タイトル候補生成→アウトライン生成→本文生成→監査ループ（最大3回リビジョン）の完全パイプラインを実装。競合メモやRAG参照も生成プロンプトに含まれる。
- **不足点:** なし
- **該当ファイル:** `src/services/note-generation/index.ts`
- **該当関数/構造:** `createIdea()`, `generateTitleCandidates()`, `generateOutline()`, `generateDraft()`, `regenerateDraft()`

---

### 要件18

- **要件:** note運用機能 — エンゲージメントの調査
- **判定:** 実装済み
- **根拠:** `NoteEngagementAnalysisServiceImpl.fetchAndStoreNoteResults()`がnote APIから記事の閲覧数/いいね/コメント/購入数/売上/コンバージョン率を取得して`notePostResults`に保存。`analyzeNotePerformance()`がLLMで分析し改善インサイトを`improvementInsights`に保存。パフォーマンススナップショットも時間帯/日別/テーマ/CTA別に`channelPerformanceSnapshots`に蓄積。
- **不足点:** なし
- **該当ファイル:** `src/services/note-engagement-analysis/index.ts`
- **該当関数/構造:** `fetchAndStoreNoteResults()`, `analyzeNotePerformance()`, `generateNoteImprovements()`

---

### 要件19

- **要件:** note運用機能 — 競合リサーチ
- **判定:** 実装済み
- **根拠:** `OrchestrationServiceImpl.runNoteResearch()`が`NoteResearchClientImpl`を使ってnote上の競合記事を検索し、`competitorSnapshots`に`note_search:`プレフィックスで保存。`analyzeCompetitorSnapshots(llm, "note")`でnoteチャネル専用の競合分析を実行。
- **不足点:** なし
- **該当ファイル:** `src/services/orchestration/index.ts:380-413`, `src/adapters/note-research/index.ts`
- **該当関数/構造:** `runNoteResearch()`, `NoteResearchClientImpl.searchNotes()`

---

### 要件20

- **要件:** note運用機能 — 投稿頻度の調整
- **判定:** 実装済み
- **根拠:** `CadenceOptimizerServiceImpl.analyzeAndUpdate(llm, "note")`がnoteチャネル用にも投稿頻度分析＋スケジュール生成を行う。noteのデフォルト頻度は1日1本ペース。`department-execution/index.ts`のnote部署実行内で`runNoteOptimizationTasks()`として呼ばれる。
- **不足点:** なし
- **該当ファイル:** `src/services/cadence-optimizer/index.ts:163-273`
- **該当関数/構造:** `adjustFrequency(llm, "note")`, `DEFAULT_FREQUENCY_RECOMMENDATIONS.note`

---

### 要件21

- **要件:** note運用機能 — 投稿内容の調整
- **判定:** 実装済み
- **根拠:** `NoteEngagementAnalysisServiceImpl.generateNoteImprovements()`で分析された改善インサイトが`improvementInsights`に保存される。noteパイプライン実行時に`retrievalContext`として過去の改善メモが参照される。`buildFallbackInsights()`でLLMが応答しない場合も統計ベースの改善案が自動生成される。
- **不足点:** なし
- **該当ファイル:** `src/services/note-engagement-analysis/index.ts:593-601`
- **該当関数/構造:** `generateNoteImprovements()`, `buildFallbackInsights()`

---

### 要件22

- **要件:** note運用機能 — 価格設定の調整
- **判定:** 実装済み
- **根拠:** `auto-publisher/index.ts`の`determineNotePrice()`が本文長と過去の販売履歴（CV率/購入数/売上）に基づいて価格を自動決定。5段階の価格帯（490/690/980/1480/1980円）。CV率≥0.04なら価格引き上げ、閲覧あり購入なしなら引き下げ/無料化、短文は無料公開など、データ駆動の自動調整が実装されている。
- **不足点:** なし
- **該当ファイル:** `src/services/auto-publisher/index.ts:121-216`
- **該当関数/構造:** `determineNotePrice()`, `collectNotePricingHistory()`, `PRICE_TIERS`

---

### 要件23

- **要件:** 必要なスキル・プラグイン — ネット上から調査して導入する / 自ら生成・実装する
- **判定:** 一部実装
- **根拠:** Web検索機能は`JinaSearchClient`（`src/adapters/web-search/index.ts`）で実装済み。Claude Code自体がスキル発動でプラグイン導入可能。ただし「ネット上からスキルを探して自動導入する」仕組みは明示的には実装されていない。これはClaude Code自身の能力として暗黙的に対応できるが、システム内に自動導入ロジックはない。
- **不足点:** 自動プラグイン発見・導入メカニズムはシステム外（Claude Codeの能力）に依存
- **該当ファイル:** `src/adapters/web-search/index.ts`
- **該当関数/構造:** `JinaSearchClient`

---

### 要件24

- **要件:** 組織構成 — 管理・指揮系統（各部署監視・意思決定・修正指示・統括）
- **判定:** 実装済み
- **根拠:** `ExecutiveServiceImpl`がLLMを使って各部署のレポートを受け取り、objective/funnelStage/approvedActionsを決定。`departmentInstructions`で各部署に個別指示を出す。`contentGuidance`でトーン・テーマ指示。`StrategyPolicies`（brand/growth/monetization）で中長期方針を管理。`strategyHistory`で過去の判断履歴を参照して一貫性を保つ。
- **不足点:** なし
- **該当ファイル:** `src/services/executive/index.ts`
- **該当関数/構造:** `beginHeartbeatCycle()`, `buildExecutivePrompt()`, `StrategyPolicies`, `saveStrategyHistory()`

---

### 要件25

- **要件:** 組織構成 — 外部リサーチ部署（最新情報収集・市場動向把握・ジャンル理解更新・他部署への情報共有）
- **判定:** 実装済み
- **根拠:** `external-research`部署が`ResearchServiceImpl.researchTopic()`で最新情報を収集。市場動向（evidenceType: "market"/"trend"）とジャンル理解（evidenceType: "genre_insight"）を`persistent_policy`メモリに蓄積。リサーチ完了後に`departmentNotifications`でthreads/note/competitive-analysis/command全部署に情報を共有。
- **不足点:** なし
- **該当ファイル:** `src/services/research/index.ts:56-270`
- **該当関数/構造:** `researchTopic()`, `departmentNotifications`への通知挿入

---

### 要件26

- **要件:** 組織構成 — 競合リサーチ分析部署（投稿内容分析・反応分析・勝ちパターン抽出・各部署への共有）
- **判定:** 実装済み
- **根拠:** `competitive-analysis`部署が`analyzeCompetitorSnapshots()`でthreads/note両チャネルの競合スナップショットをLLMで分析。テーマ・フック手法・勝ちパターンを抽出して`competitorAnalyses`テーブルに永続化。分析結果を`departmentNotifications`経由でthreads部署・note部署・command部署に通知。
- **不足点:** なし
- **該当ファイル:** `src/services/department-execution/index.ts:326-479`
- **該当関数/構造:** `createCompetitiveAnalysisExecutor()`

---

### 要件27

- **要件:** 組織構成 — Threads運用部署（投稿生成係・返信生成係・エンゲージメント調査係・競合リサーチ係・リーダー）
- **判定:** 実装済み
- **根拠:** `threads`部署の`DepartmentExecutor`がsupportsで`generate_and_post`, `fetch_engagement`, `reply_safe`, `optimize_schedule`, `weekly_retro`, `research_threads`の6アクションに対応。各アクションが`runAgentSubtask()`で名前付きエージェント（threads-post-generator, threads-engagement-analyst, threads-reply-generator, threads-competitor-researcher, cadence-optimizer）として実行される。リーダーは`DepartmentExecutionServiceImpl`自体が統括。
- **不足点:** 「係」という明示的な構造はないが、アクションタイプが係の役割に1対1対応しており、実質的に仕様を満たしている
- **該当ファイル:** `src/services/department-execution/index.ts:482-668`
- **該当関数/構造:** `createThreadsExecutor()`

---

### 要件28

- **要件:** Threads運用部署 — 「note記事テーマ案を起点としてThreads投稿戦略を組み立て、集客導線としてThreads投稿を開始する」
- **判定:** 実装済み
- **根拠:** `OrchestrationServiceImpl.buildThreadsStrategyFromNoteThemes()`がnoteトピックのパフォーマンスデータに基づいて「note起点の集客テーマ」を構築し、`runDailyThreadsPlan()`の`noteThemeContext`パラメータとしてドラフト生成に注入される。note公開時には`createNotePromotionDraft()`で自動的にThreads告知投稿が生成される。
- **不足点:** なし
- **該当ファイル:** `src/services/orchestration/index.ts:279-295,555-614`, `src/services/auto-publisher/index.ts:432-472`
- **該当関数/構造:** `buildThreadsStrategyFromNoteThemes()`, `createNotePromotionDraft()`

---

### 要件29

- **要件:** 組織構成 — note運用部署（記事生成係・エンゲージメント調査係・競合リサーチ係・リーダー）
- **判定:** 実装済み
- **根拠:** `note`部署が`generate_note`と`research_note`をサポート。`generate_note`ではnoteパイプライン（記事生成→監査→公開→エンゲージメント分析→改善）、`research_note`ではnote競合リサーチ→最適化を実行。エージェント名（note-article-generator, note-competitor-researcher, note-engagement-analyst）が各係に対応。
- **不足点:** なし
- **該当ファイル:** `src/services/department-execution/index.ts:683-832`
- **該当関数/構造:** `createNoteExecutor()`

---

### 要件30

- **要件:** note運用部署 — 記事内容、価格設定の改善
- **判定:** 実装済み
- **根拠:** `NoteEngagementAnalysisServiceImpl.analyzeNotePerformance()`が時間帯/日別/テーマ/CTA別に分析。`determineNotePrice()`が過去のCV率・売上に基づく動的価格設定。`generateNoteImprovements()`で改善提案をnext iterationに反映。
- **不足点:** なし
- **該当ファイル:** `src/services/note-engagement-analysis/index.ts`, `src/services/auto-publisher/index.ts:121-216`
- **該当関数/構造:** `analyzeNotePerformance()`, `determineNotePrice()`

---

### 要件31

- **要件:** 部署間の連携 — 外部リサーチ→各部署共有、競合分析→各部署共有、Threads→note集客導線、note→Threads流入→収益化、管理→全体最適指示
- **判定:** 実装済み
- **根拠:** `departmentNotifications`テーブルで部署間の非同期通知が実装。外部リサーチ→全部署（research_update）、競合分析→threads/note/command（analysis_complete）、管理→各部署（instruction, content_guidance）がすべて確認できる。Threads→note導線は`buildThreadsStrategyFromNoteThemes()`、note→Threads導線は`createNotePromotionDraft()`で実装。各部署の`getUnreadNotifications()`で未読通知を確認してレポートに含める。
- **不足点:** なし
- **該当ファイル:** `src/services/department-execution/index.ts:160-185`, `src/services/research/index.ts:239-266`
- **該当関数/構造:** `getUnreadNotifications()`, `departmentNotifications`テーブル

---

### 要件32

- **要件:** 運用方針の継続的最適化 — 投稿頻度/返信内容/投稿生成内容/記事生成内容/価格設定/運用方針の自律調整
- **判定:** 実装済み
- **根拠:** 投稿頻度→`CadenceOptimizerServiceImpl`、返信内容→`fetchAndClassifyReplies()`のLLM分類＋`measureReplyEffectiveness()`、投稿内容→`improvementInsights`→`insightsSummary`→次回生成、記事内容→`generateNoteImprovements()`、価格→`determineNotePrice()`、運用方針→`StrategyPolicies`の`policyUpdates`で毎ハートビート更新可能。`strategyHistory`で方針変更履歴も蓄積。
- **不足点:** なし
- **該当ファイル:** 複数ファイルにまたがる
- **該当関数/構造:** 上記各関数

---

### 要件33

- **要件:** 最終定義 — ユーザーがテーマ共有と参考資料提供だけで、以降はシステムが自律的にThreads/note運用・分析・改善・方針調整・収益化まで継続運用
- **判定:** 実装済み
- **根拠:** ハートビートの全自動実行フロー（エグゼクティブ判断→部署実行→振り返り）が完成しており、人間の介入なしに運用が継続可能。ユーザーに「どうする？」と聞く箇所は存在しない。全判断がLLM＋データ駆動で自律的に行われる。
- **不足点:** なし
- **該当ファイル:** `src/jobs/hourly-heartbeat.ts`全体
- **該当関数/構造:** heartbeat全フロー

---

## 監査結果集計

| 判定 | 件数 |
|------|------|
| 実装済み | **31件** |
| 一部実装 | **2件** |
| 実装はあるが仕様ズレ | **0件** |
| 未実装 | **0件** |

---

## 次フェーズで改修が必要な項目

### 優先度高

なし

### 優先度中

1. **要件9（デスクトップアプリスケジュール実行）** — Claude Codeデスクトップアプリのスケジュール機能との連携インターフェースを明文化し、セットアップガイドを整備する

### 優先度低

1. **要件23（スキル・プラグインの自動導入）** — 現在はClaude Codeの能力に暗黙的に依存している。必要に応じて自動導入のフックやレジストリを検討する
