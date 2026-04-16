# ThreadsOS 自律運用基盤改修 — 作業完了レポート

実行日時: 2026-04-12

---

## 改修2: エージェント配置の整理

### 変更ファイル
- `src/services/runtime-state/index.ts`

### 実施内容
- **移動:** `threads-competitor-researcher` と `note-competitor-researcher` を `competitive-analysis` 部署に移動。leaderId もそれぞれ `competitive-analysis-director` に変更
- **ID変更:** `community-director` → `competitive-analysis-director`（旧部署名の残骸を解消）
- **leaderId更新:** `engagement-analyst` の leaderId を `competitive-analysis-director` に修正
- **3エージェント削除:** `reply-manager`（機能なし）、`optimization-director`（executive-directorと重複）、`cadence-optimizer`（threads-operations-directorに統合済み）
- **preferredWorkers更新:** `weekly_retro`・`optimize_schedule` → `threads-operations-director`、`notify` → `executive-director`
- **DBクリーンアップ:** `ensureCatalog()` 末尾にAGENTS配列に存在しないIDの自動削除ロジックを追加

### 結果
- 17名 → 14名（3名削減）
- テスト: 33ファイル 162テスト 全パス

---

## 改修3: 全名称の日本語化

### 変更ファイル
- `src/services/runtime-state/index.ts`
- `src/services/dashboard-query/index.ts`

### 実施内容
- **AGENTS配列の全14エージェントのname日本語化:**
  - Executive Director → 総合指揮官
  - Research Director → リサーチ部長
  - Trend Researcher → トレンド調査員
  - Competitive Analysis Director → 競合分析部長
  - Threads Competitor Researcher → Threads競合調査員
  - note Competitor Researcher → note競合調査員
  - Competitive Signal Analyst → エンゲージメント分析官
  - Threads Operations Director → Threads運用部長
  - Threads Post Generator → Threads投稿生成員
  - Threads Engagement Analyst → Threadsエンゲージメント調査員
  - Threads Reply Generator → Threads返信生成員
  - note Operations Director → note運用部長
  - note Article Generator → note記事生成員
  - note Engagement Analyst → noteエンゲージメント調査員
- **ダッシュボード表示名:** `command` 部署の表示名を `管理指揮` → `管理・指揮系統` に更新（他4部署は既に日本語）
- エージェントIDは英語のまま維持

### 結果
- テスト: 33ファイル 162テスト 全パス

---

## 改修4: 競合リサーチ分析部署の強化

### 変更ファイル
- `src/services/content-scheduler/index.ts`
- `src/domain/department/index.ts`
- `src/services/department-execution/index.ts`
- `src/services/runtime-state/index.ts`

### 実施内容
- **新ActionType追加:** `fetch_competitor_updates`（軽量な競合スナップショット差分チェック）
- **スケジュール条件変更:** `analyze_competitors` を168時間（7日）→ 24時間（1日）に短縮
- **新スケジュール追加:** `fetch_competitor_updates` を6時間間隔で生成（priority: low）
- **resolveDepartmentName更新:** `fetch_competitor_updates` → `competitive-analysis` に解決
- **executor拡充:** competitive-analysis executorが `fetch_competitor_updates` をサポート。最新スナップショットの経過時間を確認し、threads/note/command へ `competitor_update` 通知を送信
- **preferredWorkers追加:** `analyze_competitors: "engagement-analyst"`, `fetch_competitor_updates: "threads-competitor-researcher"`
- **エージェントactions更新:** `threads-competitor-researcher` と `competitive-analysis-director` に `fetch_competitor_updates` を追加

### 結果
- 競合分析部署が7日に1回 → 毎日フル分析 + 6時間ごとに差分チェック
- テスト: 33ファイル 162テスト 全パス

---

## 改修1: Executive LLMへのエラー情報注入 + 自律エラー解決

### 変更ファイル
- `src/services/executive/index.ts`
- `src/jobs/hourly-heartbeat.ts`
- `src/services/proposal-flow/index.ts`
- `src/services/engagement-analysis/index.ts`
- `tests/proposal-flow.test.ts`

