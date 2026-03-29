# ThreadsOS 実装用プロンプト集

`docs/final-plan-v2.md` を参照しながら、Phase順に実行する。
各プロンプトはClaude Code / Codexに投げる用。

---

## Phase 1: heartbeat基盤 + Threads自動投稿

### Prompt 1-1: DBスキーマ追加

```
docs/final-plan-v2.md の「DBスキーマ追加（9テーブル統合版）」セクションを参照して、
src/db/schema.ts に以下の9テーブルを追加してください。

1. operator_profiles
2. human_inputs
3. content_slots (unique制約付き)
4. optimization_decisions
5. channel_performance_snapshots
6. note_post_results
7. thumbnail_tasks
8. heartbeat_states
9. outbound_notifications

また、既存の reply_decisions テーブルに sent_at TEXT カラムを追加するマイグレーションも作成してください。

制約:
- 既存テーブルの定義は変更しない
- drizzle-orm の sqliteTable を使う
- 全テーブルにexportをつける
- content_slots の unique制約を忘れないこと
```

### Prompt 1-2: env + package.json

```
docs/final-plan-v2.md の「env追加」と「package.json追加スクリプト」セクションを参照して:

1. src/config/env.ts に以下の環境変数を追加:
   - NOTE_SESSION_COOKIE (optional string)
   - NOTIFICATION_DISCORD_WEBHOOK (optional url)
   - NOTIFICATION_LINE_TOKEN (optional string)
   - MAX_POSTS_PER_HOUR (number, default 3, min 1, max 10)
   - MAX_REPLIES_PER_HOUR (number, default 30, min 1, max 30)
   - SCRAPER_RATE_LIMIT_MS (number, default 3000)
   - TZ (string, default "Asia/Tokyo")

2. package.json に以下のスクリプトを追加:
   - "job:heartbeat": "tsx src/jobs/hourly-heartbeat.ts"
   - "job:heartbeat:dry": "tsx src/jobs/hourly-heartbeat.ts --dry-run"
   - "input:research": "tsx src/cli/input.ts research"
   - "input:feedback": "tsx src/cli/input.ts feedback"
   - "input:directive": "tsx src/cli/input.ts directive"
```

### Prompt 1-3: orchestration interface拡張

```
src/services/orchestration/index.ts を修正して:

1. OrchestrationService interfaceに以下のメソッドを追加:
   - processHumanInputs(llm: LlmClient, storage: StorageClient): Promise<string>
   - runNoteResearch(llm: LlmClient, storage: StorageClient, dryRun?: boolean): Promise<string>
   - runHourlyHeartbeat(...): Promise<string> は不要（heartbeat.tsが直接各サービスを呼ぶため）

2. OrchestrationServiceImpl に上記メソッドの実装を追加:
   - processHumanInputs: human_inputs テーブルから processed=0 のレコードを取得し、
     inputType に応じて research/feedback/directive を処理。処理後に processed=1, processedAt=now を更新。
   - runNoteResearch: 既存の runDailyTopicResearch を参考に、note用の競合リサーチを実行。

3. runPostPublishFollowup から fetchAndStoreResults の呼び出しを削除。
   followup は分類・分析のみ。結果保存は publish 時に済んでいる。

制約:
- 既存メソッドのシグネチャは変更しない
- 新メソッドは既存パターンに合わせる
```

### Prompt 1-4: content-scheduler

```
docs/final-plan-v2.md の「content-scheduler設計」セクションを参照して、
src/services/content-scheduler/index.ts を新規作成してください。

実装する機能:
1. decideActions(): 現在時刻・DB状態から今回のheartbeatで実行すべきアクションを決定
   - 未処理human_inputs → priority 1
   - 2時間おき通知 (偶数時JST) → priority 2
   - 未送信safe返信 → priority 3
   - スケジュール到達の投稿 → priority 4-5
   - エンゲージメント取得 (投稿後1-48時間) → priority 6
   - リサーチ (最終から24h経過) → priority 7-8
   - スケジュール最適化 (深夜0-1時JST) → priority 9

2. getNextThreadSlot() / getNextNoteSlot(): 次の投稿枠を取得
3. reserveSlot(): スロットを予約状態に
4. completeSlot(): スロットを完了状態に
5. skipSlot(): スロットをスキップ

重要:
- 時刻判定は必ずJST (UTC+9) で行う。getJstHour() ヘルパーを使う
- content_slots テーブルを使う
- outbound_notifications テーブルで最終通知時刻を確認
```

