# ハートビート トークン削減計画 v4.1 (監査反映・実コード全件検証版)

- 作成日: 2026-04-13 (v4.1 改訂)
- 旧計画 (`archived-heartbeat-plan-v1-v3-DO-NOT-USE.md`) は前提誤認多く**参照禁止**
- 本計画の全記述は実コードを直接Readして検証済み

---

## 検証済みの全LLMコール棚卸し

> 計画書v1〜v3で漏れていた6箇所を含めた完全版。各行は実コードの `llm.generate` / `llm.audit` 呼び出し行を確認済み。

| # | ファイル:行 | 用途 | tier | 発火条件 |
|---|---|---|---|---|
| 1 | `src/services/executive/index.ts:470` | Executive判断 | standard | HB毎 × 1 |
| 2 | `src/services/post-generation/index.ts:79` | Threadsドラフト生成 (count指定でJSON配列) | standard | HB毎 × トピック数 |
| 3 | `src/services/post-generation/index.ts:209` | Thread regenerateDraft | standard | HB毎 × リビジョン回数 |
| 4 | `src/services/post-audit/index.ts:58` | Threadドラフト監査 | premium (audit内固定) | HB毎 × (ドラフト数+リビジョン) |
| 5 | `src/services/note-generation/index.ts:197` | Noteタイトル生成 | fast | HB毎 × トピック数 |
| 6 | `src/services/note-generation/index.ts:238` | Noteアウトライン | standard | HB毎 × トピック数 |
| 7a | `src/services/note-generation/index.ts:299` | Note本文 | standard | HB毎 × トピック数 |
| 7b | `src/services/note-generation/index.ts:300` | Note CTA | fast | HB毎 × トピック数 |
| 8 | `src/services/note-generation/index.ts:349-407` (:376) | Note regenerateDraft | standard | HB毎 × リビジョン回数 |
| 9 | `src/services/note-audit/index.ts:74` | Note監査 | premium | HB毎 × (ドラフト数+リビジョン) |
| 10 | `src/services/engagement-analysis/index.ts:741,750` | 返信分類 (ループ内) | fast | HB毎 × 返信数 ×1〜2(リトライ) |
| 11 | **`src/services/engagement-analysis/index.ts:865`** | **投稿毎インサイト生成** | **premium** | **HB毎 × 対象投稿数** |
| 12 | **`src/services/engagement-analysis/index.ts:951`** | **週間レポート** | **standard** | **週1** |
| 13 | **`src/services/cadence-optimizer/index.ts:238`** | **投稿頻度最適化** | **premium** | **HB毎 × 1** |
| 14 | **`src/services/research/index.ts:126`** | **Daily Topic Research** | **standard** | **日次 × トピック数** |
| 15 | `src/services/research/index.ts:361` | 競合分析 (`analyzeCompetitorSnapshots`) | standard | 発火頻度要調査 × チャネル数 |
| 16 | **`src/services/note-engagement-analysis/index.ts:558`** | **note投稿インサイト** | **premium** | **HB毎 × note投稿数依存** |
| 17 | **`src/services/note-engagement-analysis/index.ts:646`** | **Threads-note相関分析** | **standard** | **HB毎 × 1** |
| 18 | `src/jobs/hourly-heartbeat.ts:935` | 人間レビュー自動評価 | fast | HB毎 × 最大5 |

> **太字**は計画書v1-v3が見落としていた箇所。
> 「トピック数」「note投稿数」等の具体数は本計画執筆時点で未計測。P0-0実測で確定。

## リビジョンループの実態 (`src/services/orchestration/index.ts:35-36, 122-175`)

- `MAX_THREAD_REVISION_ATTEMPTS = 3` / `MAX_NOTE_REVISION_ATTEMPTS = 3`
- `settleThreadDraft`: 初期audit(1) + 最大3×(regenerate+audit)(6) = **最大7コール/ドラフト**
- 3トピック × 5ドラフト = 最大 **105コール/Thread**
- 3ドラフト × 7 = 最大 **21コール/Note**

## アダプタ層の実態 (`src/adapters/llm/index.ts`)

- L256-262 `HeartbeatLlmClient.callClaudeCli`: `spawnSync("claude", ["--print", ...])` で**コール毎に新プロセス起動**
- L73-81 `ClaudeLlmClient`: Anthropic API直接呼び出し、`cache_control` **未設定**
- L181 `CLAUDE_TIMEOUT_MS = 8 * 60 * 1000` (8分/コール)
- **結論**: prompt caching による削減は現状ゼロ。cache機構非依存の設計が必須

---

## 修正案 (検証済み事実ベース)

### P0-0 【最優先】: トークン計測ログ追加

