# ThreadsOS Runbook

この runbook は `final-plan-v2` ベースの運用手順メモ。
対象は Phase 1-4 の自律運用と、人間が介入する境界の確認。

## まず見るもの

- `NOTE_MODE`
- `NOTE_SESSION_COOKIE`
- `NOTIFICATION_DISCORD_WEBHOOK`
- `MAX_POSTS_PER_HOUR`
- `MAX_REPLIES_PER_HOUR`

`LINE Notify` は `2025-03-31` で終了済み。
通知は `File` か `Discord` を使う。`LINE` は `unsupported` として安全に失敗させる。

## 起動手順

1. 依存を入れる

```powershell
pnpm install
```

2. `.env` を確認する

- `DATABASE_URL`
- `NOTE_MODE`
- `NOTE_SESSION_COOKIE`
- `NOTIFICATION_DISCORD_WEBHOOK`
- `THREADS_ACCESS_TOKEN`
- `THREADS_USER_ID`

3. DB を反映する

```powershell
pnpm db:migrate
```

4. ハートビートを手動確認する

```powershell
pnpm job:heartbeat:dry
pnpm job:heartbeat
```

## Phase 1

- 初回のジャンル選定だけ人間がやる
- 以降の人間入力は `input:research` / `input:feedback` / `input:directive` で積む
- 2時間おきの通知で「今日の進捗」「投稿内容」「次の投稿予定」を返す

```powershell
pnpm input:research
pnpm input:feedback
pnpm input:directive
```

## Phase 2

- Threads の下書き生成と公開候補の選別を回す
- 投稿前は `audit-threads` を通す
- 公開済みの扱いにするのは `publishedAt` と `threadsPostId` が揃った時だけ

## Phase 3

- `src/adapters/scraper/index.ts` は browser UA 付きで取得する
- 429 / 5xx は retry する
- `dry-run` では取得せず空配列を返す
- note 取得は非公式 HTML/JSON からの best-effort だけにして、落ちても全体停止しない

## Phase 4

- `src/adapters/note-api/index.ts` は cookie ベースの best-effort 実装
- `NOTE_MODE=research_only` では書き込みしない
- 書き込みは `draft_assist` か `browser_assisted` のみ
- 非公式 API が失敗したら明確に throw する
- browser-assisted に切り替えやすいように、API 呼び出しは `requestJsonCandidates` 経由で見る

## 通知

- `FileNotifier` は `docs/notifications/` に Markdown を残す
- `DiscordWebhookNotifier` は webhook に送る
- `LineNotifier` は常に fail する

通知種別は次の通り。

- `progress`: 進捗共有
- `action_needed`: 人間の確認が必要
- `alert`: 障害・失敗・停止

## note エンゲージメント分析

`pnpm job:heartbeat` の中で note 実績を取り込み、改善案を更新する。

- `note_post_results` に保存する
- `channel_performance_snapshots` に hourly / daily / theme / cta を残す
- `improvement_insights` に note 起点の示唆を入れる

見るポイントはこれ。

- 初速の閲覧数
- いいね率
- コメント率
- テーマ別の当たり外れ
- CTA 別の反応差

## 障害時

- note API 失敗: cookie、`NOTE_MODE`、非公式エンドポイントの順で見る
- scraper 失敗: UA、429、タイムアウト、対象ページの DOM 変化を見る
- 通知失敗: File に落ちているか、Discord webhook が生きているかを見る
- 返信暴走: `reply_decisions.sent_at` が入っているかを見る
- 追跡の再取得失敗: upsert ではなく insert になっていないかを見る

## 運用ルール

- 1時間おきに heartbeat を走らせる
- 2時間おきに人間へ要約通知を出す
- note の公開とサムネ作業は分離する
- 失敗は全体停止にしない
- ただし公開・送信・返信は送信済み管理がない限り再送しない

## 手元での確認

```powershell
pnpm test
pnpm lint
pnpm build
```

`pnpm build` が落ちるときは、まず `NOTE_MODE` と `env` を見て、その次に直近の差分を追う。
