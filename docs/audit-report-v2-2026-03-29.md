# ThreadsOS Phase 1 実装後 監査レポート v2

**監査日**: 2026-03-29
**監査者**: Claude Opus 4.6 + Codex GPT-5.4-mini
**対象**: src/ 配下 全43ファイル
**前回監査**: `docs/final-plan-v2.md` の指摘 H1-H7, M1-M5, L1-L2

---

## 前回監査指摘の対応状況

| ID | 指摘 | 状態 | 確認箇所 |
|---|---|---|---|
| H1 | 2文書の設計分裂 | **対応済み** | `hourly-heartbeat.ts` に統一。命名・テーブル・ジョブ名が一貫 |
| H2 | idempotency欠如 | **対応済み** | `reply_decisions.sent_at` 追加 (schema:82)。楽観ロック実装 (reply-execution:54-60, auto-publisher:241-243) |
| H3 | note API placeholder | **対応済み** | `note-api/index.ts` 312行。実API呼び出し、cookie認証、requestJsonCandidates でエンドポイント候補探索、レスポンスパース・バリデーション完備 |
| H4 | A-1 followup衝突 | **一部残存** | `orchestration:206-209` では削除済みだが、`engagement-analysis/index.ts:39,295` に `fetchAndStoreResults` が残存（Codex発見） |
| H5 | orchestration interface未定義 | **対応済み** | `processHumanInputs()` (orchestration:33-93) と `runNoteResearch()` (orchestration:96-123) 追加済み |
| H6 | Part A既修正済み | **対応済み** | Part A をドキュメントから削除 |
| H7 | User-Agent即ブロック | **対応済み** | `scraper:3` で `Chrome/131.0.0.0` ブラウザUA使用。Accept, Accept-Language ヘッダーも付与 |
| M1 | env未配線 | **対応済み** | コンストラクタDI: `AutoPublisherServiceImpl({maxPostsPerHour})`, `ReplyExecutionServiceImpl(maxRepliesPerHour)`, `ContentSchedulerServiceImpl(maxPostsPerHour)` |
| M2 | スケジュール重複 | **対応済み** | `cadence-optimizer:116-124` で既存pending削除→再生成 |
| M3 | storage null | **対応済み** | `notification:72` で `this.storage = storage ?? null`、`230` で `if (this.storage && ...)` ガード |
| M4 | TZ依存 | **対応済み** | `content-scheduler:50-56` で `Intl.DateTimeFormat` + `Asia/Tokyo` 使用。notification も同様 |
| M5 | Phase依存曖昧 | **対応済み** | `final-plan-v2.md` で依存順序明記 |
| L1 | LLM JSONパース未実装 | **対応済み** | `cadence-optimizer:88-109` でJSON.parse + バリデーション + min/max クランプ + fallback |
| L2 | 通知のTODO残り | **対応済み** | `notification:103-107` で `notePostResults` と `replyDecisions.sentAt` から集計 |

**前回指摘: 13/14 対応済み、1件一部残存 (H4)**

---

## 新規発見事項

### Critical — 1件

#### C-1: tsc コンパイルエラー 4件 + テスト2件失敗 [Codex発見・検証済み]

**検証コマンド**: `pnpm exec tsc --noEmit` → 4 errors, `pnpm exec vitest run` → 2 failures

| ファイル | 行 | エラー内容 |
|---|---|---|
| `src/adapters/note-api/index.ts` | 89, 108 | 型エラー（レスポンス型の不一致） |
| `src/services/engagement-analysis/index.ts` | 377 | 型エラー |
| `src/services/note-engagement-analysis/index.ts` | 74, 80 | 型エラー |
| `tests/reexecution-safe.test.ts` | - | `replyDecisions` 未import |
| `tests/reprocessing.test.ts` | - | `replyDecisions` 未import |

**ビルドが通らない = デプロイ不能。最優先で修正必須。**

### High — 4件

#### H-NEW-1: `auto-publisher` の `dryRunMode` がモジュールレベル定数

**箇所**: `src/services/auto-publisher/index.ts:18`

```typescript
const dryRunMode = process.argv.includes("--dry-run");
```

