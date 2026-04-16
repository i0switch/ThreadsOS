# ThreadsOS 最終監査レポート v3.1 照合

**監査日**: 2026-04-16
**監査責任者**: Claude (Opus 4.6 1M context)
**監査対象**: ThreadsOS リポジトリ全体 (src/ 87ファイル, tests/ 45ファイル, agents/ playbooks/ policies/)
**監査基準**: `00-design/01-ThreadsOS-final-spec-v3.1.md` + `30-final-audit/01-final-audit-prompt.md`

---

## release_decision

**`conditional_approve`** (Codex 監査確認済み 2026-04-16)

骨格 (5部署 / SQLite SSOT / Outbox / Job Lease / Canary→Promote / Operations Mode / Contract Compiler / Observation-First Dashboard) は仕様書通りに実装されており、収益最適化 OS としての基本構造は成立している。
ただし、(A) human_review pattern の構造的残骸 (`proposals` テーブル + `proposal-flow` service + `DRAFT_STATUSES` の `approved/rejected`)、(B) note セッション失効時に「手動 `npm run note:login`」を要請する明確な仕様違反、(C) rollback 閾値・価格 tier・予算上限などの dangerous hardcode 多数、(D) `ClaudeLlmClient` (Anthropic API 直接叩き) の残存、(E) executive parse-failure fallback の「全候補 approve」挙動 — この5点が残るため、本番リリース前に少なくとも **critical 5件・major 5件** の修正を要する。

**Codex 追加指摘 (2026-04-16 確認時)**:
- M-2 (executive parse failure fallback) は §2「迷ったら止める」§20「confidence 低→実行しない」明確違反のため critical に昇格 → C-5 として再分類
- memory compression / asset pruning (§7 1日/1週) ジョブの未実装を M-6 として追加
- `AUDIT_VERDICTS` (pass/revise/reject) と `AuditorAction` (pass/rewrite/skip/quarantine) の語彙不一致を m-6 として追加

---

## overall_summary

### 強み
- **5部署 + 横断 auditor** の概念分離が `agents/` および `services/department-execution` で完全に表現されている
- **Job Lease (lease_key UNIQUE) / Outbox (idempotency_key UNIQUE) / publication_events (external_fingerprint UNIQUE)** の3種の重複防止制約が DB 層に確実に入っている
- **`createRunnerRouter`** が claude/codex/copilot を tier × budget × health で自動切替する設計で、Phase 0 仕様 (LLM Runner 抽象層) を満たしている
- **`executive-experiment`** が thompson sampling + Laplace prior + 24h/72h 二段採点 + canary group 自動付与 + winningPatterns/losingPatterns 蓄積 — Phase 4 仕様を完全実装
- **`operations-mode`** が full_autonomy / threads_only / observe_only / safe_freeze の4状態遷移を deterministic に評価し、`tier-15m/1h/1d/1w` 全層がモード依存 skip を実装
- **`dashboard-observation`** が承認 UI を一切持たず、mode/bottleneck/runner health/session/outbox/anomalies/decision evidence/rollbacks/contracts/auditor を一元表示する観測 UI として完成
- **`contracts:compile`** が agents/playbooks/policies の必須 ID と frontmatter schema を起動前検査でブロック (Phase 5 仕様)
- **build / test / lint** (tsc / vitest / biome) が package.json で揃い、tests/ に45ファイル + integration テスト3件

### 主な不合格箇所の要約

| 重大度 | 項目 | 場所 |
|---|---|---|
| critical | note セッション失効時に手動再ログイン要請 | `src/services/auto-publisher/index.ts:902` |
| critical | `proposals` テーブル + proposal-flow による human_review pattern 残骸 | `src/db/schema.ts:862-910`, `src/services/proposal-flow/index.ts` |
| critical | `DRAFT_STATUSES` / `NOTE_DRAFT_STATUSES` が仕様書状態機械と不一致 (approved/rejected が残存) | `src/db/schema.ts:11-41` |
| critical | rollback 閾値が固定値でコードに焼き込み | `src/services/rollback/index.ts:58-61` |
| critical | executive LLM parse failure 時に「全候補 approve」fallback (Codex 指摘により M-2 から昇格) | `src/services/executive/index.ts:468-503` |
| major | `ClaudeLlmClient` (Anthropic API 直接叩き) が残存 | `src/adapters/llm/index.ts:70-233` |
| major | memory compression / asset pruning ジョブが未実装 (Codex 追加指摘) | `src/jobs/tier-1d.ts`, `src/jobs/tier-1w.ts` |
| major | auto-publisher の価格 tier / 文字数閾値 / CV 目標が hardcode | `src/services/auto-publisher/index.ts:81-83,121-127,135-207` |
| major | hourly-heartbeat の budget 初期値 (50000 tokens / 30 calls など) hardcode | `src/jobs/hourly-heartbeat.ts:464-486` |
| major | hourly-heartbeat が「最大3アクション」並列実行 → 「1 heartbeat = 1 bottleneck 改善」と矛盾 | `src/services/executive/index.ts:284`, `src/jobs/hourly-heartbeat.ts:801` |
| minor | `executive-experiment.CANDIDATE_LIBRARY` の hypothesis/guidance が hardcode (playbook に置くべき) | `src/services/executive-experiment/index.ts:104-196` |
| minor | `OUTBOX_QUARANTINE_THRESHOLD = 5` / `OUTBOX_RETRY_BACKOFF_MS = 60_000` hardcode | `src/db/repositories/runtime-ledger.ts:21-22` |
| minor | `policies/pricing.md` の `maxSingleStepPercent: 20` が auto-publisher で参照されていない | `policies/pricing.md`, `src/services/auto-publisher/index.ts` |
| minor | tests/review-approve.test.ts が残存 (削除された review CLI のテスト) | `tests/review-approve.test.ts` |
| minor | `tests/dashboard-query-cache.test.ts` 削除済みだが対応コードクリーンアップ不完全 | git status |
| minor | `AUDIT_VERDICTS` (pass/revise/reject) と `AuditorAction` (pass/rewrite/skip/quarantine) の語彙不一致 (Codex 追加指摘) | `src/db/schema.ts:18`, `src/services/auditor/index.ts:1` |

