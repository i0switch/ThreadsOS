# ハートビート トークン削減 P0実装 結果レポート (v2 / 監査反映訂正版)

- 日付: 2026-04-13
- 対象計画書: `tmp/heartbeat-token-reduction-plan-v4.1.md`
- 実装範囲: P0-0 / P0-0b / P0-1 / P0-2 / P0-3 (P0 全完了)

---

## 【訂正】前回レポートの虚偽記述

前回レポート (v1) に以下の事実誤認があった。全面訂正する。

| 前回記述 | 実態 |
|---|---|
| 「HeartbeatLlmClient.callClaudeCli を `--output-format json` 使用に変更」 | `"text"` のままだった |
| 「stdout から usage を抽出」 | callClaudeCli 内に `logTokenUsage` 呼び出しなし |
| 「次回ハートビート実行時から `tmp/token-usage/*.jsonl` に追記開始」 | `LLM_MODE=heartbeat` (本番デフォルト) では何も記録されない |

原因: 自分が実装コードを直接確認せずにレポートを書いた。前回のフィードバック (「検証済と書く前に全件Read」) を守れていなかった。本レポートでは全項目を実コード Read で再確認済み。

---

## 実装サマリ (v2 / 訂正後)

| 項目 | 状態 | 変更箇所 |
|---|---|---|
| P0-0 計測ログ基盤 (direct mode) | ✅ | `src/adapters/llm/index.ts:138-152` (ClaudeLlmClient.generate に `logTokenUsage` 呼び出し) |
| **P0-0b** 計測ログ基盤 (heartbeat mode) | ✅ | `src/adapters/llm/index.ts:269-384` (callClaudeCli を `--output-format json` に切替 + JSON配列パース + `logTokenUsage` 呼び出し) |
| P0-1 リビジョン上限 3→2 | ✅ | `src/services/orchestration/index.ts:35-36` |
| P0-2 返信分類バッチ化 | ✅ | `src/services/engagement-analysis/index.ts:638-880` |
| P0-3 Executive要約化 | ✅ | `src/services/executive/index.ts:223-360` |
| `startHeartbeatSession()` 呼び出し配線 | ✅ | `src/jobs/hourly-heartbeat.ts:203` |
| `token-logger.ts` 新規作成 | ✅ | `src/adapters/llm/token-logger.ts` |
| 18+箇所 label 追加 | ✅ | 各services配下 |

### 最終検証 (P0-0b 完了後に再実行)
- `npx tsc --noEmit` → **EXIT 0**
- `npx vitest run tests/adapters.test.ts tests/executive.test.ts` → **10/10 passed**

---

## P0-0b: Heartbeat mode 計測 (新規追加・最重要訂正)

### 問題
前回の P0-0 実装は `ClaudeLlmClient` (direct mode) にしか計測コードを入れていなかった。`CLAUDE.md` に `LLM_MODE=heartbeat` が本番デフォルトと明記されており、`createLlmClient()` のデフォルトも `HeartbeatLlmClient` のため、本番では計測が一切機能しない状態だった。

### 修正内容 (`src/adapters/llm/index.ts:269-384`)

1. **CLI 引数変更**: `"--output-format", "text"` → `"--output-format", "json"`
2. **出力パース**: CLI が stream-json 配列を返すので `JSON.parse(stdout)` → 配列から `{type:"result"}` エントリを抽出
3. **応答テキスト抽出**: `resultEntry.result` (string型) を返り値とする
4. **トークン計測**: `resultEntry.usage.{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}` + `total_cost_usd` + `duration_ms` を `logTokenUsage` に渡す
5. **`is_error` ハンドリング**: CLI 側でエラーが立てられた場合は例外化
6. **フォールバック**: JSON パース失敗時は stdout をそのまま返し、ログに `stdoutPreview` を記録 (契約互換性保持)
7. **使用量制限チェック**: 旧コードは `stdout.includes("out of usage")` を JSON全体に対して見ていた。新コードは抽出後の `responseText` でチェック
8. **`resolveLlmTier` 使用**: ログ出力の tier フィールドを実際のデフォルトで埋めるため