### Prompt 1-5: auto-publisher

```
docs/final-plan-v2.md を参照して src/services/auto-publisher/index.ts を新規作成。

実装:
1. publishApprovedThreadDrafts(api): status=audited のドラフトを自動投稿
   - MAX_POSTS_PER_HOUR を env から取得 (DI)
   - 投稿成功時: status→published, thread_post_results にINSERT, content_slots を完了
   - 投稿失敗時: エラーログ、次のドラフトへ続行

2. publishApprovedNoteDrafts(): Phase 3まで無効。throw new Error("Not implemented: enable in Phase 3") で塞ぐ

note自動公開は Phase 3 で有効化する。現時点では呼び出し自体を heartbeat から外している。
```

### Prompt 1-6: hourly-heartbeat.ts

```
docs/final-plan-v2.md の「hourly-heartbeat.ts設計」セクションのコードをベースに
src/jobs/hourly-heartbeat.ts を新規作成してください。

重要なポイント:
- heartbeat_states による二重起動防止（ロック取得→finally でロック解放）
- 各アクションは try-catch で包み、個別失敗でも全体は止めない
- generate_note の自動公開部分はコメントアウト（Phase 3待ち）
- dry-run 対応
- ContentSchedulerServiceImpl.decideActions() でアクション決定
```

### Prompt 1-7: CLI input

```
src/cli/input.ts を新規作成。

機能: 人間が追加リサーチ・フィードバック・ディレクティブをDBに保存する。
次回heartbeatで自動的にprocessHumanInputsが拾って処理する。

使い方:
  pnpm input:research "恋愛系で最近バズってるnote: https://..."
  pnpm input:feedback "もっと具体例を増やして"
  pnpm input:directive "来週は自己理解テーマに集中"

実装:
- process.argv から inputType と content を取得
- human_inputs テーブルにINSERT (processed=0)
- 使い方が間違っていたらヘルプ表示して exit(1)
```

---

## Phase 2: Threads自走強化

### Prompt 2-1: cadence-optimizer

```
docs/final-plan-v2.md の「cadence-optimizer設計」を参照して
src/services/cadence-optimizer/index.ts を新規作成。

実装:
1. analyzeOptimalTimes(channel): 曜日x時間帯ごとのエンゲージメント率を集計
2. adjustFrequency(llm): LLMに直近30投稿データを渡して最適頻度を推奨
   - LLM応答をJSON.parseしてバリデーション
   - 変更幅100%超はneedsHumanReview=trueを返す
3. generateSchedule(channel, days):
   - 既存pendingスロットを削除してから再生成（重複防止）
   - content_slots にINSERT
4. analyzeAndUpdate(llm): 上記を順次実行

重要: optimization_decisions に変更理由を必ず記録する。
```

### Prompt 2-2: reply-execution

```
docs/final-plan-v2.md の「reply-execution設計」を参照して
src/services/reply-execution/index.ts を新規作成。

実装:
1. executeSafeReplies(api):
   - reply_decisions.decision="safe_auto_reply" AND sent_at IS NULL のみ取得
   - 送信前にsent_atを先に埋める（楽観ロック）
   - 送信成功→そのまま
   - 送信失敗→sent_atをnullに戻す（リトライ可能に）
   - MAX_REPLIES_PER_HOUR をenvから取得

2. buildReplyQueue(): 返信待ちの一覧を返す（通知用）
```

### Prompt 2-3: engagement-analysis拡張

```
src/services/engagement-analysis/index.ts を修正して:

1. 既存の投稿単位分析に加えて、以下の集計を追加:
   - 時間帯別エンゲージメント率
   - 曜日別エンゲージメント率
   - テーマ別パフォーマンス
   - フック（冒頭文）パターン別CTR
   - CTA（導線）パターン別クリック率

2. 集計結果を channel_performance_snapshots テーブルに保存

3. improvementInsights を次回スケジュール改善にも反映できる形式で返す
```

---

## Phase 3: note自走

### Prompt 3-1: scraper

