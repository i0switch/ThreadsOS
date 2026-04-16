# P1-A 修正+実測レポート (2026-04-13)

- 指示書: `tmp/heartbeat-token-reduction-next-steps-instruction-v4.3.md`
- Task 1〜4 の全結果
- 結論: **POC不合格により P1-A バッチ化を単発版にロールバック**

---

## 1. 実施タスク

### Task 1: BATCH_SIZE=5 chunk実装 ✅

- `src/services/post-audit/index.ts` に `AUDIT_BATCH_SIZE = 5` を追加
- `auditDraftsBatch` を chunk ループ化、各 chunk を `auditDraftsChunk` (private) へ分離
- N件ドラフト → `Math.ceil(N/5)` 回バッチコール
- chunk ロジックは post-audit 側で完結、orchestration 側には漏らさない

### Task 2: label分離 ✅

- 単発版: `thread-post-audit` (変更なし)
- バッチ版: `thread-post-audit-batch`
- フォールバック (バッチ結果欠落時の単発リトライ) は従来どおり `thread-post-audit` で記録

### Task 3: P1-A POC (N=30) ✅ → **不合格**

POC スクリプト: `scripts/p1a-audit-poc.ts` (DB副作用なし専用経路)
レポート: `tmp/heartbeat-token-reduction-p1a-poc-2026-04-13.md`

| 指標 | 実測 | 合格ライン | 判定 |
|---|---|---|---|
| verdict 一致率 | **86.7%** | ≥90% | ❌ |
| severity 一致率 | **83.3%** | ≥85% | ❌ |
| score 絶対差 中央値 | 1 | ≤1 | ✅ |
| reasons 平均差 | 0.47 | ≤1 | ✅ |
| suggestions 平均差 | 0.57 | ≤1 | ✅ |

**不合格内訳**: 不一致4件すべてが「単発=`revise`/`medium` → バッチ=`pass`/`low`」のパターン。**バッチは甘く判定する傾向**。

### 指示書の不合格時分岐を実施 ✅

- `runDailyThreadsPlan()` を単発版フローに戻す (orchestration:633 を per-draft `settleThreadDraft` ループへ書き換え)
- `settleThreadDraft` を orchestration に復活
- `settleThreadDraftsBatch` と `auditDraftsBatch` は残置 (将来の再設計ベース)

### 副次バグ修正 ✅

ロールバック後HBで `saveAuditResult:81` クラッシュ (`auditResult.reasons.join` の reasons undefined)。
- `auditDraft` で `auditResult.{reasons,suggestions,score}` を `?? []` / `?? 5` でdefensive化
- 元々単発版に存在した潜在バグ (LLM応答欠損時)

### 循環依存解消 ✅

POC実行時に発覚。`adapters/llm/index.ts` ⇔ `jobs/hourly-heartbeat.ts` の双方向import → TDZエラー。
- 新規 `src/app/heartbeat-context.ts` に `startHeartbeatSession` / `getCurrentHeartbeatId` を切り出し
- 両モジュールからの依存を単方向化

### Task 4: 本番1HB再測定 ✅ (ただしバッチ化は不採用のため比較対象が変わった)

ロールバック完了後のHB実行結果:

---

## 2. 実測データ (3 HB比較)

| HB | ハートビートID | 状態 | コール数 | トークン合計 | cost | cache_read |
|---|---|---:|---:|---:|---:|---:|
| HB1 | `b1b8915c` | P0-0/P0-1完了後 (バッチ無) | 44 | 773,323 | **$5.02** | 961,848 |
| HB2 | `a3256b97` | バッチ化試行 (クラッシュ) | 26 | 431,874 | $2.95 | 592,692 |
| HB3 | `925d5d31` | **最終 (ロールバック+バグ修正)** | 46 | 729,119 | **$5.04** | 1,195,504 |

> HB2 は途中で `saveAuditResult` クラッシュしたため不完全データ。比較対象外。

### Task 4 主指標: `thread-post-audit` 系 cost ÷ ドラフト数

| HB | ドラフト数 | audit系コール | audit系cost | **cost/draft** |
|---|---:|---:|---:|---:|
| HB1 (バッチ無) | 15 | `thread-post-audit`=26 | $2.75 | **$0.183** |
| HB3 (ロールバック後) | 15 | `thread-post-audit`=27 | $2.62 | **$0.175** |
| **削減率** | ±0 | +1 | -5% | **-4.5%** |

### 参考値: HB全体cost
- HB1: $5.02 → HB3: $5.04 (**±0%**)
- バッチ化を戻したので当然ほぼ同等

### cache_read の差
- HB1: 961,848 → HB3: 1,195,504 (**+24%**)
- 同一プロンプトの再利用が増え、実効課金トークン (cache_read除く) は削減傾向

---

## 3. callSite 内訳 (最新HB3)

