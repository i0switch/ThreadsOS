# ハートビート トークン削減計画 v4.3 (実測再検証・実装前提補強版)

- 作成日: 2026-04-13 21:14
- 計測根拠: `tmp/token-usage/2026-04-13.jsonl` (1HB, 44エントリ) + 実コード読了
- 前版: v4.2 — 見積もり楽観 & 実装スコープ過小評価。v4.3 で4点訂正

---

## 版管理対応表

| 旧項目 (v4.1) | v4.2 での扱い | v4.3 での扱い |
|---|---|---|
| P0-0 計測ログ | ✅完了 | 変更なし |
| P0-1 リビジョン上限 3→2 | ✅完了 | 変更なし |
| P0-2 返信分類バッチ化 | ✅完了 | 変更なし |
| P0-3 Executive要約化 | ✅完了 | 変更なし |
| P1-1 差分送信 (regenerate) | 継続 (P1-B) | **前段タスク P1-B0 追加**: 指摘位置の構造化 |
| P1-2 HeartbeatContext メモ化 | 継続 | 未変更 |
| P2-1 競合スナップショット削減 | P2-D | 未変更 |
| (新規 v4.2) P1-A audit バッチ化 | 最優先 | 維持。ただし**見積もり再計算 + 実装スコープ拡大** |
| (新規 v4.2) P1-C プロンプト先頭固定化 | 3番目 | 維持。算式は実測委ねに明記 |
| (新規 v4.2) P1-D 軽HB/重HB分離 | 4番目 | **TTL実験を専用ハーネス化** |
| (旧) cache非依存前提 | v4.2で訂正 | 維持 |

---

## v4.3 で訂正する4つの穴

### ① P1-A 見積もり再計算

v4.2 の記述「cache_create: 380k → ~80k、HB全体 -43%」は**楽観過ぎ**。

**実測 (`thread-post-audit` 26コール, `tmp/token-usage/2026-04-13.jsonl`):**

| コール | cache_create | cache_read |
|---|---:|---:|
| 1回目 (コールド) | 28,550 | 0 |
| 2〜16回目 平均 | 13,547 | 15,072 |
| 17回目 (再cold — TTL切れ) | 28,237 | 0 |
| 18〜26回目 平均 | 13,484 | 15,072 |

**構造**:
- `cache_read=15,072` (一定) → **固定部** (BASE_AUDIT_CRITERIA + profile.forbiddenTopics + profile.tone + 指示文)
- `cache_create=13,500前後` (毎回) → **可変部** (draft.body + 指示応答形式の一部)
- 「監査基準が1回だけ create されて終わり」は誤り。**各ドラフトの本文が毎回 cache_create を生む**

**バッチ化の再見積もり** (5件バッチ × 初回3バッチ + 再監査3バッチ = 6コール想定):

| 項目 | 現状 | バッチ化後 |
|---|---:|---:|
| コール数 | 26 | 6 |
| cache_create (固定部) | 26 × 15k = 380k | 1 × 15k = 15k |
| cache_create (可変部 draft body) | 26 × 13.5k ≒ 350k* | 6 × 5件 × 13.5k ≒ 無変化 |
| **合計 cache_create** | **~380k (実測)** | **~165k (推定)** |
| cache_read | 361k | ~75k |
| 課金相当 (in+out+create) | 388k | ~170k |
| **削減率** | — | **-56%** |

> *実測の380kには可変部と固定部の初期化が混在。見かけ上の内訳は要POC実測で確定

**HB全体への影響**:
- thread-post-audit は HB コストの 55% → バッチ化で -56% → HB全体 **-31%**
- HBコスト: $5.02 → **~$3.5** (v4.2の $2.86 より保守的)
- 月額: $3,600 → **~$2,500** (単独効果)

> v4.2 の「-43%/HB」は撤回、v4.3 では **-31%/HB** が根拠付き見積もり。

### ② P1-A 実装スコープ拡大

v4.2 で対象を「post-audit + settleThreadDraft」としたが、**実コード確認で以下の副作用が発覚**:

`src/services/post-audit/index.ts:35-149` の `auditDraft` は LLM 呼び出し以外に以下を per-draft で実行:
1. `threadPostAudits` insert/update (L83-106)
2. `threadPostDrafts.status` 更新 (L108-119, verdict毎に分岐)
3. `humanReviewItems` insert/update/approve (L121-149)

`src/services/orchestration/index.ts:122-148` の `settleThreadDraft` は:
- 1ドラフト → `auditDraft` → (revise なら) `regenerateDraft` → `auditDraft` の**逐次ループ**
- MAX_THREAD_REVISION_ATTEMPTS=2 (P0-1完了)
- 返り値は `{ draft, audit }` の per-draft ペア

**バッチ化の実装スコープ (改訂版)**:
1. 新規メソッド `PostAuditService.auditDraftsBatch(draftIds: string[], llm): Promise<Map<draftId, ThreadPostAudit>>`
   - LLM プロンプトは 5件まとめて、JSON配列で verdict/severity/reasons/suggestions/score を回収
   - 取得後、`Map<draftId, auditResult>` で返す
