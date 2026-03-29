# ThreadsOS 拡張修正案

## 目的

Threadsリサーチ、Threads投稿、投稿後のエンゲージメント分析、改善、リプライ返信、競合noteリサーチ、note生成、noteエンゲージメント分析、改善までを一気通貫で自動化する。

人間がやるのは以下だけに絞る。

- 初回のジャンル選定
- 必要に応じた追加リサーチ結果の投入
- note投稿後のサムネイル差し替え/編集

それ以外はシステムが自動で回し、Threads / note の投稿頻度、投稿時間、投稿内容も分析結果をもとに継続的に調整する。

---

## 運用方針

- 1時間おきに heartbeat タスクを実行する
- heartbeat 実行のたびに、調査、投稿判定、投稿後分析、改善、返信、note生成候補判定を回す
- 2時間おきに人間へ進捗通知を送る
- 通知内容は以下
  - 今日の進捗
  - 直近の投稿内容
  - 今後の投稿スケジュール
- Threads / note のリサーチはスクレイピング + Threads API + note非公式APIで行う
- noteのサムネイル生成は自動化しない
- サムネイル差し替え対象はタスク化して人間へ通知する

---

## 現状とのギャップ

現状の ThreadsOS は以下までしか持っていない。

- Threads: 調査、生成、監査、投稿後分析の一部
- note: 調査、生成、監査、下書き保存
- 定期実行: daily / nightly ベース

今回必要なのは以下。

- 日次ジョブ中心から毎時 heartbeat 中心へ移行
- Threads の投稿頻度/時間最適化
- Threads の自動返信実行
- note 競合調査の常時計測
- note 投稿後分析と改善ループ
- 2時間ごとの運用報告を作る通知レイヤーがない
- 人間リサーチ入力の取り込み
- note サムネ差し替えタスク管理

---

## 変更方針

### 1. ジョブ構成を heartbeat 中心に変える

既存の `daily-*` / `nightly-*` を補助ジョブに下げ、毎時の `hourly-heartbeat` を主ジョブにする。

heartbeat の中で以下を順に実行する。

1. 人間が追加したリサーチを取り込む
2. Threads / note の競合リサーチを更新する
3. Threads / note の成果データを再集計する
4. 投稿頻度、投稿時間、テーマ配分を再計算する
5. 今打つべき Threads を生成/監査/投稿する
6. 投稿済みThreadsの返信を取得し、自動返信可能なら返信する
7. 勝ち筋のテーマから note 候補を抽出する
8. note を生成し、監査し、公開または公開準備に進める
9. サムネ差し替えが必要な note をタスク化する
10. 2時間ごとに進捗通知を送る

---

## 追加・修正するファイル

### 既存修正

#### `src/services/orchestration/index.ts`
役割を「日次バッチ束ね」から「heartbeat 全体制御」に拡張する。

修正内容:
- `runHourlyHeartbeat()` を追加
- `runThreadsResearchCycle()`
- `runThreadsPostingCycle()`
- `runThreadsFollowupCycle()`
- `runNoteResearchCycle()`
- `runNotePipelineCycle()`
- `runNotificationCycle()`
を内部メソッドとして分割
- 投稿頻度や時刻の判定を scheduler / optimizer サービスに委譲

#### `src/db/schema.ts`
以下の新テーブルを追加する。

- `operator_profiles`
- `manual_research_inputs`
- `content_slots`
- `optimization_decisions`
- `channel_performance_snapshots`
- `note_post_results`
- `thumbnail_tasks`
- `heartbeat_states`
- `outbound_notifications`

#### `src/jobs/runner.ts`
heartbeat 用に以下を追加する。

- ジョブ名ごとの最終実行状態管理
- heartbeat の二重起動防止強化
- 通知ジョブと heartbeat ジョブの連携しやすい共通コンテキスト

---

### 新規追加

#### `src/jobs/hourly-heartbeat.ts`
毎時の主ジョブ。

役割:
- 全体フローの起点
- `runHourlyHeartbeat()` 呼び出し
- dry-run 対応
- heartbeat 実行ログ記録

