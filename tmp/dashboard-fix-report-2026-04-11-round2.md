# ダッシュボード監査 修正レポート（Round 2）

**実行日時**: 2026-04-11 23:50
**対象ファイル**: `src/services/dashboard-query/index.ts`, `src/dashboard/public/index.html`, `src/services/dashboard-query/request-cache.ts`

## 検証結果

| 検証 | 結果 |
|------|------|
| `npx tsc --noEmit` | エラーなし |
| `npx vitest run` | 33ファイル / 162テスト 全パス |

---

## 修正1【最優先】: homeHtml内の描画順序変更

**対応要件**: awaitingConfirmationブロックをcurrentFlowブロックより上に移動。確認待ちが0件の場合のみcurrentFlowを先頭にする。

**変更内容**:
- `src/dashboard/public/index.html` の `homeHtml()` 関数内で、描画順序を変更:
  1. awaitingConfirmation（count > 0の場合のみ表示）
  2. revenueSummary（修正3）
  3. currentFlow
- 確認待ちが0件の場合は awaitingConfirmation ブロックが非表示になり、revenueSummary → currentFlow の順で描画される

**判定**: 対応完了

---

## 修正2【最優先】: 右パネルの初期自動選択

**対応要件**: 初回データ取得完了後に、確認待ちがあればその1件目を自動選択、なければfunnel概要を自動選択。state.selectedがnullの場合のみ。

**変更内容**:
- `src/dashboard/public/index.html` の `refreshAll()` 関数末尾に自動選択ロジックを追加
- `state.selected` が null の場合のみ実行
- inbox items があれば `choose("inbox", inboxItems[0].id)` を呼び出し
- なければ `choose("funnel", "root")` を呼び出し

**判定**: 対応完了

---

## 修正3【最優先】: 売上を目立つ独立表示にする

**対応要件**: DashboardHomeResponseにrevenueSummaryフィールドを追加。homeHtml()内で大きなフォント・緑系背景で独立表示。

**変更内容**:

バックエンド (`src/services/dashboard-query/index.ts`):
- `DashboardHomeResponse` に `revenueSummary: { value: string; trend: string; context: string }` フィールドを追加
- `getDashboardHome()` 内で `notes7d.revenueYen` から値を生成
  - value: `¥${notes7d.revenueYen}` のフォーマット
  - trend: 収益がある場合は記事数と収益発生中の表示、ない場合は「まだ収益なし」
  - context: 閲覧数・いいね数、または「記事の公開と価格設定が収益化の第一歩」

フロントエンド (`src/dashboard/public/index.html`):
- `homeHtml()` 内のawaitingConfirmationブロック直後に、revenueSummary専用の大きな表示ブロックを追加
- 緑系グラデーション背景（`from-emerald-50 to-teal-50`）
- 売上金額を `text-4xl font-bold` で大きく表示
- todayResultsの売上カードはそのまま維持

**判定**: 対応完了

---

## 修正4【次点】: getSummaryのリクエスト間キャッシュ

**対応要件**: memoizeDashboardQueryにTTL付きグローバルキャッシュ層を追加。TTL 10秒。既存のrequest-scopedキャッシュを維持した二層構造。

**変更内容** (`src/services/dashboard-query/request-cache.ts`):
- グローバルキャッシュ層 `Map<string, { value: unknown; expiry: number }>` を追加
- TTL: 10,000ms（10秒）
- 二層キャッシュの優先順位:
  1. request-scopedキャッシュ（同一リクエスト内での参照安定性を保証）
  2. グローバルTTLキャッシュ（リクエスト間の重複実行を防止、structuredCloneで参照分離）
  3. compute実行（両層に保存）
- `clearGlobalDashboardCache()` 関数をexportし、テスト間でのキャッシュ汚染を防止

**テスト対応**:
- `tests/dashboard-api.test.ts`: beforeEach/afterEachで `clearGlobalDashboardCache()` を呼び出し
- `tests/integration/dashboard-e2e.test.ts`: 同上
- `tests/dashboard-query-cache.test.ts`: 同上

**判定**: 対応完了

---

## 修正5【次点】: 「例外対応」の文言変更

**対応要件**: 初心者に心理的ハードルを与える文言を平易な表現に置換。

**変更内容** (`src/dashboard/public/index.html`):

| 変更前 | 変更後 |
|--------|--------|
| 例外対応と詳細データ | もっと見る・裏面データ |
| 例外対応 / 詳細データを開く | もっと見る |
| 例外対応 / 詳細データを閉じる | 閉じる |
| 例外時の手動操作 | 手動で調整する |
| 停止、再開、手動メモ、KPI、実行ログは例外時だけ触る。通常運用ではここを開かなくていい。 | ここはふだん見なくていい。止めたい・メモを入れたい・数字を確認したいときだけ使う。 |

**判定**: 対応完了

---

## 修正6【次点】: 承認/見送りの確認ダイアログ

**対応要件**: approve/rejectボタンクリック時にwindow.confirm()で確認を挟む。

**変更内容** (`src/dashboard/public/index.html`):
- `document.addEventListener("click")` 内の `data-action` ハンドラに確認ロジックを追加
- URLに "approve" が含まれる場合: `confirm("この提案を承認します。よろしいですか？")`
- URLに "reject" が含まれる場合: `confirm("この提案を見送ります。よろしいですか？")`
- confirm が false の場合は return で POST を中断

**判定**: 対応完了

---

## 修正7【次点】: 「次に何をすれば売上が上がるか」の示唆

**対応要件**: currentFlowにgrowthHintフィールドを追加。条件分岐でヒントを生成し、フロントエンドで青系ブロック表示。

**変更内容**:

バックエンド (`src/services/dashboard-query/index.ts`):
- `DashboardHomeResponse.currentFlow` に `growthHint: string | null` フィールドを追加
- 生成ロジック:
  - `notes7d.revenueYen === 0 && notePublishCount === 0` → "まずnote記事を1本公開すると、収益化導線が動き始める"
  - `notes7d.revenueYen === 0 && notePublishCount > 0` → "記事は出ているが売上がまだない。価格設定や記事テーマの見直しで突破口をつくれる"
  - `threads24h.published === 0` → "Threads投稿が止まっている。集客導線を動かすには投稿再開が最優先"
  - 上記いずれにも該当しない → null

フロントエンド (`src/dashboard/public/index.html`):
- currentFlowブロック内に、growthHintが非nullの場合のみ青系（`border-sky-200 bg-sky-50 text-sky-800`）の「成長のヒント」ブロックを表示

**判定**: 対応完了

---

## まとめ

全7件の修正を完了。TypeScript型チェック（`tsc --noEmit`）エラーなし、全162テスト通過を確認。