これはモジュール読み込み時に1回だけ評価される。`heartbeat.ts` が `--dry-run` なしで起動した場合、`auto-publisher` 内の `dryRunMode` は常に `false`。しかし問題は逆のケース: **テスト時や他のジョブから import すると、そのジョブの `--dry-run` フラグに引きずられる**。サービスの挙動がimportタイミングに依存するのは危険。

**修正提案**: dryRun をコンストラクタオプションか、各メソッドの引数として受け取る。

#### H-NEW-2: `runner.ts` の二重起動防止と `heartbeat.ts` の二重起動防止が二重に走る

**箇所**: `src/jobs/runner.ts:24-34` + `src/jobs/hourly-heartbeat.ts:54-79`

`runner.ts` は `scheduledJobRuns` テーブルで status="running" をチェック。`hourly-heartbeat.ts` は `heartbeatStates` テーブルで `lockedBy` をチェック。2つの独立したロック機構が同時に動いていて、片方がロック解放に失敗すると整合性が崩れる。

**修正提案**: どちらかに統一する。heartbeat のロック管理が50分タイムアウト付きで堅牢なので、runner.ts の二重起動チェックを heartbeat ジョブでは無効化するか、heartbeat 側のロックに一本化。

#### H-NEW-3: ジョブロックのクラッシュ耐性不足 [Codex発見]

**箇所**: `src/jobs/runner.ts:23` + `src/jobs/hourly-heartbeat.ts:73`

select → insert/update が非原子的。ジョブがクラッシュすると `scheduledJobRuns` の `status="running"` 行が残り、**翌日以降の全ジョブが永続スキップ**になる。heartbeat 側は50分タイムアウトがあるが、runner.ts 側にはない。

**修正提案**: runner.ts にも stale lock 検出を追加。`running` 状態が1時間以上続いたら自動解放。または atomic UPDATE ... WHERE で楽観ロック化。

#### H-NEW-4: `note-research` が依然 placeholder [Codex発見]

**箇所**: `src/adapters/note-research/index.ts:41,66`

plain fetch + `return []` のまま。note 側の競合調査データが空のため、note生成の学習信号がゼロ。H3（note-api）は対応されたが、**note-research adapter は未対応**。

**修正提案**: `scraper/index.ts` の `ScraperClientImpl` を使う形に差し替えるか、heartbeat から note research を外す（Phase 3 待ち）。

---

### Medium — 7件

#### M-NEW-1: `content_slots` の unique制約が実質無効

**箇所**: `src/db/schema.ts:161-162`

```typescript
uniqueSlot: uniqueIndex("content_slots_channel_scheduled_at_status_unique")
    .on(table.channel, table.scheduledAt, table.status),
```

`(channel, scheduledAt, status)` の組み合わせでユニーク。しかし同じ `channel` + `scheduledAt` に対して `status="pending"` と `status="published"` は別レコードとして挿入できてしまう。本来やりたかったのは「同一チャネル・同一時刻にpendingは1つだけ」だが、**statusが違えば何個でも入る**。

**修正提案**: unique制約を `(channel, scheduledAt)` のみにするか、INSERTロジック側で重複チェック。実際には `syncThreadSlotsFromAuditedDrafts` が `existingDraftIds` でチェックしているので即座に壊れはしないが、制約の意図と実装が乖離。

#### M-NEW-2: `processHumanInputs` が最初のアクティブトピックにのみ紐付け

**箇所**: `src/services/orchestration/index.ts:67-68`

```typescript
const targetTopic = activeTopics[0];
```

research/feedback の入力が常に最初のトピックに紐付けられる。複数トピックがある場合、ユーザーが意図したトピックと違うものに紐付く可能性がある。

**修正提案**: 入力内容とトピック名の類似度マッチング、または入力時にトピックIDを指定可能にする。

#### M-NEW-3: `scraper` のリクエスト間隔制御がない

**箇所**: `src/adapters/scraper/index.ts:130-205`