#### `src/services/content-scheduler/index.ts`
役割:
- Threads / note の次回投稿候補をスケジュール管理
- 投稿枠の生成
- 投稿済み / 保留 / スキップ管理

機能:
- `getNextThreadSlot()`
- `getNextNoteSlot()`
- `reserveSlot()`
- `completeSlot()`
- `skipSlot()`

#### `src/services/cadence-optimizer/index.ts`
役割:
- 投稿頻度、投稿時間、テーマ配分の最適化

機能:
- 時間帯別の成果分析
- テーマ別の成果分析
- Threads / note の投稿間隔調整
- CTA / フック傾向の改善

#### `src/services/reply-execution/index.ts`
役割:
- safe 判定の reply を自動返信する

機能:
- `executeSafeReplies()`
- `buildReplyQueue()`
- 二重返信防止

#### `src/services/note-engagement-analysis/index.ts`
役割:
- note 投稿後の成果分析
- 改善提案生成
- 次回 note テーマや導線改善への反映

#### `src/services/notification/index.ts`
役割:
- 2時間ごとの進捗通知を生成/送信

通知内容:
- 今日の実行状況
- 直近投稿一覧
- 現在の勝ち筋
- 次の投稿スケジュール
- 人間対応が必要な項目

#### `src/adapters/scraper/index.ts`
役割:
- Threads / note のスクレイピング抽象化

用途:
- 競合Threads取得
- 競合note取得
- noteランキング/タグ/反応取得
- HTML / JSON / 非公式API の差異吸収

#### `src/adapters/note-api/index.ts`
役割:
- note非公式APIまたは browser-assisted 操作の抽象化

用途:
- note下書き保存
- note投稿
- note投稿後データ取得
- 本番失敗時の fallback

#### `src/adapters/notifier/index.ts`
役割:
- 通知先の抽象化

候補:
- Webhook
- Slack
- Discord
- ローカル markdown レポート保存

---

## DB追加案

### `operator_profiles`
初回ジャンル設定と運用ポリシーを保持する。

項目例:
- `id`
- `primary_niche`
- `sub_niches`
- `tone`
- `forbidden_topics`
- `monetization_goal`
- `created_at`
- `updated_at`

### `manual_research_inputs`
人間が追加で渡したリサーチを保存する。

項目例:
- `id`
- `source_type`
- `content`
- `tags`
- `applied_status`
- `created_at`

### `content_slots`
投稿予定管理。

項目例:
- `id`
- `channel` (`threads` / `note`)
- `scheduled_at`
- `topic_id`
- `status`
- `priority`
- `created_at`
- `updated_at`

### `optimization_decisions`
なぜ頻度や時間を変えたかの理由を記録する。

項目例:
- `id`
- `channel`
- `decision_type`
- `before_value`
- `after_value`
- `reason`
- `created_at`

### `channel_performance_snapshots`
時間帯別、テーマ別、形式別の成果集計。

### `note_post_results`
note の投稿結果を保存する。

項目例:
- `id`
- `draft_id`
- `note_url`
- `views`
- `likes`
- `comments_count`
- `published_at`
- `created_at`

### `thumbnail_tasks`
人間がサムネ対応すべき note を管理する。

項目例:
- `id`
- `note_draft_id`
- `status`
- `instruction`
- `created_at`
- `completed_at`

### `heartbeat_states`
heartbeat の実行制御用。

項目例:
- `job_name`
- `last_run_at`
- `next_notification_at`
- `consecutive_failures`

### `outbound_notifications`
送った通知の履歴。

---

## 既存サービスの具体的修正

### `src/services/research/index.ts`
修正内容:
- source を `threads_api | threads_scrape | note_scrape | note_unofficial_api | manual_input` に拡張
- note 競合調査と Threads 競合調査を分離
- スクレイピング結果と人間追加リサーチを同時に扱えるようにする

### `src/services/post-generation/index.ts`
修正内容:
- 生成時に「今の勝ち筋」「直近失敗テーマ」「推奨投稿時間」を参照
- note 導線だけでなく note 公開済みURL への接続も考慮

