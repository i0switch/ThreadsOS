# ハートビート トークン削減修正案 (v3 / 再監査反映・実コード検証済)

- 作成日: 2026-04-12
- 改訂: 2026-04-13 (再監査の事実確認を実コードで全件検証済)
- 対象: ThreadsOS ハートビートループ

---

## v3 検証済みの事実

### 🚨 計画書v2の前提崩壊ポイント

| 項目 | 実コード | 結論 |
|---|---|---|
| **Prompt caching** | `src/adapters/llm/index.ts:256-262` — `HeartbeatLlmClient.callClaudeCli` は `spawnSync("claude", ["--print",...])` で**コール毎に新プロセス起動・セッション継承なし**。`src/adapters/llm/index.ts:73-81` の `ClaudeLlmClient` も `cache_control` ヘッダ未設定 | cache機構非依存の設計に書き換え必須 |
| **タイムアウト** | `src/adapters/llm/index.ts:181` — `CLAUDE_TIMEOUT_MS = 8 * 60 * 1000` (8分/コール) | コール数削減がトークン削減と同等に重要 |
| **リビジョン上限** | `src/services/orchestration/index.ts:35-36` — `MAX_THREAD_REVISION_ATTEMPTS = 3`, `MAX_NOTE_REVISION_ATTEMPTS = 3` | 2行変更で -15% の可能性 |
| **Thread監査ループの上限コール数** | `src/services/orchestration/index.ts:122-148` — `settleThreadDraft` は毎リビジョンで `regenerateDraft + auditDraft` の2コール。3トピック × 5draft × (1+2×3) = **最大 105コール** | v1,v2の「22コール」は楽観値。要実測 |
| **classifyReply DB照会** | `src/services/engagement-analysis/index.ts:685-689` — `strategyRow` を返信毎にループ内で `db.select().from(strategyStates)` | 20返信なら20回DB照会。メモ化対象 |
| **post-generation.regenerateDraft** | `src/services/post-generation/index.ts:193-207` — `existing.body + profileSection + feedback` を毎回再送信（titleは送信していない） | Note側と同じく差分化価値あり |

### ✅ v2で正しく特定できていた箇所

- `src/services/executive/index.ts:223-228, 237-246, 311-340` — Executive過大プロンプト
- `src/services/engagement-analysis/index.ts:709-732,741,750` — 返信分類の重複コンテキスト
- `src/services/note-generation/index.ts:217, 260` — 競合スナップショット重複取得
- `src/services/note-generation/index.ts:349-407` — Note regenerateDraft
- `src/services/research/index.ts:341-343` — 競合スナップショット20件巨大プロンプト
- `src/services/orchestration/index.ts:514-553` — improvementInsights DB照会

---

## 現状サマリ (v3)

| 項目 | 値 |
|------|-----|
| 1ハートビート当たり消費 | **実測必須** (現推定: 150k〜300k。上限は不透明) |
| 最大LLMコール数 | **45〜60 → 最大 約140** (リビジョンループ全展開時) |
| 主要因 | リビジョンループ / 冗長プロンプト / 重複コンテキスト / DB照会ループ |

---

## 修正案 (優先度順・v3改訂版)

### P0-0 【最優先】: トークン計測ログ追加

- **対象**: `src/adapters/llm/index.ts` (callClaudeCli + ClaudeLlmClient)、`src/jobs/hourly-heartbeat.ts`
- **問題**: 現状、実ハートビートのトークン使用量を計測する仕組みがない。効果検証の前提が成立しない
- **修正方針**:
  1. `ClaudeLlmClient`: APIレスポンスの `usage.input_tokens`, `usage.output_tokens` を捕捉
  2. `HeartbeatLlmClient`: `claude --output-format text` → `claude --output-format json` に切り替えてトークン数を取得、可能ならstderrから使用量情報を拾う（CLIの仕様要確認）
  3. ハートビート終了時に `{heartbeatId, callSite, promptTokens, completionTokens}` を `tmp/token-usage/yyyy-mm-dd.jsonl` へ追記