2. **DB副作用の配列処理化**:
   - 既存の per-draft 処理をループで実行 (audit保存、status更新、humanReview起票)
   - transaction で一括化も検討 (現状は個別 `.run()` が混在)
3. **オーケストレーション再設計**:
   - `settleThreadDraftsBatch(drafts: ThreadPostDraft[], llm)` を新設
   - フェーズ分け:
     - Phase 1: 全ドラフトをバッチ監査
     - Phase 2: `verdict === "revise"` のドラフトのみを抽出して regenerate (これは per-draft のまま、差分送信は P1-B)
     - Phase 3: 再生成したドラフトを再度バッチ監査
     - Phase 4: MAX_THREAD_REVISION_ATTEMPTS まで Phase 2-3 繰り返し
   - `verdict === "pass" | "reject" | "human_review"` のドラフトは Phase 1 で完了
4. 既存の `settleThreadDraft` (単発) は非推奨化 (既存テスト互換のため残す)
5. `DepartmentExecutionService` の呼び出し元を `settleThreadDraftsBatch` に切替

**工数見積もり (v4.3)**:
- v4.2 想定: 1ファイル改修 / 半日
- v4.3 実態: **3ファイル改修 + テスト更新 / 1〜2日**
  - `post-audit/index.ts`: `auditDraftsBatch` 新設 + DB副作用のループ化
  - `orchestration/index.ts`: `settleThreadDraftsBatch` 新設
  - `department-execution/index.ts` 等: 呼び出し元切替
  - テスト: バッチ vs 単発の verdict 分布比較

### ③ P1-A POC 精度判定基準の定量化

v4.2 の「JSON精度を確認」だけでは不十分。以下の定量基準を定義:

**POC 実施手順**:
1. 直近 `thread_post_audits` から 50 ドラフト分をサンプリング (可能なら多様性確保)
2. 現行 (単発 `auditDraft`) で 50件を監査 → baseline 結果
3. バッチ版 (`auditDraftsBatch` 5件ずつ 10回) で同 50件を監査 → candidate 結果
4. 比較指標:
   | 指標 | 合格ライン |
   |---|---|
   | `verdict` 一致率 | **≥ 90%** |
   | `severity` 一致率 | ≥ 85% |
   | `score` 絶対差 中央値 | ≤ 1 |
   | `reasons` / `suggestions` の意味的重なり (手動抽出) | ≥ 70% |
5. **判定**:
   - 全指標合格 → 本実装へ進行
   - `verdict` 80-90% → プロンプト再設計して再POC
   - `verdict` < 80% → バッチ化断念、他のP1へ

### ④ P1-B 前段タスク追加 (指摘位置の構造化)

v4.2 の「監査指摘箇所 + 修正対象段落のみを diff 形式で渡す」は、**現状コードでは成立しない**。

**実コード確認 (`src/services/orchestration/index.ts:105-109`, `src/services/post-generation/index.ts:181-214`)**:
- `regenerateDraft(draftId, feedback: string, llm)` — feedback は**平文文字列**
- `buildThreadRevisionFeedback(audit)` は `audit.suggestions + audit.reasons` を改行で連結しただけ
- 段落ID / 指摘位置 / 差分適用ロジックが**一切存在しない**

**新規タスク P1-B0 (P1-B の前段)**: 指摘位置の構造化

- **対象**:
  - `src/domain/threads/index.ts` の `ThreadPostAudit` 型に `locatedReasons: Array<{ location: string; reason: string; suggestion?: string }>` を追加
  - `post-audit` の監査プロンプトで「指摘ごとに `location` (例: "line 2-3" / "hook部分" / "CTA直前") を明記」させる
  - DB スキーマ `threadPostAudits.reasons` を構造化版 JSON に (マイグレーション必要)
- **なしでP1-Bに進むリスク**: 「全文+平文feedback」のまま差分送信しても、LLMに「どこを直せ」が伝わらず品質劣化。P1-B0無しでP1-Bを断念した方がマシ
- **判断**: P1-B0 を実施するか、P1-B 自体を取り下げるかは**P1-A 完了後の残コスト**を見て決める

### ⑤ P1-D TTL実験 — 専用ハーネス必須

v4.2 の「5分/7分/10分間隔でHB連続3本」は現状不成立。

**実コード確認 (`src/jobs/heartbeat-loop.ts:80-106`, `ecosystem.config.cjs:25-55`)**:
- L87: `runHeartbeatIteration()` 完了後に `setTimeout(resolve, intervalMs)` で待機
- HB実行19分 + interval 10分 = **実効cadence 29分**
- `HEARTBEAT_LOOP_INTERVAL_MS=3600000` (1時間) 固定
- HB内容も状況依存で毎回異なる → 「cache miss か内容違いか」判別不能

**新規タスク P1-D-EXP**: TTL測定専用ハーネス