---

## critical_issues

### C-1. note セッション失効時に手動再ログインを要請

**ファイル**: `src/services/auto-publisher/index.ts:874-906`

**コード**:
```ts
const isSessionExpired =
  /NOTE_SESSION_EXPIRED|セッション|ログイン|storageState/i.test(errorMsg);
// ...
content: isSessionExpired
  ? `note.comセッション切れ。'npm run note:login'を手動実行して再ログインしてください。draftId=${draft.id}`
  : `note自動公開失敗: ${errorMsg.slice(0, 200)} (draftId=${draft.id})`,
```

**仕様書違反**:
- §2 絶対条件: 「運用中の note 手動再ログイン依存を仕様に持ち込まない」
- §21 note session の正式ルール: 「運用中に手動再ログインを要求しない」「自動復帰手段が事前実装されている場合のみ recovered へ戻す」「復帰できない間は Threads-only で継続する」

**期待される実装**:
- session 失効を検出したら `sessionHealth.state = "quarantined"` に設定し、operations-mode が自動で `threads_only` に降格
- ユーザーへの通知は「note 運用を一時停止し Threads のみに切替」のみ。手動操作の指示は禁止
- 自動復帰手段 (再認証フロー) を実装するか、復帰機能がない旨を operations-mode の理由文に明示するに留める

---

### C-2. `proposals` + `proposal-flow` による human_review pattern 残骸

**ファイル**:
- `src/db/schema.ts:862-910` (proposals テーブル定義: `currentStage`, `currentApproverId`, `reviewerNote`, `reviewedAt`)
- `src/services/proposal-flow/index.ts` (createHierarchicalProposal / approveProposal / rejectProposal)
- `src/jobs/hourly-heartbeat.ts:651-743` (Step 4.5 / Step 4.7 で proposalsの approve/reject/execute)

**仕様書違反**:
- §2 絶対条件: 「human_review 全廃」
- §13 部署 = JSON契約ワーカー: agents/auditor.md `forbidden: ["human_review", ...]` と整合しない実装
- §20 安全仕様: human_review の代替は `auto-execute / auto-rewrite / auto-skip / auto-quarantine` の4択であるべき

**現状**:
proposals テーブルは完全自動化されており (executive-director という AI agent が auto-approve/auto-reject)、形式上は human-out-of-the-loop 達成。しかし以下の構造的問題:

1. **state 名 (`leader_review` / `executive_review` / `approved` / `rejected`)** は仕様書「pass / rewrite / skip / quarantine」と異なる語彙
2. `currentApproverId: "executive-director"` という固定文字列で「承認者ID」を持つ設計 → 人間レビュー pattern の残骸
3. `safetyService.checkAutoApproval(action)` で false が返ったアクションが proposals に積まれ「Executive 自律承認待ち」状態 (`PENDING_REVIEW: ${action.type}`) になる → 「auto-skip」または「auto-quarantine」で即座に処理すべき
4. 仕様書状態機械 (drafted→audited→scheduled→published→measured→scored→archived) と無関係なフロー

**期待される実装**:
- proposals テーブルおよび proposal-flow service を削除
- `safetyService.checkAutoApproval` で false の場合は `auditor.normalizeAuditorAction({verdict: "reject"})` 経由で `skip` または `quarantine` に直行
- executive cycle の Step 4.5 / Step 4.7 のロジックを削除、Step 4 直後にアクション実行へ進む

---

### C-3. `DRAFT_STATUSES` / `NOTE_DRAFT_STATUSES` が仕様書状態機械と不一致

**ファイル**: `src/db/schema.ts:11-41`

**コード**:
```ts
export const DRAFT_STATUSES = ["draft", "audited", "approved", "published", "rejected"] as const;
export const NOTE_DRAFT_STATUSES = ["draft", "audited", "approved", "published", "rejected"] as const;
export const NOTE_IDEA_STATUSES = ["idea", "drafting", "drafted", "audited", "ready", "published"] as const;
export const REVIEW_STATUSES = ["pending", "approved", "rejected"] as const;
```