- **期待効果**: 計測基盤。直接削減なし。**これが入るまで他修正はマージ不可**

### P0-3 【新規・最大コスパ】: リビジョン上限引き下げ

- **対象**: `src/services/orchestration/index.ts:35-36`
- **変更内容**: `MAX_THREAD_REVISION_ATTEMPTS = 3` → `2`、`MAX_NOTE_REVISION_ATTEMPTS = 3` → `2`
- **理由**:
  - Thread: 3トピック × 5draft × (1+2×3) = 最大105コール → (1+2×2) = **最大75コール** (-28%)
  - Note: 3draft × (1+2×3) = 21コール → (1+2×2) = **15コール** (-28%)
- **期待効果**: **-15〜20% 全体** (他修正と独立に効く)
- **リスク**: 品質劣化すれば `3` に戻すだけ。2行変更でロールバック容易

### P0-1: Executive プロンプト要約化

- **対象**: `src/services/executive/index.ts:218-340`
- **問題**:
  - 行223-228: 部署レポート全件を `JSON.stringify` で丸ごと埋め込み
  - 行237-246: 戦略履歴5件を全文埋め込み
  - 行311-340: エラー情報も全件埋め込み
- **修正方針**:
  1. 部署レポートは既存の `summary / metrics / recommendation` を使い `{ dept, headline, keyMetrics[3], status }` に圧縮
  2. 戦略履歴は最新3件、各400文字まで
  3. エラーは `count + 代表メッセージ1件`
- **期待効果**: 1コール 5,000→2,000 トークン (1コール分のため全体寄与 -1〜2%)

### P0-2 (改訂): 返信分類バッチ化 (cache非依存設計)

- **対象**: `src/services/engagement-analysis/index.ts:685-732, 741, 750`
- **v3改訂ポイント**:
  - v2の「prompt cacheで重複削減」は前提崩壊 (spawnSyncで毎回新プロセス、direct APIもcache_control未設定)
  - **バッチ化による物理的な重複削減**に設計変更
- **修正方針**:
  1. `classifyReply` を単発処理から **5件バッチ** に変更 (JSON配列で結果回収)
  2. `strategyRow` の取得をループ外に巻き上げ (P2-2メモ化と重複するが優先度高いのでここで実施)
  3. `replyPolicyContext + toneContext` はバッチプロンプト内で1回だけ出現するように再構成
- **期待効果**: コール 24→4、トークン 50,000→15,000 (**-15〜18% 全体**)
- **リスク**: 5件バッチで分類精度劣化の可能性 → 既存データでA/B検証してから本番

### P1-1 (対象復活): 差分送信 — note + Thread 両方対象

- **対象 (v3で復活)**:
  - `src/services/note-generation/index.ts:349-407` (title+body両方送信)
  - `src/services/post-generation/index.ts:180-207` (body + profileSection送信)
- **v2での誤縮小**: Thread側も `existing.body + profileSection + feedback` を毎リビジョンで送信しており、差分化余地あり
- **修正方針**:
  1. 初回は全文、2回目以降は「監査指摘箇所 + 修正対象段落のみ」を diff 形式
  2. `regenerateDraft(retryContext)` に差分構造体を追加
  3. profileSection はシステムプロンプト化して毎回の再送信を回避
- **期待効果**: リビジョンコール毎 4,000→1,500 トークン (**-8〜10% 全体**)
- **リスク**: 差分送信で監査精度が落ちる可能性。**P0-3で既にリビジョン上限を下げているため、効果は部分的に重複する点に注意**

### P1-2 + P2-2 (統合): HeartbeatContext キャッシュ層

- **対象**:
  - `src/jobs/hourly-heartbeat.ts` (Context拡張)
  - `src/services/note-generation/index.ts:217, 260` (`getRecentCompetitorSnapshots()` 複数回呼び出し)
  - `src/services/executive/index.ts:237-246` (戦略履歴DB取得)
  - `src/services/orchestration/index.ts:514-553` (improvementInsights DB取得)
  - **新規追加**: `src/services/engagement-analysis/index.ts:685-689` (strategyRow の返信毎DB照会)
