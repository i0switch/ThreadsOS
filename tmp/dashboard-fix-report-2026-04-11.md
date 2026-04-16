# ダッシュボード監査対応 修正結果レポート

修正日時: 2026-04-11
対象監査: tmp/dashboard-audit-2026-04-11-221753.md

## 修正サマリー

- TypeScript型チェック: 通過
- テスト: 33ファイル 162テスト 全パス
- 変更ファイル: 2ファイル

---

## 修正1: 主導線統合 — 現在地・判断・ボトルネックを1ブロックに

**対応要件:** 要件1, 2, 7, 10, 15
**判定変化:** 一部実装 → 大幅改善

### バックエンド (src/services/dashboard-query/index.ts)
- `DashboardHomeResponse` に `currentFlow` フィールドを追加
  - `nowRunning`: 定期チェックの稼働状況と今日の実行回数
  - `stoppedReason`: 止まっている項目の一覧（null=なし）
  - `nextHumanAction`: 次に人が判断すべきこと（stallを除外）
  - `nextAiAction`: 次のAI行動
  - `funnelBottleneck`: 導線の詰まり（null=なし）
- `getDashboardHome()` で上記を既存の `summary`, `stoppedItems`, `inbox`, `aiActivity`, `funnel` から自動生成

### フロントエンド (src/dashboard/public/index.html)
- `homeHtml()` の先頭に「いまの全体フロー」統合ブロックを追加
- 緑→青のグラデーション背景で視覚的に最優先表示
- 止まり（amber警告）、導線の詰まり（rose警告）を条件付き表示
- 次の人の判断 / 次のAI行動を2カラムで並列表示

---

## 修正2: 確認待ちからstallを分離

**対応要件:** 要件2, 10
**判定変化:** 一部実装 → 改善

### バックエンド (src/services/dashboard-query/index.ts)
- `awaitingConfirmation.count`: `inbox.items` → `inbox.items.filter(kind !== "stall")` に変更
- `awaitingConfirmation.urgentCount`: 同上、stallを除外
- `awaitingConfirmation.summary`: 文言を「止まりや判断待ち」→「判断待ち」に修正
- `awaitingConfirmation.preview`: stallを除外してからslice

### 効果
- 「あなたの確認待ち」に表示されるのは、承認/却下の判断が必要な項目のみ
- stall（停滞情報）は `stoppedItems` と `currentFlow.stoppedReason` で別途表示

---

## 修正3: storyboardを動的部署対応に

**対応要件:** 要件3
**判定変化:** 一部実装 → 改善

### バックエンド (src/services/dashboard-query/index.ts)
- `getDashboardStoryboard()` で固定5部署の blueprints に加え、`getDepartments()` で取得した全部署を動的にカバー
- blueprints に含まれない部署は自動的に storyboard の末尾に追加
- 動的部署も同じ形式（status, members, outputs, blockers, basedOn）で表示
- `const teams` → `const teams: DashboardStoryboardResponse["teams"]` に型注釈追加（pushを許容）

---

## 修正4: タイムラインに人間イベントフィルタ追加

**対応要件:** 要件5
**判定変化:** 一部実装 → 改善

### バックエンド (src/services/dashboard-query/index.ts)
- `DashboardTimelineResponse` に `humanEventCount: number` を追加
- `getDashboardTimeline()` の戻り値に `humanEventCount` を追加（actorType === "human" のイベント数）

### フロントエンド (src/dashboard/public/index.html)
- `state` に `timelineHumanOnly: false` を追加
- `timelineHtml()` にフィルタ切り替えボタンを追加
  - 「すべて (件数)」ボタン: 全イベント表示
  - 「管理者のみ (件数)」ボタン: 人間イベントのみ表示
- クリックハンドラで `timelineHumanOnly` のトグルと再描画を実装
- 管理者フィルタ時はstall自動挿入をスキップ

---

## 修正5: 重複集約の削減とセクション単位更新最適化

**対応要件:** 要件12, 13
**判定変化:** 実装はあるが要件ズレ → 改善

