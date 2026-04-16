# 修正結果レポート

- 作成日: 2026-04-11
- 更新理由: 別プロセスによる上書き後の再生成
- 対象: 監査レポート起点の是正対応
- 対象監査: tmp/audit-report-2026-04-11.md, tmp/audit-spec.md

## 概要

今回の反映内容は、確認できた差分ベースで次の 2 系統です。

1. ダッシュボードの最優先導線と重複取得の改善
2. 管理・指揮系統への部署通知連携の補強

監査文面をそのまま当てるのではなく、現在の実装差分と実際に通したテスト結果だけを基準に整理しています。

## 実施内容

### 1. ダッシュボード上部に「あなたの確認待ち」を追加

- src/dashboard/public/index.html
  - home セクション先頭に「あなたの確認待ち」カードを追加
  - 件数、要約、優先件数をトップで見えるように変更
  - inbox へ飛ぶ CTA を追加

意図:

- audit-spec の要件 2 / 10 で指摘されていた「最初に何を判断すべきかが見えにくい」を直接改善する

### 2. ダッシュボード API の重複取得をリクエスト単位でメモ化

- src/services/dashboard-query/request-cache.ts
  - AsyncLocalStorage ベースのリクエストスコープキャッシュを追加
- src/dashboard/routes.ts
  - ダッシュボード API を withDashboardQueryCache() 経由に変更
- src/services/dashboard-query/index.ts
  - readStrategyState()
  - currentProposalRows()
  - getSummary()
  - getDepartments()
  - getDepartmentDetail()
  - getReviews()
  - getAgents()
  を memoizeDashboardQuery() 経由に変更

意図:

- audit-spec の要件 12 で指摘されていた同一リクエスト内の重複計算を抑える

### 3. external-research の通知先に command を追加

- src/services/research/index.ts
  - research_update 通知の送信先に command を追加

意図:

- 外部リサーチの更新を管理・指揮系統にも直接届ける

補足:

- external-research から threads / note / competitive-analysis への通知は元コード側に既に存在していた
- 今回の追加は command 向けの補強のみ

### 4. competitive-analysis の結果を command にも直接通知

- src/services/department-execution/index.ts
  - competitive-analysis 実行後に command へ analysis_complete を追加
  - threads / note の分析件数、要約、勝ちパターンをまとめた payload を保存
  - combinedWinningPatterns を付与

意図:

- audit-report の要件 34 / 55 で残っていた command への直接共有不足を埋める

### 5. command レポートが未読部署通知を判断材料として取り込むよう変更

- src/services/department-execution/index.ts
  - command report 生成時に getUnreadNotifications("command") を反映
  - summary と recommendation に通知内容を反映
  - recommendation は「他部署通知を踏まえて全体判断を更新すべき」に切り替え

意図:

- 通知を保存するだけで終わらせず、実際に executive 側の判断材料として surfaced させる

### 6. 回帰テストを追加・更新

- tests/server.test.ts
  - ダッシュボード HTML に「あなたの確認待ち」が含まれることを確認
- tests/dashboard-query-cache.test.ts
  - リクエストスコープ内でメモ化が効くこと
  - リクエスト境界でキャッシュが分離されること
- tests/department-report.test.ts
  - command report が external-research / competitive-analysis の通知を取り込むことを確認
- tests/competitive-analysis.test.ts
  - 競合分析結果が command / note / threads に通知されることを確認

## 変更ファイル

- src/dashboard/public/index.html
- src/dashboard/routes.ts
- src/services/dashboard-query/index.ts
- src/services/dashboard-query/request-cache.ts
- src/services/research/index.ts
- src/services/department-execution/index.ts
- tests/server.test.ts
- tests/dashboard-query-cache.test.ts
- tests/department-report.test.ts
- tests/competitive-analysis.test.ts

## 検証

### 実行コマンド

```bash
pnpm vitest --run tests/department-report.test.ts tests/competitive-analysis.test.ts
pnpm vitest --run tests/server.test.ts tests/dashboard-query-cache.test.ts
```

### 結果

- 部署通知系: 2 ファイル 11 テスト成功
- ダッシュボード系: 2 ファイル 6 テスト成功
- 合計: 4 ファイル 17 テスト成功

確認できたこと:

- ダッシュボード HTML に最優先の確認待ち導線が出る
- dashboard-query の基底取得が同一リクエスト内で再利用される
- command report が external-research / competitive-analysis の通知を取り込む
- competitive-analysis の結果が command にも直接通知される

### 今回未実施の検証

- pnpm build
- 全体テストスイート

## 監査項目との対応

### audit-spec

- 要件 10: 対応
  - 「あなたの確認待ち」を home 最上部へ追加
- 要件 2: 対応
  - 最初に判断すべきことをトップバナーで見せるよう変更
- 要件 12: 対応
  - request-scoped memoization を追加

### audit-report

- 要件 34 / 55: 対応
  - competitive-analysis から command への直接通知を追加
- 要件 30 / 54: 部分補強
  - external-research から command への通知を追加
  - ただし threads / note / competitive-analysis への通知は元コード側に既に存在していた

## 残課題

- ダッシュボードのモバイル詳細導線改善
- メインセクションの IntersectionObserver ベース更新抑制
- セクション間ナビゲーション / TOC
- Threads / note 部署の「係」構成の仕様ズレ解消
- 全体 build / 全体テストの再確認

## 補足

外部リサーチ通知に関する監査指摘には、現行コードとズレている箇所がありました。そのため今回は、既に存在する通知経路を重複実装せず、本当に不足していた command への通知と command report への反映だけを追加しています。