```
docs/final-plan-v2.md の「scraper設計」を参照して
src/adapters/scraper/index.ts を新規作成。

実装:
1. scrapeThreadsProfile(username): Threadsの公開プロフィールからHTMLパース
2. scrapeNoteAuthor(authorUrl): note著者ページからHTMLパース
3. scrapeNoteSearch(query): note検索結果からHTMLパース

重要:
- User-Agentは一般的なブラウザUA（Chrome最新版）を使う
- Accept, Accept-Language ヘッダーも付ける
- リクエスト間隔3秒以上
- 429レスポンス時は10秒待ってリトライ（最大2回）
- DryRunScraperClient も作る
```

### Prompt 3-2: note-api

```
src/adapters/note-api/index.ts を新規作成。

note非公式APIのラッパー。セッションクッキーで認証。

interface NoteApiClient:
- publishArticle(title, body, options): サムネなしで公開
- updateArticle(noteId, updates): 記事更新
- getMyArticles(): 自分の記事一覧
- getArticleStats(noteId): 記事の閲覧数・いいね・コメント数

実装:
- NOTE_SESSION_COOKIE を env から取得
- エンドポイント: https://note.com/api/v3/notes (推定)
- 失敗時のエラーハンドリング
- DryRunNoteApiClient も作る
- NOTE_MODE が research_only の場合は書き込みメソッドでthrow

注意: 非公式APIは仕様変更で壊れやすい。レスポンス形式のバリデーションを入れること。
```

### Prompt 3-3: note-engagement-analysis

```
src/services/note-engagement-analysis/index.ts を新規作成。

実装:
1. fetchAndStoreNoteResults(noteApi): 公開済みnoteの閲覧数等をnote_post_resultsに保存
2. analyzeNotePerformance(llm): テーマ別・構成別のパフォーマンス分析
3. generateNoteImprovements(llm): 次回note生成への改善提案
4. connectToThreadsInsights(): Threadsの勝ちテーマとnoteテーマの相関分析
```

### Prompt 3-4: heartbeat note自動公開を有効化

```
src/jobs/hourly-heartbeat.ts の generate_note ケースで
コメントアウトしている note 自動公開を有効化する。

1. autoPublisher.publishApprovedNoteDrafts() のコメントを外す
2. 公開した note ごとに:
   - thumbnail_tasks にINSERT (サムネ設定タスク)
   - notification.sendNotification で「サムネを設定してください」通知
3. auto-publisher の publishApprovedNoteDrafts() の
   throw new Error("Not implemented") を実装に差し替える
```

---

## Phase 4: 通知・運用完成

### Prompt 4-1: notification + notifier

```
docs/final-plan-v2.md の「notification設計」を参照して:

1. src/services/notification/index.ts を新規作成
   - generateProgressReport(): 今日の全統計を集計
   - sendNotification(): outbound_notifications にINSERT + 配信
   - storage が null なら ファイル保存スキップ（M3対応）
   - note公開数・返信送信数も集計に含める（L2対応）

2. src/adapters/notifier/index.ts を新規作成
   - NotifierClient interface: send(channel, content)
   - DiscordWebhookNotifier: NOTIFICATION_DISCORD_WEBHOOK に POST
   - LineNotifyNotifier: NOTIFICATION_LINE_TOKEN で LINE Notify
   - FileNotifier: docs/notifications/ に markdown 保存（fallback）

3. 2時間おき通知の内容:
   - 今日のheartbeat実行回数
   - Threads投稿数 + エンゲージメント
   - note投稿数
   - 次の投稿予定
   - 人間が今やるべきこと（サムネ対応、レビュー待ち）
```

### Prompt 4-2: 運用ドキュメント

```
docs/runbook.md を新規作成。以下の内容:

1. 初回セットアップ手順
   - env設定
   - DB migration
   - ジャンル選定 (pnpm input:directive)

2. 日常運用
   - heartbeat の cron 設定方法
   - 2時間通知の確認方法
   - サムネ対応の手順

3. トラブルシューティング
   - heartbeatが二重起動した場合
   - note API が壊れた場合
   - スクレイピングがブロックされた場合
   - 投稿頻度が急変した場合

4. 手動介入方法
   - pnpm input:research / feedback / directive
   - human_review_items の確認
   - dry-run での動作確認
```