### フロントエンド (src/dashboard/public/index.html)
- `IntersectionObserver` を導入し、各セクションの可視状態を `sectionVisibility` で追跡
- `rootMargin: "200px"` で先読みし、スクロール前に事前取得
- `refreshAll()` を改修: 非強制更新時は `sectionVisibility[name] === false` のセクションをスキップ
- 強制更新（visibilitychange復帰時）は従来通り全セクション更新

### 効果
- ページ下部のセクション（decisions, timeline, funnel等）はスクロールで見えるまでポーリングしない
- 15秒間隔の定期更新で不要なAPI呼び出しを削減
- バックエンド側の `memoizeDashboardQuery` によるリクエスト内キャッシュと組み合わせて二重最適化

---

## 修正6: 内部運用語の除去と初心者向け文言強化

**対応要件:** 要件8, 15
**判定変化:** 一部実装 / 要件ズレ → 改善

### フロントエンド (src/dashboard/public/index.html)

#### 手動操作フォームの改善
- `scope` 入力: `type="hidden"` に変更（初心者に不要）
- `target` セレクト: 選択肢を初心者向けに書き換え
  - 「担当AIへメモ」→「特定のAIチームへ伝える」
  - 「次回の定期チェックで優先」→「次の定期チェックで優先させる」
- `priority` セレクト: 「低/中/高」→「優先度: 低/中/高」
- `department`: フリーテキスト入力 → プルダウン選択に変更（管理指揮/外部リサーチ/競合分析/Threads運用/note運用）
- `agentId` 入力: `type="hidden"` に変更（初心者に不要）

#### KPI表示の改善
- `JSON.stringify(x.metrics)` → キー・値ペアの人間向け表示に変換
- 数値は `toLocaleString("ja-JP")` でフォーマット

#### ハートビート→定期チェックの文言統一
- ヘッダー説明文: 「毎時ハートビートを起点に」→「毎時の定期チェックを起点に」
- ホームセクション説明文: 「毎時ハートビートで」→「毎時の定期チェックで」

---

## 監査要件別の改善状況

| 要件 | 監査時判定 | 修正後 | 主な改善 |
|------|-----------|--------|---------|
| 1. トップで今何が起きているか分かる | 一部実装 | 改善 | currentFlowで統合表示 |
| 2. 何を判断すればよいか分かる | 一部実装 | 改善 | stall分離で判断のみ表示 |
| 3. 各部署の活動が分かる | 一部実装 | 改善 | 動的部署追加 |
| 4. AIの判断根拠が読める | 実装済み | 維持 | — |
| 5. 管理者の操作が追える | 一部実装 | 改善 | 人間フィルタ追加 |
| 6. 集客→収益化導線で見える | 実装済み | 維持 | — |
| 7. AI組織の運用フローが見える | 一部実装 | 改善 | currentFlowで一本化 |
| 8. 初心者向け文言 | 一部実装 | 改善 | 内部語除去・フォーム改善 |
| 9. 一覧→詳細の導線 | 実装済み | 維持 | — |
| 10. 確認待ちが最優先 | 一部実装 | 改善 | stall分離で精度向上 |
| 11. KPI等が主役になりすぎない | 実装済み | 維持+改善 | KPI表示人間化 |
| 12. データ取得の重複 | 要件ズレ | 改善 | セクション可視判定で削減 |
| 13. 非表示の自動更新抑制 | 一部実装 | 改善 | IntersectionObserver導入 |
| 14. 情報設計がストーリー別 | 一部実装 | 微改善 | currentFlowで統合度向上 |
| 15. 初心者向け販売アプリとして直感的 | 要件ズレ | 改善 | フォーム・文言・統合ブロック |

## 残課題（後回し判定のもの）

1. 詳細データ面の表現改善（KPIテーブルの可視化向上など）
2. storyboardの追加部署の表示の厚み調整
3. bridge段階の数値を実トラフィック連結に近づける
4. seenInformationのslice制限による根拠表示の不完全性