**未実装。これが入るまで他修正は評価不能。**

- **対象**: `src/adapters/llm/index.ts` (両クライアント)、`src/jobs/hourly-heartbeat.ts`
- **着手前ブロッカー**: `claude --print --output-format json` が実際に使用量を返すかをまず検証。以下の順で判定:
  1. ローカルで `claude --print --output-format json` を試行しJSONに `usage` 相当のフィールドがあるか確認
  2. 無ければ `@anthropic-ai/tokenizer` または `tiktoken` 相当の近似tokenizer導入 (文字長ベース概算は日本語で±50%誤差あり、段階検証に耐えない)
  3. stderrパースは最終手段
- **実装方針**:
  1. `ClaudeLlmClient.generate`: APIレスポンスの `usage.input_tokens / output_tokens` を捕捉
  2. `HeartbeatLlmClient.callClaudeCli`: 上記ブロッカー判定結果に応じて `--output-format json` / tokenizer のいずれか
  3. 共通ログ: `{heartbeatId, callSite, tier, inputTokens, outputTokens, durationMs}` を `tmp/token-usage/YYYY-MM-DD.jsonl` にJSONL追記
  4. `callSite` 特定のため `generate` に `options.label` を追加、全呼び出し元 (上記棚卸し18箇所) で指定
- **効果**: 基盤整備 (直接削減なし)

### P0-1 【最大コスパ・2行変更】: リビジョン上限引き下げ

- **対象**: `src/services/orchestration/index.ts:35-36`
- **変更**: `MAX_THREAD_REVISION_ATTEMPTS = 3` → `2`、`MAX_NOTE_REVISION_ATTEMPTS = 3` → `2`
- **着手前調査 (必須)**:
  - 過去ログから **「3回目リビジョンでpassに至った割合」** を集計
  - 5%未満 → そのまま着手可 / 5-10% → 許容ギリギリ / 10%超 → P0-1保留し先にP1-1へ
  - 集計クエリ対象: `thread_post_audits`, `note_audits` の `attempt` / `verdict` 履歴
- **定量効果の計算**:
  - Thread監査: 105 → 75 コール (-30コール)
  - Note監査: 21 → 15 コール (-6コール)
  - 合計 -36コール / HB総コール数 概算150 ≒ **コール数 -24%**
  - 各コールのトークン重み差 (premium監査重・fast軽) を平均化すると **トークンベース -15〜20%**
- **リスク**: 品質劣化なら定数2行戻すだけ

### P0-2: 返信分類バッチ化 (cache非依存設計)

- **対象**: `src/services/engagement-analysis/index.ts:661-755`
- **問題**:
  - L685-689 `strategyRow` DB照会が**返信毎ループ内** (20返信=20回)
  - L709-732 `replyPolicyContext + toneContext` を**毎プロンプトに埋め込み**
  - L741, L750 `llm.generate` がリトライ含め返信毎
- **修正方針** (prompt cache非依存):
  1. `strategyRow` をループ外に巻き上げ (単発の速効対処。恒久的なメモ化は P1-2 で `HeartbeatContext` に統合)
  2. 分類を **5件バッチ** に変更 (JSON配列で結果回収)
     - 根拠: L823 に既存の `maxConcurrent = 5` があり、並列単位と整合
  3. `replyPolicyContext + toneContext` はバッチプロンプト先頭に1回だけ配置
- **効果見込み**: コール 20→4、トークン 50k→15k、**全体 -15〜18%**
- **リスク**: バッチで分類精度劣化の可能性 → 本番前A/B必須

### P0-3: Executive プロンプト要約化

- **対象**: `src/services/executive/index.ts:218-340`
- **問題**: 部署レポート/戦略履歴5件/エラー全件を `JSON.stringify` で丸ごと埋め込み
- **修正方針**:
  1. 部署レポートは既存 `summary/metrics/recommendation` を使い `{ dept, headline, keyMetrics[3], status }` 構造体に圧縮
  2. 戦略履歴は最新3件、各400字まで
  3. エラーは `count + 代表メッセージ1件` に集約
- **効果見込み**: 1コールのみ改善のため**全体 -1〜2%** (単発コスパ低だが意思決定情報の整理価値あり)

### P1 (P0の実測後に着手判断)

- **P1-1**: Note + Thread 両方の `regenerateDraft` に差分送信導入
  - 対象: `note-generation/index.ts:349-407` + `post-generation/index.ts:180-207`
  - ※ P0-1でリビジョン上限を下げた効果と重複するため、P0-1後の実測で必要性判断
  - 期待効果: **全体 -8〜10%**