**仕様書違反 (§15 状態機械)**:
- 仕様書: `drafted → audited → scheduled → published → measured → scored → archived`
- コード: `draft → audited → approved → published → rejected` (scheduled / measured / scored / archived が存在しない)

**影響**:
- `measured` / `scored` 状態がないため、24h/72h採点済みのアセットを区別できない
- `archived` 状態がないため、loser 整理 (§7 1週ごと) で論理削除できない
- `scheduled` 状態がないため、`contentSlots.status` と `threadPostDrafts.status` が二重管理 (現在 contentSlots.status = "pending"/"reserved" で代替)
- `approved` / `rejected` は human_review patternの語彙

**期待される実装**:
- `DRAFT_STATUSES = ["drafted", "audited", "scheduled", "published", "measured", "scored", "archived"]` に変更
- `NOTE_DRAFT_STATUSES` 同様
- `REVIEW_STATUSES` を `AUDITOR_ACTIONS = ["pass", "rewrite", "skip", "quarantine"]` に置換 (`src/services/auditor/index.ts` と統一)
- 既存データの migration を `src/db/migrations/` に追加

---

### C-4. rollback 閾値が固定値でコードに焼き込み

**ファイル**: `src/services/rollback/index.ts:57-61`

**コード**:
```ts
const COMPLAINT_WINDOW_MS = 24 * 60 * 60 * 1000;
const CTR_DROP_THRESHOLD = 0.7;
const PURCHASE_RATE_DROP_THRESHOLD = 0.6;
const REVENUE_PER_VIEW_DROP_THRESHOLD = 0.6;
const COMPLAINT_SPIKE_THRESHOLD = 3;
```

**仕様書違反**:
- §10 収益評価の考え方「固定係数の RevenueScore を仕様に焼き込まない」「代理指標の重みは `policies/monetization.md` に置く」
- §20 rollback 条件例: CTR 急落 / purchase rate 急落 / complaint signal 急増 / 価格変更後の CV 低下 — これらの**閾値は policies に置くべき**
- §13 通信原則: ポリシーは契約書として policies/ にあるべき
- 監査プロンプト深掘り: 「rollback 条件が deterministic に評価されるか」「RevenueScore を固定係数でコードに焼いていないか」

**現状**:
- `policies/monetization.md` は閾値を持たず ("proxyWeightReviewDays: 7" のみ)
- `policies/pricing.md` の `maxSingleStepPercent: 20` も rollback で参照されていない
- `playbooks/rollback-policy.md` の `steps: ["compare_to_baseline", "check_drop_thresholds", ...]` で「閾値を超えたら」と書かれているが閾値の出どころ未定義

**期待される実装**:
- `policies/monetization.md` または新規 `policies/rollback-thresholds.md` の `thresholds` フィールドに `ctrDropRatio`, `purchaseRateDropRatio`, `revenuePerViewDropRatio`, `complaintSpikeWindowHours`, `complaintSpikeCount` を追加
- `getCompiledContractStore()` 経由で取得し `createRollbackService()` で参照
- ハードコード定数を撤去、設定可能化

---

### C-5. executive LLM parse failure 時に「全候補 approve」fallback (Codex 指摘により昇格)

**ファイル**: `src/services/executive/index.ts:468-503` (`buildFallbackPlan`)

**コード**:
```ts
private buildFallbackPlan(candidateActions: ScheduledAction[]): HeartbeatCyclePlan {
  // ...
  const limited = candidateActions.slice(0, 3);
  const fallbackReason = "LLM response parse failed; fallback: up to 3 candidate actions approved";
  // ...
  return { /* ... */ approvedActions: limited, /* ... */ };
}
```

**仕様書違反**:
- §2 絶対条件: 「迷ったら人間に上げず、止める / 安全化する」
- §6 deterministic と LLM の責務分離: confidence 閾値判定は deterministic 側
- §20 安全仕様 追加安全層: 「confidence低 → 実行しない」

**現状**:
LLM が JSON parse 失敗 (executive 判断不能) のときに、フェイルセーフとしてベスト3アクションを承認している。これは「迷ったら止める」原則と完全に逆。LLM 応答が壊れた状態でアクションを実行することは安全性の重大欠陥。

**Codex 指摘**:
> 「parse failure 時に candidateActions.slice(0,3) を承認する挙動 (executive/index.ts:472) はフェイルセーフではない。何も実行しない (approvedActions: []) が正解。」

**期待される実装**:
- parse failure 時は `approvedActions: []` (= 何も実行しない) を返す
- `objective: "directive_assimilation"` (人間入力処理のみ) または `funnelStage: "bootstrap"` で `notify` のみ承認するなど、最小限の安全アクション
- 連続 N 回 parse 失敗 → `safe_freeze` モードへ昇格 (anomaly event 記録)
- 詳細実装: env: `EXECUTIVE_PARSE_FAILURE_THRESHOLD` (default 3) 連続失敗で `anomalyEvents` に `severity: "high"` 記録 → `operations-mode.evaluateMode()` の `recentHighSeverityAnomalies >= 3` 既存トリガーで safe_freeze 昇格