### 実施内容

#### 1-A: Executiveプロンプトにエラー情報追加
- `ErrorContext` インターフェース追加（recentFailures, pendingReviewCount, pendingProposalCount, consecutiveFailures, pendingProposalSummaries）
- `buildExecutivePrompt()` に第3引数としてErrorContextを追加
- `buildErrorSection()` でエラー情報セクションをプロンプトに挿入
- `LlmExecutiveDecision` に `proposalDecisions` フィールド追加
- Executiveが「エラー対処」と「プロポーザル承認/却下/人間エスカレーション」を自律判断可能に

#### 1-B: Executive自律承認パス
- `createHierarchicalProposal()` のデフォルトを `currentStage: "executive_review"`, `currentApproverId: "executive-director"` に変更
- `escalateToHuman()` メソッドを ProposalFlowService に追加
- ハートビート Step 4.5: Executiveの `proposalDecisions` に基づき、承認/却下/人間エスカレーションを実行

#### 1-C: 承認済みプロポーザルの自動実行
- ハートビート Step 4.7: 直近24時間以内に承認されたプロポーザルを取得し、対応するactionTypeを実行キューに注入
- 実行済みフラグとして `reviewerNote` に `[auto-executed]` を付記

#### 1-D: LLMパース失敗時のフォールバック改善
- リプライ分類のJSON解析失敗時、低温度（0.1）で1回再試行
- 2回目も失敗 → `{ decision: "ignore", sentiment: "neutral" }` に変更（従来は `human_review`）

#### 1-E: human_review_items の自動再評価
- ハートビート Step 14: pending の human_review_items を最大5件取得
- LLMに再評価を依頼し、安全と判断されれば自動承認
- 判断不能な場合は pending のまま次サイクルへ

### 結果
- テスト: 33ファイル 162テスト 全パス（proposal-flowテストの期待値を修正: イベント数5→4）

---

## 最終結果サマリ

| 改修 | 変更ファイル数 | テスト | 状態 |
|------|------|------|------|
| 改修2: エージェント配置整理 | 1 | 全パス | 完了 |
| 改修3: 日本語化 | 2 | 全パス | 完了 |
| 改修4: 競合分析強化 | 4 | 全パス | 完了 |
| 改修1: 自律エラー解決 | 5 | 全パス | 完了 |

### 変更ファイル一覧
- `src/services/runtime-state/index.ts` — 改修2, 3, 4
- `src/services/dashboard-query/index.ts` — 改修3
- `src/services/content-scheduler/index.ts` — 改修4
- `src/domain/department/index.ts` — 改修4
- `src/services/department-execution/index.ts` — 改修4
- `src/services/executive/index.ts` — 改修1
- `src/jobs/hourly-heartbeat.ts` — 改修1
- `src/services/proposal-flow/index.ts` — 改修1
- `src/services/engagement-analysis/index.ts` — 改修1
- `tests/proposal-flow.test.ts` — 改修1

### 主要な改善効果
1. **Executiveがエラーを認識できるようになった** — プロンプトに失敗ジョブ・pending レビュー・プロポーザル情報が入る
2. **プロポーザルがExecutive自律承認に変わった** — `dashboard-human` 固定から `executive-director` 優先に。人間確認は必要時のみ
3. **承認済みプロポーザルが自動実行される** — 次ハートビートで拾って実行キューに注入
4. **LLMパース失敗が人間キューに溢れなくなった** — 再試行 + ignore フォールバック
5. **human_review_itemsが自動再評価される** — 毎ハートビートで最大5件をLLM再評価
6. **競合分析が7日→1日フル分析 + 6時間差分チェック** — 部署の活性度が大幅向上
7. **エージェント配置が仕様通り5部署14名** — 幽霊エージェント削除、部署間の所属矛盾を解消
8. **全エージェント名が日本語化** — ダッシュボード表示も統一