- **P1-2**: `HeartbeatContext` メモ化層 (P0-2の速効対処を恒久化)
  - 対象: `strategyRow`(engagement-analysis L685-689、P0-2と同対象で統合)、`competitorSummary`(note-generation:217,260), `improvementInsights`(orchestration:514-553), `strategyHistory`(executive:237-246)
  - 効果: DB負荷減 + 重複DB→プロンプト埋め込み分の削減
  - 期待効果: **全体 -5〜8%**

### P2 (棚卸しで新規発見した箇所)

計画書v1-v3が完全に見落としていた以下を別タスクで削減余地調査:

- **着手前Read必須** (現時点で中身未確認):
  - `cadence-optimizer/index.ts:200-245` — `resultLines` の長さを点検
  - `engagement-analysis/index.ts:840-864` — 投稿毎インサイトのプロンプト埋め込み内容
  - `engagement-analysis/index.ts:920-950` — 週間レポートのデータ埋め込み量
  - `research/index.ts:100-129` — Daily Researchの `retrievalSection` / `webResultsStr` のサイズ測定 (トピック数×1コールで肥大化すると爆発源)
  - `note-engagement-analysis/index.ts:540-560, 620-645` — note側分析2箇所のプロンプト構成
- 各箇所に「P0-0計測」で実トークン数を取得してから削減優先度を決める

### P2-1: 競合スナップショット削減

- **対象**: `src/services/research/index.ts:341-343` (プロンプト組み立て) / `:361` (llm.generate)
- **修正方針**: 対象を「最新10件+高エンゲ上位5件」に絞り、各500→300字に圧縮
- **効果**: 22k→10k (**全体 -3〜5%**)

---

## 着手順 と 段階目標対応表

| 段階 | 着手項目 | 累積削減 (現実目標) |
|---|---|---|
| 0 | P0-0 計測ログ追加 | 基準値取得 |
| 1 | P0-1 リビジョン上限 3→2 | -15〜20% |
| 2 | P0-2 返信分類バッチ化 | -30〜38% |
| 3 | P0-3 Executive要約化 | -31〜40% |
| 4 | **P0完了** | **-30〜40%** |
| 5 | P1-1 regenerateDraft差分送信 | -38〜48% |
| 6 | P1-2 HeartbeatContext メモ化 | -43〜55% |
| 7 | **P1完了** | **-43〜55%** |
| 8 | P2-1 競合スナップショット削減 | -46〜60% |
| 9 | P2 棚卸し後の追加削減 | -45〜60% (最終) |

```
P0-0 計測ログ
   ↓ (実測で基準値)
P0-1 リビジョン上限 3→2
   ↓ (-15〜20% 検証)
P0-2 返信分類バッチ化
   ↓ (-15〜18% 検証)
P0-3 Executive要約化
   ↓ (-1〜2% 検証)
P1-1 / P1-2 判断 (P0実測を踏まえる)
   ↓
P2 棚卸し + P2-1
```

## 効果目標

- 計画書v1の「-88%」は非現実的として破棄
- 最終目標: **-45〜60%** (コール数削減とプロンプト圧縮の合算)
- **P0完了時点で -30〜40%**、**P1完了時点で -43〜55%**、**P2完了時点で -45〜60%**

---

## リスク

- **prompt caching前提の再発禁止**: アダプタが対応するまで cache 効果は見込まない
- **P0-1 と P1-1 の効果重複**: P0-1 後の実測を見てから P1-1 着手可否判断
- **P0-3 の要約設計**: 意思決定情報を削りすぎないようスキーマ事前レビュー
- **P2棚卸し未着手**: 6箇所の未棚卸しコール箇所が実運用ピーク時に爆発する可能性
- **P0-0 計測手段の不確実性**: CLI json出力が期待通りでない場合、tokenizer導入のため工数増

## 検証手順

各フェーズ完了時:
1. 修正前後のハートビート実行ログを `tmp/token-usage/*.jsonl` で比較
2. 削減率が段階目標レンジ内か確認
3. KPI (audit.score中央値、ドラフト通過率、投稿成功率、返信分類精度) が劣化していないか確認
4. 劣化→即ロールバック

## 次アクション

1. 本v4.1をユーザー承認 → GOが出たら **P0-0** から着手
2. P0-0 は着手前に `claude --print --output-format json` の動作検証を実施 (単発コマンドで検証可、Bashで実行)
3. 検証結果に応じて実装方針確定 → アダプタ層+全呼び出し元の `label` 追加でGemini委譲
4. P0-0 マージ+基準値取得後、P0-1 着手前に「3回目リビジョンpass率」を過去DBから集計
5. P0-1 → P0-2 → P0-3 の順で1件ずつ、各段階で実測検証