### 動作確認根拠
初期の CLI 検証 (Bash b4) で `claude --print --output-format json` が以下の形式で出力することを確認済み:
```
[{type:"system",...}, {type:"assistant",...}, {type:"result", result:"応答テキスト", usage:{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}, total_cost_usd, duration_ms, is_error}]
```

### 本番で期待される動作
- `LLM_MODE=heartbeat` で `tmp/token-usage/YYYY-MM-DD.jsonl` にハートビート中の全LLMコール (18+箇所) のエントリが追記される
- 各エントリに `cache_creation_input_tokens` / `cache_read_input_tokens` が含まれるので、spawnSync × 新プロセス起動による「cache書き込み垂れ流し」問題 (初期CLI検証で53k/callを確認) が定量化可能

---

## P0-0 (direct mode): 計測ログ基盤

### 実装内容
1. **新規ファイル** `src/adapters/llm/token-logger.ts`
   - `logTokenUsage(entry: TokenUsageEntry)` 関数
   - 出力先 `tmp/token-usage/YYYY-MM-DD.jsonl` (ディレクトリ自動作成)
   - 構造: `{ timestamp, heartbeatId, callSite, tier, inputTokens, outputTokens, cacheCreationTokens?, cacheReadTokens?, costUsd?, durationMs }`

2. **`src/adapters/llm/index.ts`** (ClaudeLlmClient 側)
   - `LlmGenerateOptions` に `label?: string` 追加
   - `ClaudeLlmClient.generate` で API の `usage.{input_tokens,output_tokens}` を捕捉 → `logTokenUsage` 呼び出し (L138-152)
   - `audit` メソッドに `options?: LlmGenerateOptions` 追加

3. **`src/jobs/hourly-heartbeat.ts`**
   - `currentHeartbeatId` モジュール変数 + `startHeartbeatSession()` / `getCurrentHeartbeatId()` エクスポート
   - `runJob` コールバック先頭で `startHeartbeatSession()` 呼び出し (L203)

4. **label 追加 (18+箇所)**: 全LLM呼び出し元で `options.label` を明示

---

## P0-1: リビジョン上限引き下げ

```ts
// src/services/orchestration/index.ts:35-36
const MAX_THREAD_REVISION_ATTEMPTS = 2;
const MAX_NOTE_REVISION_ATTEMPTS = 2;
```

### 理論効果 (計画書v4.1)
- Thread監査: 最大105コール → 最大75コール (-30)
- Note監査: 最大21コール → 最大15コール (-6)
- 全体LLMコール数 約150の24%削減 ≒ トークンベース **-15〜20%**

### 事後検証項目
- P0-0b で取得した実測ログ (`tmp/token-usage/*.jsonl`) から「3回目リビジョンでpassに至った割合」を集計
- 5%超の品質劣化なら定数を `3` に戻す (2行のみ)

---

## P0-2: 返信分類バッチ化 (cache非依存設計)

### 実装内容 (`src/services/engagement-analysis/index.ts:638-880`)

1. **strategyRow のループ外巻き上げ** — 20返信で20回DB照会していたのを1回に集約
2. **新規返信の先行フィルタ + insert** — `existingReply` チェックとthreadReplies insertをバッチ前に完了
3. **5件バッチ化** — 1コールでJSON配列取得、`replyEffectivenessContext` / `replyPolicyContext` / `toneContext` はバッチプロンプト先頭に1回配置
4. **リトライ** — バッチパース失敗時に1回再試行、2回目も失敗すればバッチ全件 `ignore`、欠損した threadsReplyId は個別 `ignore`
5. **label** — `engagement-reply-classification-batch` / `engagement-reply-classification-batch-retry`
6. **DB副作用維持** — `threadReplies.sentiment` 更新 / `replyDecisions` insert / `humanReviewItems` 挙動はそのまま

### 効果見込み
- LLMコール 20→4 (-80%)
- トークン 50k→15k
- **全体 -15〜18%**

---

## P0-3: Executive プロンプト要約化

### 実装内容 (`src/services/executive/index.ts:223-360`)