`ScraperClientImpl` には `SCRAPER_RATE_LIMIT_MS` env値が定義されているが、クラス内で使われていない。`fetchHtml` のリトライ待ちはあるが、**連続リクエスト間のレート制限（各リクエスト前に3秒待つなど）がない**。`scrapeNoteSearch` → `scrapeNoteAuthor` を連続で呼ぶと即連続アクセスになる。

**修正提案**: クラスに最終リクエスト時刻を持たせ、`loadHtml` 内で前回からの経過時間を見て待機。

#### M-NEW-4: `cadence-optimizer` の `analyzeOptimalTimes` がUTC基準で曜日・時間を計算

**箇所**: `src/services/cadence-optimizer/index.ts:37-42`

```typescript
const publishedAt = new Date(result.publishedAt);
const key = `${publishedAt.getDay()}-${publishedAt.getHours()}`;
```

`getDay()` / `getHours()` はローカルタイム（=サーバーTZ）依存。他のコード（content-scheduler, notification）は `Intl.DateTimeFormat` + `Asia/Tokyo` でJST変換しているのに、ここだけUTCの可能性がある。

**修正提案**: 他と同様に `Intl.DateTimeFormat` でJST基準に統一。

#### M-NEW-5: `LineNotifier` が即 throw する

**箇所**: `src/adapters/notifier/index.ts:73-82`

LINE Notify が2025-03-31で終了済みという正しい判断だが、`createNotifier` で LINE が選択される経路がないため、**実質デッドコード**。env に `NOTIFICATION_LINE_TOKEN` が定義されてるのに使われる場所がない。

**修正提案**: env から `NOTIFICATION_LINE_TOKEN` を削除するか、LINE Messaging API への移行パスをTODOとして残す。

#### M-NEW-6: sent_at/slot予約のクラッシュ時リカバリ不足 [Codex発見]

**箇所**: `src/services/reply-execution/index.ts:53,64` + `src/services/auto-publisher/index.ts:90,116`

楽観ロックで sent_at を先に書くが、**変更件数の確認（changes check）がない**。同時実行で2つのプロセスが同じレコードを掴む可能性。また、クラッシュ時に sent_at が書かれたまま送信されないケースで、stale 予約のリカバリ機構がない。

**修正提案**: UPDATE の返り値で `changes === 0` なら他プロセスが先に処理したとしてスキップ。stale sent_at（10分以上前）のリセット処理を heartbeat 起動時に追加。

#### M-NEW-7: `cadence-optimizer` が空データでも既存スケジュールを削除する [Codex発見]

**箇所**: `src/services/cadence-optimizer/index.ts:116,129`

`generateSchedule` で最初に pending スロットを全削除してから新スケジュールを生成するが、**分析データが不足して topSlots が空の場合、既存の予定だけ消えて何も生成されない**。

**修正提案**: topSlots が空（or 最低数未満）なら delete をスキップ、または delete を insert 成功後に行う。

---

### Low — 3件

#### L-NEW-1: `notification` の `recentPosts` が `draftId` を表示

**箇所**: `src/services/notification/index.ts:110-119`

```typescript
titleOrBody: result.draftId,
```

進捗レポートの「直近投稿」にdraftのIDが表示される。人間には意味不明。draft の body や title を引いて表示すべき。

#### L-NEW-2: `note-engagement-analysis` の `connectToThreadsInsights` が heartbeat から呼ばれていない

**箇所**: `src/services/note-engagement-analysis/index.ts:314-347`

Threads/note相関分析メソッドがあるが、heartbeat のどのアクションからも呼ばれていない。使われないコード。

**修正提案**: heartbeat の `optimize_schedule` か `fetch_engagement` の中で呼ぶ、または Phase 4 まで保留。

#### L-NEW-3: `auto-publisher.sendSafeReplies` と `reply-execution.executeSafeReplies` が機能重複

**箇所**: `auto-publisher:208-266` vs `reply-execution:43-78`

両方とも `safe_auto_reply` + `sentAt IS NULL` の返信を取得して送信する機能。heartbeat は `reply-execution` を使っているが、`auto-publisher` にも同じロジックが残っている。

**修正提案**: `auto-publisher.sendSafeReplies` を削除するか、`reply-execution` に委譲する薄いラッパーに変更。

---

### Info — 2件