---

## major_issues

### M-1. `ClaudeLlmClient` (Anthropic API 直接叩き) の残存

**ファイル**: `src/adapters/llm/index.ts:70-233`, `src/config/env.ts:22-26`

**問題**:
- `ClaudeLlmClient` クラスが `https://api.anthropic.com/v1/messages` に直接 fetch
- `LLM_MODE=direct` のときに使われる
- env.ts: `LLM_MODE: z.enum(["heartbeat", "direct", "dry-run"])`、`LLM_API_KEY` を要求
- `validateProductionEnv` で `LLM_MODE === "direct" && !LLM_API_KEY` のときのみ throw

**仕様書違反**:
- §2 絶対条件: 「LLM はサブスクCLI経由のみ」
- §11 LLM Runner 抽象層: claude/codex/copilot CLI のみが想定されている
- CLAUDE.md (project): 「ローカル運用時は LLM_MODE=heartbeat」「Claude Code 自身がLLMとして処理する (Anthropic API直接呼び出しは不要)」

**期待される実装**:
- `ClaudeLlmClient` クラスとそのコードパスを完全削除
- env.ts の `LLM_MODE` enum から `"direct"` を削除
- `LLM_API_KEY` / `LLM_DIRECT_MODEL_*` env を削除
- `createLlmClient()` を `HeartbeatLlmClient` または `DryRunLlmClient` のみに

---

### M-2. (旧 critical 候補、C-5 へ移動)

→ Codex 監査確認により C-5 として critical に昇格。本セクションは欠番。

---

### M-3. auto-publisher の価格 tier / 文字数閾値 / CV 目標が hardcode

**ファイル**: `src/services/auto-publisher/index.ts:81-207`

**コード**:
```ts
const DEFAULT_TARGET_CONVERSION_RATE = 0.025;
const PRICE_TIERS = [490, 690, 980, 1480, 1980] as const;
// ...
if (charCount < 3000)  { /* free */ }
else if (charCount < 5000) priceYen = 690;
else if (charCount < 8000) priceYen = 980;
else priceYen = 1480;
// 既存記事のCV/売上判定:
if (history.averageConversionRate >= 0.04 || history.averagePurchases >= 3 || history.averageRevenueYen >= 3000) { ... }
```

**仕様書違反**:
- §10 「固定係数の RevenueScore を仕様に焼き込まない」
- §13 部署契約 forbidden: 「曖昧CTA」「規約違反」「誇大表現」 → 価格設定もこの粒度で policies に管理されるべき
- §20 rollback 条件 / §7 1週ごと「価格最適化」が固定値だと最適化ループに入らない

**期待される実装**:
- `policies/pricing.md` の `thresholds` を拡張: `priceTiers: [490, 690, 980, 1480, 1980]`, `freeThresholdChars: 3000`, `targetConversionRate: 0.025`, `priceUpThresholds: { conversionRate: 0.04, purchases: 3, revenueYen: 3000 }`
- contracts compiler で読み込んで `determineNotePrice` に注入
- 1週ごと の `policy drift review` で重み再調整可能に

---

### M-4. hourly-heartbeat の budget 初期値が hardcode

**ファイル**: `src/jobs/hourly-heartbeat.ts:464-486`

**コード**:
```ts
budgetService.initBudget("global", "heartbeat", heartbeatPeriodKey, 50000, 30);
const departments = ["command", "external-research", "competitive-analysis", "threads", "note"] as const;
for (const dept of departments) {
  budgetService.initBudget(dept, "heartbeat", heartbeatPeriodKey, 10000, 10);
}
```

**仕様書違反**:
- §13 「`llm_budget`」が agents/<dept>.md frontmatter で個別管理されるべき
- §18 Budget Governor 原則: 「固定メッセージ数を仕様書に書かない」「実運用の可否は DB と policy で制御する」

**期待される実装**:
- `getCompiledContractStore().agents` から各 agent の `llmBudget` を取得し departments の budget initBudget に渡す
- global は `policies/rate-budget.md` の `thresholds.tokensPerHeartbeat` / `callsPerHeartbeat` から取得
- ハードコード定数を撤去

---

### M-6. memory compression / asset pruning ジョブが未実装 (Codex 追加指摘)

**ファイル**: `src/jobs/tier-1d.ts`, `src/jobs/tier-1w.ts`

**仕様書違反 (§7 スケジューリング仕様)**:
- 1日ごと: `note生成 / 公開`, `winning pattern 資産化`, `翌日配分更新`, **`memory compression`**, **`asset pruning`**
- 1週ごと: `価格最適化`, `テーマ配分更新`, **`loser整理`**, **`strategy refresh`**, **`policy drift review`**