- **新規スクリプト**: `scripts/ttl-probe.ts`
  - 固定のダミープロンプト (例: "以下のテキストを5点評価してください: テスト内容A") を `claude --print --output-format json` で叩く
  - プロンプトは毎回**完全に同一**にし、cache_creation vs cache_read の差分で TTL 境界を測る
  - パラメータ: `interval=[60s, 180s, 300s, 420s, 600s]`, 各3回計測
  - 出力: `tmp/ttl-probe-YYYY-MM-DD.jsonl`
- **判定基準**:
  - `cache_read` が0になる最小間隔が TTL 境界
  - TTLが計画書想定通り300s (5分) か、もっと長いか短いかを確定
- **判断材料**: 測定結果を見てから P1-D (軽HB/重HB分離) の設計判断

### ⑥ tier変更の検証強度引き上げ

v4.2 L181-182 「premium→standard に変更で品質劣化しないかA/B」では軽い。

**改訂方針**: **まず現状維持**。tier変更は以下を満たした場合のみ検討:
- N=50ドラフトでの `verdict` 一致率 ≥ 92% (監査タスクは論理判断重のため厳しめ)
- `score` 中央値の差 ≤ 0.5
- 上記を 3 HB連続で観察
- それでも tier を premium→standard にするかは**ユーザー承認必須**

---

## 着手前の必須要件 (v4.3 新設)

P1-A 着手前に以下を全て満たす:

1. **[必須]** 追加HB 3〜5本分の実測データ取得
   - 特に note 生成が発火するHB を最低1本含む
   - 返信分類が発火するHB を最低1本含む
   - 現状の「thread偏重HB (1HB)」だけでは全体最適が偏る
2. **[必須]** P1-A POC の実装と 50ドラフト精度計測
   - 合格基準 (上記③) を満たすこと
3. **[必須]** P1-A の実装スコープ再見積もり
   - `orchestration` / `post-audit` / `department-execution` / テストの diff 規模
   - 工数 1〜2日で収まるか

## P1-D-EXP (TTL測定) は独立で先行可

- 実装スコープ小 (新規スクリプト1本)
- P1-A 判断に影響する TTL 値が分かる
- 優先度: P1-A 着手前に並行実施

---

## 改訂後の削減見込み (実測根拠ベース)

| 段階 | HBコスト | 累積削減 | 根拠 |
|---|---:|---|---|
| 現状 (1HB実測) | $5.02 | — | 直接計測 |
| P1-A thread-post-audit バッチ化 | ~$3.5 | **-31%** | 可変部を考慮した実測ベース |
| P1-C プロンプト先頭固定化 | ~$2.8〜3.2 | -36〜44% | cache_read 積み増し量は**POC実測委ね** |
| P1-B (P1-B0 経由) regenerateDraft差分送信 | ~$2.5〜2.9 | -42〜50% | 構造化完了後の期待値 |
| P1-D-EXP の結果による追加施策 | TBD | TBD | TTL測定後に確定 |
| **P1全完了 (実測積み上げ)** | **$2.5〜3.0** | **-40〜50%** | 重複削減は POC実測で最終化 |

> v4.2 の「-60〜70%」は撤回。v4.3 では **-40〜50% が実測根拠付きレンジ**。

---

## 着手順 (v4.3)

```
[並行] ① P1-D-EXP (TTL測定ハーネス構築・計測) ← 独立タスク、先行可
       ② 3-5HB 追加計測 (note/返信発火HBを含む) ← データ蓄積
       ③ P1-A POC (50ドラフト精度比較)
             ↓ 合格なら
       ④ P1-A 本実装 (3ファイル改修、1〜2日)
             ↓ 1HB実測で効果検証
       ⑤ P1-C プロンプト先頭固定化 (上位5箇所)
             ↓ 1HB実測
       ⑥ P1-B0 指摘位置の構造化 (やるか判断)
             ↓ やるなら
       ⑦ P1-B regenerateDraft 差分送信
             ↓
       ⑧ P1-D 軽HB/重HB分離 (TTL結果に応じて設計)
             ↓
       ⑨ P2 (計測継続、棚卸し箇所)
```

---

## 残リスクと注意点

1. **サンプル1HBからの戦略ピボット**: v4.2 で本問題を認識、v4.3 で「3-5HB 追加計測を着手前要件」に格上げ
2. **P1-A の verdict 分布変化**: バッチ化で「1件ずつ厳密に見る」より「5件を横並びで比較」する思考になる可能性。POC で検出可
3. **P1-B0 の工数**: スキーマ変更 + マイグレーション + 監査プロンプト再設計で工数大。**P1-B を取り下げる選択肢も残す**
4. **P1-D-EXP が空振りの可能性**: TTL が想定 (300s) と異なれば P1-D の設計自体が変わる
5. **tier 変更は原則保留**: ユーザー承認前提で現状維持

---

## 次アクション

1. **本v4.3をユーザー承認** → GOで P1-D-EXP + 追加HB計測 から並行着手
2. 追加HB計測は `npm run job:heartbeat` を指定時刻で3〜5回 (ユーザー判断でタイミング選定)
3. P1-D-EXP は別スクリプトで即着手可
4. P1-A POC は ①② のデータが揃ってから着手