#### I-1: `note-api` のエンドポイント候補探索は堅実な設計

`requestJsonCandidates` で複数パスを試すパターンは非公式API対応として適切。仕様変更への耐性がある。

#### I-2: `notifier` のフォールバック設計が良い

Discord失敗 → File に自動フォールバック (`notification:204-216`)。通知が完全に失われない設計。

#### I-3: env DI は部分反映 [Codex発見]

以下のファイルに `loadEnv()` / `process.env` 直読みが残存:
- `src/services/content-scheduler/index.ts:66`
- `src/services/auto-publisher/index.ts:20`
- `src/services/notification/index.ts:76`
- `src/adapters/threads-api/index.ts:31`
- `src/adapters/note-api/index.ts:50`

設定変更の追跡性が低いが、動作自体には問題なし。リファクタ優先度は低い。

---

## 監査サマリー

| 重大度 | 件数 | 前回比 |
|---|---|---|
| **Critical** | **1** | 新規（tscエラー+テスト失敗） |
| **High** | **4** | -3 (前回7) |
| **Medium** | **7** | +2 (前回5) |
| Low | 3 | +1 (前回2) |
| Info | 3 | +1 |

### 前回指摘対応率: **13/14 (93%)** — H4 が一部残存

### tsc / テスト検証結果 [Codex実行]

```
pnpm exec tsc --noEmit → 4 errors
pnpm exec vitest run  → 2 failures (reexecution-safe, reprocessing)
```

### 総合評価

前回の重大な設計問題の大半は解消。しかし **ビルドが通らない状態** (Critical 1件) があり、デプロイ不能。また note-research adapter が placeholder のまま (H-NEW-4)、ジョブロックのクラッシュ耐性 (H-NEW-3) も要対応。

全体の設計品質は大幅向上しているが、**本番投入には Critical + High の修正が必須**。

### 推奨対応順序

| 優先度 | ID | 作業 | 影響 |
|---|---|---|---|
| **P0** | **C-1** | tsc エラー4件 + テストimport修正 | ビルド不能 |
| P1 | H-NEW-3 | runner.ts の stale lock リカバリ追加 | ジョブ永続停止リスク |
| P1 | H-NEW-4 | note-research を scraper 経由に差替え or heartbeat から外す | note学習信号ゼロ |
| P1 | H-NEW-1 | auto-publisher dryRunMode DI化 | テスト安全性 |
| P1 | H-NEW-2 | 二重起動防止の統一 | ロック残留リスク |
| P2 | M-NEW-6 | sent_at/slot 予約の changes チェック + stale リカバリ | 二重送信リスク |
| P2 | M-NEW-7 | cadence-optimizer 空データ時の安全策 | スケジュール消失 |
| P2 | M-NEW-4 | cadence-optimizer JST統一 | 投稿時間分析ズレ |
| P2 | M-NEW-3 | scraper レート制限実装 | ブロックリスク |
| P3 | 残り | M-NEW-1,2,5 + Low + Info | Phase 2以降で対応可 |

---

## リスクまとめ [Codex + Claude 統合]

| リスク | 重大度 | 発生条件 |
|---|---|---|
| ジョブロックが crash 後に残り、翌日以降の runJob が永続スキップ | High | heartbeat プロセスが途中でkill |
| note 競合調査が placeholder で学習信号が空 | High | note-research が呼ばれた時 |
| slot/reply 予約が lease ではないため二重投稿しうる | Medium | 同時実行 or クラッシュ |
| env 直読みが残り設定変更の追跡性が低い | Low | 設定変更時のデバッグ |

---

## 監査者別カバレッジ

| 観点 | Claude | Codex |
|---|---|---|
| 設計意図との整合性 | **主担当** | サブ |
| tsc / テスト実行検証 | - | **主担当** |
| idempotency / 競合制御 | 共同 | 共同 |
| DB制約の妥当性 | **主担当** | サブ |
| import / 型エラー | - | **主担当** |
| placeholder / TODO 検出 | サブ | **主担当** |
| User-Agent / セキュリティ | **主担当** | サブ |
| env DI 配線状況 | サブ | **主担当** |