| callSite | tier | コール数 | トークン | cost |
|---|---|---:|---:|---:|
| thread-post-audit | premium | 27 | 364,608 | **$2.62** |
| threads-regenerate-draft | standard | 12 | 239,525 | $2.02 |
| heartbeat-human-review-auto-eval | fast | 3 | 65,703 | $0.10 |
| threads-draft-generation | standard | 3 | 46,233 | $0.25 |
| executive-heartbeat-cycle | standard | 1 | 13,050 | $0.06 |

> `thread-post-audit-batch` は **0件** (ロールバック後なのでゼロ)。

---

## 4. 計画書v4.3に対する達成状況

| 項目 | 状態 |
|---|---|
| P0-0 計測ログ基盤 | ✅維持 |
| P0-0b Heartbeat mode計測 | ✅維持 |
| P0-1 リビジョン上限 3→2 | ✅維持 (効果は残る) |
| P0-2 返信分類バッチ化 | ✅維持 (今回HBでは未発火) |
| P0-3 Executive要約化 | ✅維持 |
| **P1-A thread-post-audit バッチ化** | ❌ **POC不合格で一時撤回** |
| P1-B / P1-B0 / P1-C / P1-D-EXP | 未着手 |

---

## 5. POC不合格の原因考察 (3観点)

指示書の指示通り、原因を「バッチサイズ」「プロンプト設計」「JSON形式」で切り分け:

### a) バッチサイズ (5件)
- 5件同時評価でLLMが「全体として悪くない → 個別も pass」と寛容化する可能性
- 次回実験案: **バッチサイズ 3 で再POC**
- または1件ずつの単発を継続しコスト削減は別観点で検討

### b) プロンプト設計
- 現行バッチプロンプトは `### Draft 1\nbody:...` でナンバリング
- 単発プロンプトは「このコンテンツを監査」で個別焦点
- 疑い: LLMが「バッチ = 一覧チェック」の認識で深く見ない
- 改善案: **バッチプロンプトに「各draft毎に独立して厳格判定」と明記**、criteria の「具体的に該当する指摘理由を最低2つ挙げる」等の強制

### c) JSON形式
- 現状は `[{draftId, verdict, severity, reasons, suggestions, score}]` の素直な配列
- LLMがすべてのdraftに同じ判定を連鎖させる傾向の可能性
- 改善案: 各要素に `independentScore: number` 追加で独立性を明示

### 結論
最も可能性高いのは **(a) + (b)**。バッチが5件でまとめて「甘く」なる認知バイアス的挙動。次のアクションとしてはバッチサイズ3 + プロンプト強化で再POCが妥当。

---

## 6. 変更ファイル一覧 (今回のセッション)

**新規**:
- `src/app/heartbeat-context.ts` (循環依存解消)
- `scripts/p1a-audit-poc.ts` (POC専用)
- `tmp/heartbeat-token-reduction-p1a-poc-2026-04-13.md` (POC結果)
- `tmp/heartbeat-token-reduction-measurement-after-p1a-2026-04-13.md` (本レポート)

**修正**:
- `src/adapters/llm/index.ts` (import元切替)
- `src/jobs/hourly-heartbeat.ts` (heartbeat-context へ依存先変更)
- `src/services/post-audit/index.ts`:
  - `AUDIT_BATCH_SIZE = 5` 定数追加
  - `auditDraftsBatch` を chunk化
  - バッチ version label `thread-post-audit-batch`
  - 単発 `auditDraft` に defensive fallback 追加
- `src/services/orchestration/index.ts`:
  - `settleThreadDraft` (単発版) を復活
  - `runDailyThreadsPlan` の呼び出しを単発ループに戻す

---

## 7. 次アクション案 (指示書の「今はやらないこと」を除外)

1. **POC再設計** (P1-A 再挑戦の前提)
   - バッチサイズ 3 で再POC
   - プロンプトに「各draft独立判定」強調を追加
   - 合格なら P1-A 再投入
   - 不合格なら P1-A を正式放棄
2. **他の P1 施策への切替検討**
   - P1-B0 (指摘位置の構造化)
   - P1-C (プロンプト先頭固定化)
   - P1-D-EXP (TTL測定ハーネス)
3. **データ蓄積**
   - P1-D-EXP より先に、HBを複数回回して note発火HB / 返信発火HB の実測データを増やす
   - 現状データは thread系中心、note/返信は未計測

---

## 8. まとめ

- **指示書の4タスクすべて完了**
- P1-A バッチ化は実装まで完了したが、POCで品質劣化を検知し**使用せずロールバック**
- 1HBコストは $5.02 → $5.04 で横ばい (期待していたバッチ化効果 -31% は**得られず**)
- 代わりに判明したのは「単発版+P0全適用」で既に cache_read が +24% 働いている事実
- 次の真のレバレッジは **P1-B (regenerateDraft 差分送信)** か **P1-C (プロンプト先頭固定化)** に移すのが妥当