### `src/services/post-audit/index.ts`
修正内容:
- 自動返信誘導や炎上リスクだけでなく、時間帯適合性、重複テーマ率も評価
- scheduler と連携して「今出すべきか」判定を追加

### `src/services/engagement-analysis/index.ts`
修正内容:
- 投稿単位分析だけでなく、時間帯/曜日/テーマ/フック/CTA 別の集計を追加
- `improvementInsights` を単発提案だけでなく次回スケジュール改善にも反映

### `src/services/note-generation/index.ts`
修正内容:
- note 競合調査結果から構成差分を取り込む
- 公開済みThreadsの勝ちテーマを優先して note 化
- サムネが必要な note は `thumbnail_tasks` を生成

### `src/services/note-audit/index.ts`
修正内容:
- note 公開可否だけでなく、公開タイミング、導線強度、Threads連携性を監査対象に含める

---

## 通知仕様

### 2時間通知
出す内容:
- 今日の heartbeat 実行回数
- 今日の Threads 投稿数
- 今日の note 投稿数
- 直近の成果
- 次の投稿予定
- 競合変化の要点
- 人間が今やるべきこと
  - サムネ差し替え
  - 追加リサーチ投入
  - high risk 項目確認

### 通知トリガー
- heartbeat ごとに `next_notification_at` を確認
- 2時間経過していれば通知
- 通知後に次回時刻を更新

---

## 実装フェーズ

### Phase 1: heartbeat 化
対象:
- `src/jobs/hourly-heartbeat.ts`
- `src/services/orchestration/index.ts`
- `src/db/schema.ts`

やること:
- heartbeat 起点の運用に切り替える
- `heartbeat_states` と `content_slots` を追加
- 2時間通知の土台を入れる

### Phase 2: Threads 自走強化
対象:
- `src/services/cadence-optimizer/index.ts`
- `src/services/content-scheduler/index.ts`
- `src/services/reply-execution/index.ts`
- `src/services/engagement-analysis/index.ts`

やること:
- 投稿頻度/時間最適化
- 自動返信
- 時間帯分析
- スケジュール自動調整

### Phase 3: note 自走強化
対象:
- `src/adapters/note-api/index.ts`
- `src/adapters/scraper/index.ts`
- `src/services/note-engagement-analysis/index.ts`
- `src/services/note-generation/index.ts`

やること:
- note競合調査
- note投稿
- note投稿後分析
- サムネ人間タスク化

### Phase 4: 通知と運用完成
対象:
- `src/services/notification/index.ts`
- `src/adapters/notifier/index.ts`
- `docs/operating-model.md`
- `docs/architecture.md`
- `docs/runbook.md`

やること:
- 2時間通知完成
- runbook 更新
- 障害時の fallback 整備

---

## リスクと対策

### note 非公式API依存
リスク:
- 仕様変更で壊れやすい

対策:
- adapter に隔離
- fallback を scraper / browser-assisted に分ける
- heartbeat 失敗時も他処理は止めない

### スクレイピング失敗
リスク:
- source 欠損で誤った最適化

対策:
- source ごとに freshness 管理
- stale data を明示して使う
- 取得失敗時は前回スナップショットを利用

### 自動改善の暴走
リスク:
- 投稿頻度や時間が急変する

対策:
- 変更幅の上限を設ける
- `optimization_decisions` に理由を記録
- 急激な変更は human review に回す

### 自動返信の炎上
対策:
- safe のみ自動返信
- 高リスクは review queue
- reply 実行ログを必ず残す

---

## 最終イメージ

最終的には ThreadsOS を以下の形にする。

- 1時間ごとに heartbeat が走る
- Threads / note の調査、生成、投稿、分析、改善を毎回更新する
- 投稿頻度、投稿時間、投稿テーマは固定ではなく最適化され続ける
- 人間は初回ジャンル設定と追加リサーチ、サムネ対応だけでよい
- 2時間ごとに進捗と次の予定が自動通知される

この形にすると、Threads と note を単発バッチではなく「継続改善しながら回る運用OS」として扱える。
