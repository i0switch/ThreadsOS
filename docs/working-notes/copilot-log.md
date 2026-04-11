# Copilot Consultation Log

## 2026-04-09 Session: threadsos-architecture

### Question
ThreadsOSを完全実装へ向けて進める際の、最小破壊・最大拡張性のアーキテクチャ分割案
- 案A: 既存サービス層にメモリ階層+ダッシュボード追加(最小変更)
- 案B: domain層をagent/memory/dashboardに3分割リファクタ
- 案C: 既存維持+新規dashboard/memory/agentモジュール追加(横付け)

### Copilot Response (GPT-5.4)
**推奨: 案C（構造化横付け）**

executiveの外側に memory, budget, diff, dashboard-projection を新設し、既存serviceはexecutorとして再利用する形。

### Key Insights
1. **部署定義のズレ**: 現状の6部署(command/research/threads/note/community/optimization)と仕様の5部署が不一致。実行部署と組織上の部署/役割を分ける
2. **メモリ粒度不足**: strategy_statesの単一JSON → memory_entries + summary/projectionテーブルに分離
3. **差分処理基盤不足**: cursor/version/hashベースのidempotent差分消化が必要
4. **予算未モデル化**: budget消費・上限・残高・部門配賦を先に入れる

### Breakdown Points
- heartbeat.tsとExecutiveServiceへの責務集中 → God object化リスク
- SQLiteの書き込み系とdashboard用read modelの分離が必要

### Test Focus
1. 差分/idempotency
2. 予算制御
3. メモリ昇格
4. 部署契約
5. dashboard投影

### Decision
- **案C採用**: 横付け追加（memory, budget, diff, dashboard-projection）
- 既存serviceはexecutorとして温存
- 次アクション: DBスキーマ拡張 → memory/budget/diff実装 → dashboard API

## 2026-04-09 Session: threadsos-dashboard

### Question
ダッシュボードの技術選択、API設計、データフロー

### Copilot Response (GPT-5.4)
**推奨: 案A（Fastify REST API + 静的HTML + htmx）**

### Decision
- htmxベースのダッシュボード（React不要）
- 18エンドポイント（UI partials 4 + API 14）
- 追加テーブル: proposals, proposal_events, agent_states, system_controls
- データフロー: ジョブ書込 → Dashboard Query Service集約 → htmx部分更新
- 次アクション: Geminiにダッシュボード実装を委譲