**現状**:
- `tier-1d.ts`: `daily-topic-research` + `daily-threads-plan` + `nightly-note-pipeline` のみ
- `tier-1w.ts`: `weekly-retro` のみ
- `memory_summaries` テーブルへの圧縮ジョブが存在しない → 長期運用で肥大化リスク
- `losingPatterns` 整理ジョブが存在しない
- `policies/*` の drift review ジョブが存在しない

**期待される実装**:
1. 新規ジョブ `src/jobs/daily-memory-compression.ts` を追加 (古い `working_memory` / `event_log` を `department_summary` に圧縮)
2. 新規ジョブ `src/jobs/daily-asset-pruning.ts` を追加 (`scored` → `archived` 状態遷移、`losingPatterns` の論理削除)
3. 新規ジョブ `src/jobs/weekly-strategy-refresh.ts` を追加 (`strategyHistory` の集約、`policies/*` の drift review トリガー)
4. `tier-1d.ts` / `tier-1w.ts` から `runInternalJob` で呼び出し
5. テスト追加 (missing_tests #8)

---

### M-5. hourly-heartbeat が「最大3アクション」並列実行

**ファイル**:
- `src/services/executive/index.ts:284` (executive prompt: "1回のハートビートで最大3アクションまで")
- `src/jobs/hourly-heartbeat.ts:801` (`for (const action of cycle.approvedActions)` で複数アクション順次実行)
- `src/services/executive/index.ts:472` (fallback: `candidateActions.slice(0, 3)`)

**仕様書違反**:
- §7 固定原則: 「1時間 heartbeat = 1ボトルネック改善」「毎回全部署フル稼働は禁止」
- §8 1時間 heartbeat 固定フロー: ステップ3「最弱段を**1つだけ**選定」、ステップ4「LLM **1回**で改善アクション生成」

**現状**:
executive 判断は1ボトルネックを選ぶ (executive-experiment.diagnose は1つ) が、実行段階では `approvedActions` (最大3) を全て実行している。複数アクション = 複数の改善対象 = 仕様違反。

**期待される実装**:
- executive prompt を「1ハートビート = 1アクション」に変更
- `cycle.approvedActions` を `cycle.approvedAction` (single) に変更
- executive-experiment は1bottleneckを選ぶので整合する
- 残りのアクションは次の heartbeat に持ち越し or `optimize_schedule` でまとめて遅延

---

## minor_issues

### m-1. `executive-experiment.CANDIDATE_LIBRARY` が hardcode

**ファイル**: `src/services/executive-experiment/index.ts:104-196`

bottleneck (Reach/Click/Read/Buy) ごとに3つずつ patternKey + hypothesis + guidance + angleId/ctaId が 12個ハードコード。これは `playbooks/experiment-selection.md` に置かれるべき。

**期待**: playbook の `steps` または別 frontmatter フィールドに JSON で置き、contracts:compile で読み込む。

---

### m-2. `OUTBOX_QUARANTINE_THRESHOLD = 5` / `OUTBOX_RETRY_BACKOFF_MS = 60_000` hardcode

**ファイル**: `src/db/repositories/runtime-ledger.ts:21-22`

`policies/rate-budget.md` の thresholds で管理すべき。

---

### m-3. `policies/pricing.md` の `maxSingleStepPercent: 20` が未参照

**ファイル**: `policies/pricing.md`, `src/services/auto-publisher/index.ts`

policy 定義が宣言されているが auto-publisher の `determineNotePrice` で使われていない (急変更防止ガード未実装)。

---

### m-4. tests/review-approve.test.ts 残存

**ファイル**: `tests/review-approve.test.ts`

`src/cli/review-approve.ts` は git status で削除されているが対応テストが残存。Test runner で fail or skip 状態。

**期待**: `tests/review-approve.test.ts` を削除し、proposal-flow に対応するテスト (`tests/proposal-flow.test.ts`) で代替確認。

---

### m-5. `dashboard-query` 削除に伴う routes 整合性確認

**ファイル**: `src/services/dashboard-query/` (削除済み), `src/dashboard/routes.ts`

git status で `src/services/dashboard-query/index.ts`, `request-cache.ts` が削除されているが、`src/dashboard/routes.ts` が dashboard-observation に完全移行しているか要再確認。

---

### m-6. `AUDIT_VERDICTS` と `AuditorAction` の語彙不一致 (Codex 追加指摘)

**ファイル**: `src/db/schema.ts:18`, `src/services/auditor/index.ts:1`

**コード**:
```ts
// schema.ts
export const AUDIT_VERDICTS = ["pass", "revise", "reject"] as const;

// auditor/index.ts
export type AuditorAction = "pass" | "rewrite" | "skip" | "quarantine";
```

**問題**:
- DB に保存される verdict (`pass / revise / reject`) と、auditor が出力する action (`pass / rewrite / skip / quarantine`) が不一致
- `normalizeAuditorAction` で `revise → rewrite`, `reject → skip` と変換しているが、`quarantine` は verdict には存在せず severity / score から推論
- 仕様書 §13 の auditor 契約 (`pass / rewrite / skip / quarantine`) が DB に直接保存されていない

**期待される実装**:
- `AUDIT_VERDICTS` を `["pass", "rewrite", "skip", "quarantine"]` に統一
- `auditor.ts` の `normalizeAuditorAction` を撤去 (DB に直接 4択を保存)
- migration で既存データを変換 (`revise → rewrite`, `reject → skip`)

---

## strengths

1. **Phase 0 (LLM Runner abstraction)**: claude/codex/copilot CLI を `LlmRunner` interface で完全抽象化、`createRunnerRouter` が tier × budget × health で自動切替
2. **Phase 1 (Job Lease / Outbox / decision_evidence)**: 3つの UNIQUE 制約と claim/complete/fail フローで exactly-once-ish を実現
3. **Phase 2 (note session guard)**: `sessionHealth` テーブル + `operations-mode` で session 状態を deterministic に追跡 (再ログイン要請を除く)
4. **Phase 3 (multi-tier scheduling + degrade modes)**: tier-15m / 1h / 1d / 1w 全層が `operations-mode.reconcileMode()` でモード依存 skip
5. **Phase 4 (executive experiment + canary)**: thompson sampling + Laplace prior + 24h/72h 二段採点 + early reject + winningPatterns/losingPatterns 蓄積
6. **Phase 5 (contracts compiler + dashboard)**: agents/playbooks/policies の必須 ID と frontmatter schema を起動前検査でブロック、dashboard-observation は承認 UI を持たない観測 UI
7. **部署間通信が `departmentNotifications` テーブル経由のみ** で自由会話禁止を達成
8. **executive judgment が LLM 駆動かつ DB 履歴 (`strategyHistory`) で一貫性維持**
9. **rollback service が deterministic 評価 + decision_evidence 記録 + 同一トリガー二重実行防止**
10. **6段ファネル (`funnelSnapshots`)** が threadsMetrics / noteMetrics / revenueEvents / experiments 全テーブルに `campaign_id / angle_id / cta_id / canary_group / price_variant_id` の追加カラムで紐付けされている

---

## missing_tests

1. **手動再ログイン回避テスト**: note session 失効時に `outbound_notifications` に手動操作要請が記録されないこと、`sessionHealth.state = "quarantined"` に遷移すること、operations-mode が `threads_only` に降格すること
2. **proposals 削除後の auto-skip テスト**: `safetyService.checkAutoApproval` が false の action が `audit.verdict = "skip"` または `"quarantine"` で即座に処理されること
3. **状態機械 transition テスト**: `drafted → audited → scheduled → published → measured → scored → archived` の各遷移が deterministic で実装されていること
4. **rollback policy threshold 注入テスト**: `policies/monetization.md` の thresholds 変更が rollback 判定に反映されること
5. **executive parse-failure safe-stop テスト**: LLM parse 失敗時に `approvedActions = []` で何も実行しないこと、連続 N 回失敗で safe_freeze 昇格すること
6. **price tier policy injection テスト**: `policies/pricing.md` の `priceTiers` 変更が auto-publisher で反映されること
7. **1 heartbeat = 1 action テスト**: 複数候補があっても1つだけ実行されること、残りは次回 heartbeat で考慮されること
8. **memory compression / asset pruning ジョブの存在**: 仕様書 §7 「1日ごと: memory compression / asset pruning」「1週ごと: loser整理 / strategy refresh / policy drift review」 — `tier-1d.ts` / `tier-1w.ts` には記述がない (現状: weekly-retro のみ)
9. **CLI `note:login` を運用フローから呼ばないテスト**: PM2 / heartbeat-loop が `note:login` を起動しないこと、初期 setup 専用であること

---

## pre_release_fix_plan

### 必須 (リリース前 critical 解消)

#### Step 1: note session 自動降格 (C-1)
1. `src/services/auto-publisher/index.ts:874-906` の手動再ログイン要請メッセージを撤去
2. session expired 検出時に `sessionHealth.state = "quarantined"` を `createRuntimeLedgerRepository().updateSessionHealth()` 経由で書き込む (新規メソッド追加)
3. `outbound_notifications` には「note運用を一時停止し Threads-only モードに切替えました」とのみ記録
4. テスト追加 (missing_tests #1)

#### Step 2: proposals テーブル / proposal-flow service の削除 (C-2)
1. `src/services/proposal-flow/index.ts` を削除
2. `src/db/schema.ts` から `proposals` / `proposalEvents` / `PROPOSAL_*` 定数を削除
3. `src/db/migrations/` に drop migration を追加
4. `src/jobs/hourly-heartbeat.ts:651-743` (Step 4.5 / Step 4.7) を削除
5. `safetyService.checkAutoApproval` が false の action は `auditor.normalizeAuditorAction({verdict: "reject"})` 経由で即 skip
6. `tests/proposal-flow.test.ts` を削除、対応する `tests/auditor-skip.test.ts` を追加
7. `tests/review-approve.test.ts` も削除

#### Step 3: 状態機械の語彙統一 (C-3)
1. `src/db/schema.ts:11-41` で
   - `DRAFT_STATUSES = ["drafted", "audited", "scheduled", "published", "measured", "scored", "archived"]`
   - `NOTE_DRAFT_STATUSES` 同様
   - `REVIEW_STATUSES` を削除し `AUDITOR_ACTIONS = ["pass", "rewrite", "skip", "quarantine"]` を export
2. `src/db/migrations/` に enum 変更 + 既存データ migration を追加
3. `auto-publisher` の `status === "audited"` 判定をそのまま、`"published"` 後に metrics-sync が `"measured"` → `"scored"` に遷移するロジックを `src/services/note-engagement-analysis` に追加
4. 1d tier で `archived` 遷移ジョブ追加

#### Step 4: rollback 閾値の policy 化 (C-4)
1. `policies/monetization.md` または新規 `policies/rollback-thresholds.md` を作成し以下を追加:
   ```yaml
   thresholds:
     ctrDropRatio: 0.7
     purchaseRateDropRatio: 0.6
     revenuePerViewDropRatio: 0.6
     complaintSpikeCount: 3
     complaintWindowHours: 24
   ```
2. `src/services/rollback/index.ts` で `getCompiledContractStore().policies.find(p => p.id === "rollback-thresholds")` 経由で取得
3. ハードコード定数を撤去
4. テスト追加 (missing_tests #4)

#### Step 5: executive parse-failure safe-stop (C-5、旧 M-2 から昇格)
1. `src/services/executive/index.ts:468-503` の `buildFallbackPlan` を変更:
   - `approvedActions: []` (空配列) を返す
   - `llmReasoning: "LLM parse failed; safe-stop until next heartbeat"` を記録
2. env: `EXECUTIVE_PARSE_FAILURE_THRESHOLD` (default 3) を追加
3. parse failure ごとに `anomalyEvents` に `{category: "executive_parse_failure", severity: "high", message: ...}` を記録
4. 連続 N 回失敗で operations-mode の `recentHighSeverityAnomalies >= 3` トリガーが既存ロジックで safe_freeze 昇格
5. テスト追加 (missing_tests #5)

### 推奨 (リリース前 major 解消)

#### Step 6: ClaudeLlmClient 削除 (M-1)
1. `src/adapters/llm/index.ts` の `ClaudeLlmClient` クラスを削除
2. `src/config/env.ts` の `LLM_MODE` enum から `"direct"` 削除、`LLM_API_KEY` / `LLM_DIRECT_MODEL_*` 削除
3. `createLlmClient()` を `HeartbeatLlmClient` / `DryRunLlmClient` のみに
4. `tests/llm-direct.test.ts` (もしあれば) を削除
5. `.env.example` 更新

#### Step 7: 価格 tier の policy 化 (M-3)
1. `policies/pricing.md` の thresholds を拡張 (上記コード参照)
2. `src/services/auto-publisher/index.ts` の `PRICE_TIERS`, `DEFAULT_TARGET_CONVERSION_RATE`, char count 閾値, CV/売上判定閾値を全て contracts:compile 経由で取得
3. `maxSingleStepPercent: 20` を活用し前回価格との変動率ガードを実装

#### Step 8: budget の policy / agent frontmatter 経由化 (M-4)
1. `agents/<dept>.md` の `llmBudget` を実際の token / call 数に書き換え
2. `src/jobs/hourly-heartbeat.ts:464-486` の hardcode 値を `getCompiledContractStore().agents[i].llmBudget` から取得
3. global は `policies/rate-budget.md` の `thresholds.tokensPerHeartbeat` / `callsPerHeartbeat` 追加して取得

#### Step 9: 1 heartbeat = 1 action 化 (M-5)
1. `src/services/executive/index.ts` の prompt を「1ハートビート = 1アクション」に変更
2. `HeartbeatCyclePlan.approvedActions` を `approvedAction: ScheduledAction | null` に
3. `src/jobs/hourly-heartbeat.ts:801` のループを撤去 (1アクションだけ実行)
4. `tests/integration/heartbeat-flow.test.ts` で 1 action しか実行されないことを assert

#### Step 10: memory compression / asset pruning ジョブ実装 (M-6、Codex 追加指摘)
1. 新規 `src/jobs/daily-memory-compression.ts` を追加 (古い `working_memory` / `event_log` を `department_summary` に圧縮)
2. 新規 `src/jobs/daily-asset-pruning.ts` を追加 (`scored` → `archived` 状態遷移、`losingPatterns` の論理削除)
3. 新規 `src/jobs/weekly-strategy-refresh.ts` を追加 (`strategyHistory` の集約、`policies/*` の drift review トリガー)
4. `tier-1d.ts` / `tier-1w.ts` から `runInternalJob` で呼び出し
5. テスト追加 (missing_tests #8)

### 推奨 (minor)

#### Step 11: minor修正
- m-1: `playbooks/experiment-selection.md` に CANDIDATE_LIBRARY を移動
- m-2: `policies/rate-budget.md` の thresholds に outbox 設定追加
- m-3: pricing.md `maxSingleStepPercent` を auto-publisher で参照
- m-4: `tests/review-approve.test.ts` 削除
- m-5: `src/dashboard/routes.ts` の dashboard-query 残骸チェックと整合確認
- m-6: `AUDIT_VERDICTS` を `["pass", "rewrite", "skip", "quarantine"]` に統一、normalizeAuditorAction 撤去、migration 追加 (Codex 追加指摘)

---

## post_release_watch_items

リリース後にダッシュボード / decision_evidence / anomaly_events を監視する項目:

1. **operations-mode の遷移頻度**: `safe_freeze` / `observe_only` への意図しない降格が頻発していないか
2. **note session 自動降格の動作**: session 失効 → `threads_only` → 復帰 (もし自動復帰実装後) のサイクルが正常か
3. **rollback の発火頻度と精度**: 閾値が適切か、誤検知 / 取りこぼしの統計
4. **executive parse failure 率**: LLM 出力安定性、parse failure → safe-stop 昇格頻度
5. **canary → promote/reject 比率**: experiment engine の探索 / 活用バランス、initial 2週間 (探索強め) を超えた後の割合
6. **runner health の degraded/tripped 持続時間**: claude/codex/copilot のうち1つが恒常的に tripped していないか
7. **outbox quarantined 数**: 5回失敗で quarantine になる項目の蓄積、清掃ジョブの必要性
8. **budget 超過頻度**: hourly / daily / 5h / emergency の各 scope で超過がどれくらい発生するか
9. **content_slots の status 滞留**: `reserved` 状態が長時間残るスロット (= claim したが publish 完了しない)
10. **memory_summaries の蓄積**: 1d ジョブで「memory compression」「asset pruning」が未実装の影響でテーブルが肥大化していないか

---

## 監査チェックリスト14項目評価表

| # | 項目 | 判定 | 備考 |
|---|---|---|---|
| 1 | 5部署構造 + 横断監査レイヤー表現の揺れ | △ | コードでは "command", "external-research", "competitive-analysis" と仕様書語彙が異なる |
| 2 | Scheduler が直接 CLI LLM を叩いていない | ✅ | runner-router 経由 |
| 3 | LLM runner abstraction の全体使用 | △ | ClaudeLlmClient (direct API) 残存 |
| 4 | SQLite が SSOT | ✅ | 全状態が schema.ts 経由 |
| 5 | 6段ファネルが収益判定の中心 | ✅ | funnelSnapshots に impressions→revenue 全段 |
| 6 | 1時間 heartbeat = 1 bottleneck 改善 | ❌ | 最大3アクション並列実行 |
| 7 | human_review 経路が残っていない | ❌ | proposals + proposal-flow + DRAFT_STATUSES.approved/rejected |
| 8 | Job Lease / Outbox / idempotency | ✅ | 3つの UNIQUE 制約完備 |
| 9 | note session guard / Threads-only / Observe-only / Safe Freeze | ❌ | 手動再ログイン要請残存 |
| 10 | rollback 条件が deterministic | △ | deterministic だが閾値が hardcode |
| 11 | canary → measure → promote/reject | ✅ | experiment engine 完備 |
| 12 | dashboard が observation-first | ✅ | 承認 UI なし |
| 13 | dangerous hardcode | ❌ | rollback 閾値 / 価格 tier / budget 多数 |
| 14 | build / test / lint / smoke check | ✅ | tsc / vitest / biome 揃う |

## 深掘り論点評価

| 論点 | 判定 | 備考 |
|---|---|---|
| 設計書の思想と逆行する実装 | ❌ | ClaudeLlmClient / proposals / DRAFT_STATUSES |
| エージェント間自由会話の混入 | ✅ | departmentNotifications 経由のみ |
| DB を通さない状態管理 | ✅ | heartbeat-context 一時的のみ |
| metrics 欠損時の強引な最適化 | △ | executive parse failed → 全候補approve fallback |
| budget governor / circuit breaker の名ばかり実装 | ✅ | 4 scope budget + circuit status 評価 実装済み |
| UNIQUE 制約だけでなく実際に重複投稿を避けられるフロー | ✅ | publication_events.external_fingerprint UNIQUE + slot reserved 排他 |
| RevenueScore を固定係数で焼いていないか | ❌ | rollback / pricing / budget 全て hardcode |

---

## 監査責任者ログ

監査の正本: `00-design/01-ThreadsOS-final-spec-v3.1.md` (801行)
監査範囲: `src/` 全87ファイル + `tests/` 45ファイル + `agents/` 6ファイル + `playbooks/` 8ファイル + `policies/` 6ファイル + `package.json` + `ecosystem.config.cjs`
監査手法: 仕様書の14個必須確認項目 + 7個深掘り論点を、コード読込みと照合
判定方針: critical = リリース不可欠陥、major = リリース推奨外、minor = リリース後改善可

次のステップ:
1. 本レポートを Codex に確認依頼 (合格なら修正実施へ)
2. Codex の追加観点 / 重大度修正を反映
3. critical 4件 + major 5件の修正実装
4. 修正後 Codex に再報告 → 合格まで反復