1. **部署レポート要約** — `{ headline(100字), keyMetrics(辞書順上位3), status(50字) }` へ圧縮
2. **戦略履歴** — `limit(5)` → `limit(3)`、各 reasoning を400字切り詰め
3. **エラーセクション** — `recentFailures` / `pendingProposalSummaries` を先頭3件+総件数、エラーメッセージは120字切り詰め
4. **保護** — JSON 回答形式 / 判断原則 / objective / funnelStage 選択肢 / policyUpdates は無変更、label は `executive-heartbeat-cycle` 維持

### 効果見込み
- 1コール 5000→2000 トークン
- Executive は1回/HBなので全体 **-1〜2%**

---

## 累積削減見込み (P0全完了・P0-0b込み)

| 段階 | 累積削減 (現実目標) |
|---|---|
| P0-1 単独 | -15〜20% |
| + P0-2 | -30〜38% |
| + P0-3 | -31〜40% |
| **P0全完了** | **-30〜40%** (計画書v4.1目標と一致) |

---

## 変更ファイル一覧 (最終)

```
新規:
  src/adapters/llm/token-logger.ts

修正:
  src/adapters/llm/index.ts           (P0-0 direct, P0-0b heartbeat, label/options型)
  src/jobs/hourly-heartbeat.ts         (startHeartbeatSession wiring + label)
  src/services/orchestration/index.ts  (P0-1: 定数2行)
  src/services/engagement-analysis/index.ts (P0-2: バッチ化 約200行)
  src/services/executive/index.ts      (P0-3: 要約化 + label)
  src/services/post-generation/index.ts        (label)
  src/services/post-audit/index.ts             (label)
  src/services/note-generation/index.ts        (label)
  src/services/note-audit/index.ts             (label)
  src/services/cadence-optimizer/index.ts      (label)
  src/services/research/index.ts               (label)
  src/services/note-engagement-analysis/index.ts (label)
```

---

## 次アクション

1. **本番ハートビート1回実行** (`LLM_MODE=heartbeat` 環境)
   - P0-0b で heartbeat mode 計測が入ったので、`tmp/token-usage/2026-04-13.jsonl` に追記される
   - 各 label のエントリ揃いと `usage` 値確認

2. **基準値取得と効果検証**
   - `jq` 等で callSite 毎の input/output トークン合計集計
   - 修正前 (git で1コミット戻した状態) との比較で実削減率算出

3. **P0-1 事後検証**
   - `thread_post_audits` / `note_audits` の `attempt` / `verdict` 履歴から「3回目でpass」割合を集計
   - 5%超なら定数を `3` に戻して P1-1 (差分送信) へ切替

4. **P1 / P2 着手判断**
   - 実測 -30% 下回り → P1-1 追加検討
   - 実測 -40% 超え → P1以降見送り、P2棚卸しで未調査6箇所の削減余地優先

---

## 残リスク・注意点 (訂正版)

1. **P0-0b の実CLI挙動依存**
   - `claude --print --output-format json` の出力スキーマが将来変わるとパース失敗
   - フォールバック (stdout そのまま返却) があるので応答自体は壊れないが、計測が無音で止まる可能性 → ログに `"Failed to parse CLI JSON output"` warn で検知可能

2. **P0-1 品質劣化リスク**
   - 事前集計なしで入れたため、実測ログが溜まった後に要確認

3. **P0-2 分類精度**
   - 修正前後で `replyDecisions.decision` 分布A/Bが必要

4. **P0-3 metrics欠損**
   - 辞書順上位3抽出なので重要指標が落ちる可能性 → 数HB分の判断品質を観察

5. **token-logger の I/O 効率**
   - `writeFileSync({flag:"a"})` を毎コール実行 (70-80回/HB)。現状動作に問題ないが、append stream 化は将来検討

---

## 自己反省

- 前回レポート v1 で「HeartbeatLlmClient 側も `--output-format json` に切替」と書いたのは虚偽だった。Gemini 委譲の完了報告を実コード確認せずに信用した結果
- 原因は委譲先ではなく自分の検証漏れ。監査されないとバレないまま本番投入していた可能性あり
- 今回の P0-0b は自分で実装+実コード確認済み。以降は委譲結果もすべて Read で裏取りしてからレポートに書く
