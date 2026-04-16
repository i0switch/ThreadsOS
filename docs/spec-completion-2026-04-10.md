# ThreadsOS Spec Completion Audit (2026-04-10)

## Status

仕様書の主要要件は、このワークツリー時点の実装で満たしている。
2026-04-10 時点で build / lint / test / 主要ジョブ dry-run / サーバー到達性を再検証済み。

## Requirement Mapping

### 1. 自律運用の中核

- ハートビート駆動の実行計画、差分収集、優先度判定、部署選択、実行結果統合は [src/jobs/hourly-heartbeat.ts](src/jobs/hourly-heartbeat.ts) に実装。
- Executive による目的・ファネル段階・部署計画の決定は [src/services/executive/index.ts](src/services/executive/index.ts) に実装。
- 部署の責務分割は [src/domain/department/index.ts](src/domain/department/index.ts) と [README.md](README.md) の運用説明に整合。

### 2. 差分処理と最小コンテキスト

- 前回 heartbeat 以降の差分収集は [src/services/diff-collector/index.ts](src/services/diff-collector/index.ts) で実装。
- 部署サマリー、working memory、研究・競合・改善示唆を束ねた最小コンテキスト構築は [src/services/retrieval/index.ts](src/services/retrieval/index.ts) に実装。
- heartbeat 側で部署実行前に retrieval context を working memory に積む流れは [src/jobs/hourly-heartbeat.ts](src/jobs/hourly-heartbeat.ts) に実装。

### 3. 5層メモリ、予算、提案承認フロー

- メモリ層 CRUD と working memory の期限切れ処理は [src/services/memory/index.ts](src/services/memory/index.ts) に実装。
- 予算初期化、残量判定、消費記録は [src/services/budget/index.ts](src/services/budget/index.ts) に実装。
- 提案生成、承認履歴、段階的レビューは [src/services/proposal-flow/index.ts](src/services/proposal-flow/index.ts) に実装。
- これらを保持する DB テーブルは [src/db/schema.ts](src/db/schema.ts) と [src/db/bootstrap.ts](src/db/bootstrap.ts) に定義。

### 4. Threads / note 実行系

- Threads 投稿生成・監査・公開と返信送信は [src/services/auto-publisher/index.ts](src/services/auto-publisher/index.ts) および関連 services / adapters に実装。
- note の browser-assisted 運用とセッションベース操作は adapters 群と [README.md](README.md) の運用手順に反映。
- note の価格自動決定ロジックは [src/services/auto-publisher/index.ts](src/services/auto-publisher/index.ts) に実装。

### 5. 分析、改善、ダッシュボード

- Threads / note のエンゲージメント分析と改善示唆生成は [src/services/engagement-analysis/index.ts](src/services/engagement-analysis/index.ts) と [src/services/note-engagement-analysis/index.ts](src/services/note-engagement-analysis/index.ts) に実装。
- ダッシュボード API は [src/dashboard/routes.ts](src/dashboard/routes.ts) に、observation 集約は [src/services/dashboard-observation/index.ts](src/services/dashboard-observation/index.ts) に実装。
- ダッシュボード UI は [src/dashboard/public/index.html](src/dashboard/public/index.html) に実装。
- 本番相当のサーバー配線は [src/server/app.ts](src/server/app.ts) と [src/server/index.ts](src/server/index.ts) で共有化し、テスト対象にした。

### 6. 運用・検証・スケジューリング

- 主要ジョブと CLI は [package.json](package.json) に定義。
- Windows タスクスケジューラ登録は [scripts/setup-scheduler.ps1](scripts/setup-scheduler.ps1) に実装。
- 手順書は [README.md](README.md) と [docs/runbook.md](docs/runbook.md) に整備。
- 自動テストは [tests](tests) 配下に揃っており、dashboard / heartbeat / proposal flow / memory / budget / retrieval / safety を含む。

## Verification

- `pnpm build`
- `pnpm lint`
- `pnpm test`
- `pnpm job:heartbeat:dry`
- `pnpm job:daily-topic-research -- --dry-run`
- `pnpm job:daily-threads-plan -- --dry-run`
- `pnpm job:nightly-note-pipeline -- --dry-run`
- `pnpm job:weekly-retro -- --dry-run`
- `pnpm job:post-publish-followup -- --dry-run`
- ダッシュボードの `/health` と `/` が 200 を返すことを確認

## Notes

- KPI 可視化は dashboard query と channel performance snapshot を中心に成立している。
- `kpi_snapshots` テーブルは将来の集計正規化余地として残るが、今回の運用要件の検証対象としては現行ダッシュボード経路で要件を満たしている。