- **修正方針**:
  1. `HeartbeatContext` に `memo: Map<string, unknown>` を追加
  2. メモ化対象:
     - `competitorSummary`
     - `strategyHistory`
     - `improvementInsights`
     - `departmentReports`
     - **`strategyRow` (engagement-analysis用)** ← v3新規追加
  3. 競合スナップショット埋め込みは 240→100文字の要約版
- **期待効果**: **-5〜8% 全体** + DB負荷軽減 (特にstrategyRowの20回→1回は顕著)

### P2-1: 競合スナップショット分析の削減

- **対象**: `src/services/research/index.ts:341-343`
- **事前確認**: `competitor_snapshots` スキーマで「最新日時」「エンゲージメント指標」カラム要確認
- **修正方針**:
  1. 対象を「最新10件 + 高エンゲージ上位5件」に絞り込み
  2. 各スナップショットを 500→300文字に圧縮
- **期待効果**: 22,000→10,000 トークン (**-3〜5% 全体**)

---

## 着手順 (v3確定版)

```
P0-0 トークン計測ログ      ─→ 必ず最初。測れないものは削減できない
           ↓
P0-3 リビジョン上限 3→2    ─→ 2行変更。独立効果 -15〜20%
           ↓
P0-1 Executive要約化       ─→ -1〜2% (地味だが1コール最適化)
           ↓
P0-2 返信バッチ化(cache非依存) ─→ -15〜18%
           ↓
P1系 / P2系                ─→ P0で削れ方を見てから着手判断
```

### 削減後の見込み (v3: 現実目標 -45〜60%)

| フェーズ | 現実目標 | 備考 |
|---------|---------|---|
| 現状 | 基準値 (P0-0で実測) | 150k〜300k の推定 |
| P0-0 | 同左 | 計測のみ |
| P0-3 完了 | -15〜20% | コール数削減 |
| P0-1 完了 | -16〜22% | |
| P0-2 完了 | -30〜40% | |
| **P0全完了** | **-30〜40%** | ここで効果確認してP1判断 |
| P1+P2 追加 | **-45〜60%** | |

> v1で掲げた「-88%」は上限値扱いから除外。公式目標は **-45〜60%**。

---

## リスク・注意点 (v3追加)

- **prompt caching前提崩壊**: `HeartbeatLlmClient` は spawnSync で毎回新プロセス。`ClaudeLlmClient` も cache_control 未設定。**キャッシュによる削減は見込まない**
- **タイムアウト8分 × コール数**: 最大140コール × 8分 = 理論上1120分。実際は並列化されるが、コール数削減はトークンと同じく重要
- **P0-3 と P1-1 の効果重複**: P0-3でリビジョン上限を下げた後にP1-1を入れると、効果は一部重複。P0-3後の実測を見てP1-1の着手可否を判断
- **監査品質の劣化検知**: 各P0完了後、`audit.verdict` 分布や `score` の推移をダッシュボードで確認
- **並行修正禁止**: 1件ずつマージ→1ハートビート実測→次へ

---

## 検証手順

各フェーズ完了時:

1. P0-0で取得済みの基準値と比較
2. 修正後のハートビートを1回実行、`tmp/token-usage/*.jsonl` で使用量集計
3. 削減率が現実目標範囲か確認
4. 主要KPI (ドラフト通過率、投稿成功率、返信精度、`audit.score`中央値) が劣化していないか確認
5. 劣化があれば即ロールバック

---

## 次アクション

1. このv3をユーザーが確認 → GOが出たら **P0-0 (計測ログ追加)** から着手
2. P0-0 は LLMアダプタ + ハートビート両方に手が入るので Gemini に委譲
3. P0-0 マージ後、1ハートビートの実測値を取って基準化
4. P0-3 (2行変更) → P0-1 → P0-2 の順で1件ずつ進める
