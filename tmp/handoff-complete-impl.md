# ThreadsOS 完全実装ハンドオフメモ

## 作業状態
- 日時: 2026-04-09
- 仕様書: C:\Users\i0swi\Downloads\threads_os_完全版仕様書.md（750行、全文読了済み）
- リポ調査エージェント: バックグラウンド実行中（結果待ち）
- LLMワーカー: PID 35320 で稼働中（Sonnet、8分タイムアウト）

## 仕様書の核心要件（全20章）
1. 自律型運用OS（Threads + note）
2. 5部署構成: 管理指揮 / 外部リサーチ / 競合分析 / Threads運用 / note運用
3. 各部署にリーダー + 係（担当者）
4. メモリ5階層: 永続方針 / 部署要約 / イベントログ / ワーキングメモリ / KPIスナップショット
5. 差分処理必須（全コンテキスト再送禁止）
6. ハートビート: 1時間1回、13ステップの標準フロー
7. 人間用ダッシュボード（司令塔）: 全体サマリー/部署別/担当者別/提案管理/ログ/介入
8. 提案・承認フロー: 担当者→リーダー→管理者→人間
9. エージェント予算管理（トークン/呼び出し回数/コスト上限）
10. KPI: Threads系(8項目) / note系(8項目) / 運用系(7項目)
11. 安全設計: ガードレール/自動停止/重複防止/縮退運転
12. 障害時挙動: リトライ/代替/通知/持ち越し/緊急停止
13. 3フェーズ: 最小運用版→分析改善版→高度自律版
14. コスト最適化: キャッシュ/モデル使い分け/圧縮要約

## 現状との主要ギャップ TOP10
1. **ダッシュボード未実装** — 仕様の第10章で詳細定義。UI/画面が一切ない
2. **5部署のマルチエージェント構造が不完全** — 現状はexecutive+department-executionで部署風だが、担当者(係)レベルの粒度がない
3. **メモリ5階層が未実装** — DBにフラットテーブルはあるが、永続方針/部署要約/ワーキングメモリ/KPIスナップショットの階層分離がない
4. **提案・承認フローが部分的** — human_review_itemsはあるが、仕様の提案必須要素（理由/根拠/リスク/優先度）が不足
5. **担当者別の状態管理なし** — エージェント状態テーブルが存在しない
6. **予算管理なし** — トークン/呼び出し回数の上限管理がない
7. **キャッシュ機構なし** — 競合分析結果等の再利用機構がない
8. **サマリー更新ルール未実装** — 日次/週次/勝ちパターン等の自動サマリーがない
9. **差分処理が不完全** — heartbeat_statesはあるが、仕様レベルの差分収集→重要度判定→選定が弱い
10. **KPI設計が部分的** — channel_performance_snapshotsはあるが、仕様の23項目を網羅していない

## 最初に直すべき箇所 TOP5
1. ダッシュボード基盤（Webサーバー + 最小UI）
2. メモリ階層のDB設計・テーブル追加
3. エージェント/担当者の状態管理テーブル
4. 提案データモデルの拡張（理由/根拠/リスク/優先度）
5. 予算管理の基本実装

## 次のセッションでやること
1. リポ調査エージェントの結果を読む
2. SPEC_GAP_ANALYSIS.md を作成
3. IMPLEMENTATION_PLAN.md を作成
4. ARCHITECTURE.md を作成
5. .github/copilot-instructions.md と AGENTS.md を作成
6. Copilotに設計相談（threadsos-architecture セッション）
7. フェーズAから実装開始

## Copilotに聞く最初の質問
「ThreadsOS を完全実装へ向けて進める際の、最小破壊・最大拡張性のアーキテクチャ分割案」
- 現状: SQLite + Drizzle ORM + TypeScript + pino logger
- 仕様: 5部署マルチエージェント + メモリ5階層 + ダッシュボード
- 制約: 既存コード活用、LLM_MODE=heartbeat（claude -p経由）

## 技術スタック
- Runtime: Node.js 22 + TypeScript
- DB: SQLite + Drizzle ORM + better-sqlite3
- LLM: Claude Code heartbeat mode (claude -p)
- Logger: pino
- Test: vitest
- Build: tsx
- Package: pnpm
- Threads: REST API
- note: Playwright (browser_assisted)

## ワーカー状態
- LLMワーカー: 稼働中（Sonnetモデル、8分タイムアウト）
- pending LLMタスク: 確認必要
- ハートビートの既知バグ: リライトタスクでたまに "Too many parameter values" エラー（原因未特定）
