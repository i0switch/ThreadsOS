# P1-C 修正+実測レポート (2026-04-14)

- 対象計画: `tmp/heartbeat-token-reduction-plan-v4.3.md`
- 今回の範囲: **P1-C (プロンプト先頭固定化)** の最初の2 callSite
- 結論: **期待効果 -20〜30% は得られず、むしろ HBコスト +11%**。ロールバック推奨

---

## 1. 実施タスク

### ① 死コード TODO コメント追加 ✅

`src/services/orchestration/index.ts:150` の `settleThreadDraftsBatch`:
- 前回の監査指摘「未使用コードに誤解リスク」を解消
- 「POC不合格でロールバック、再投入時はバッチサイズ3+プロンプト強化を検討」と TODO で明記

### ② P1-C step 1: `thread-post-audit` プロンプト順序変更 ✅

対象: `src/adapters/llm/index.ts:168` (ClaudeLlmClient.audit) + `:412` (HeartbeatLlmClient.audit)

**変更前**:
```
以下のコンテンツを監査してください。
## コンテンツ
${content}            ← 可変
## 監査基準
${criteria}            ← 固定
## 回答形式
{...}                  ← 固定
```

**変更後 (cache hit 率最大化狙い)**:
```
以下の監査基準に従って、末尾のコンテンツを監査してください。
## 監査基準
${criteria}            ← 固定 (先頭へ)
## 回答形式
{...}                  ← 固定
## コンテンツ
${content}            ← 可変 (末尾へ)
```

### ③ P1-C step 2: `threads-regenerate-draft` プロンプト順序変更 ✅

対象: `src/services/post-generation/index.ts:194`

profileSection + 回答形式 を先頭に、可変部 (body / feedback) を末尾へ移動。

---

## 2. 実測データ (4 HB比較)

| # | HB ID | 状態 | calls | tokens | cost | cache_create | cache_read |
|---|---|---|---:|---:|---:|---:|---:|
| HB1 | `b1b8915c` | P0-0/P0-1完了後 | 44 | 773,323 | **$5.02** | 727,116 | 961,848 |
| HB2 | `a3256b97` | バッチ化試行 (クラッシュ、不完全) | 26 | 431,874 | $2.95 | 401,001 | 592,692 |
| HB3 | `925d5d31` | POCロールバック+defensive | 46 | 729,119 | **$5.04** | 685,628 | 1,195,504 |
| **HB4** | `7b063364` | **P1-C 適用後** | **55** | **924,389** | **$5.58** | 858,924 | 1,162,406 |

### HB3 vs HB4 (P1-C 純粋効果)

| 指標 | HB3 (P1-C前) | HB4 (P1-C後) | 差分 |
|---|---:|---:|---|
| コール数 | 46 | 55 | **+20%** |
| トークン合計 | 729k | 924k | +27% |
| HBコスト | $5.04 | $5.58 | **+11%** |
| cache_create | 686k | 859k | +25% |
| cache_read | 1,196k | 1,162k | -3% |

### Task 4 主指標: `thread-post-audit cost ÷ draft数`

| HB | ドラフト数 | audit系 コール数 | audit系 cost | **cost/draft** |
|---|---:|---:|---:|---:|
| HB3 | 15 | 27 | $2.62 | $0.175 |
| HB4 | 15 | 31 | $2.96 | **$0.197 (+13%)** |

### `threads-regenerate-draft`

| HB | コール数 | cost |
|---|---:|---:|
| HB3 | 12 | $2.02 |
| HB4 | **16 (+33%)** | $2.07 |

---

## 3. per-call cache_create 分布 (thread-post-audit)

### HB1 (P1-C前):
- 中央値: **13,557**
- cache_read: 15,072 (固定)

### HB4 (P1-C後):
- 中央値: **12,622** (-7%)
- cache_read: 15,126 (P1-C前とほぼ同値)

**重要な観察**:
- **cache_read サイズが P1-C 前後で変わっていない** (約15k)
- これは「P1-C 適用前から固定部は既にキャッシュされていた」ことを示唆
- つまり Anthropic サーバー側の自動 cache 機構 (たぶんシステムプロンプト含む先頭 N tokens) が既に効いていた
- プロンプト順序変更による cache hit 率向上は **ほぼゼロ** (12,622→13,557 の7%微減のみ)

---

## 4. 予期しなかった副作用

### コール数が 46 → 55 に増加した原因

| callSite | HB3 | HB4 | 差 |
|---|---:|---:|---|
| thread-post-audit | 27 | 31 | +4 |
| threads-regenerate-draft | 12 | 16 | +4 |
| heartbeat-human-review-auto-eval | 3 | 4 | +1 |

### 仮説
プロンプト先頭を「監査基準」から始め、末尾に「コンテンツ」を置いたことで、LLM が**以前より厳しく判定**するようになった可能性。

根拠:
- HB3 では 15 drafts / 12 revise / 15 passed (リビジョン1回で全員 pass)
- HB4 では 15 drafts / **16 revise** / 15 passed (1ドラフトあたり平均 1.07 回 revise)
- リビジョン 1ドラフトあたり 0.8 → 1.07 (+34%)

結果:
- 初期 audit (15) + regenerate (16) + re-audit (16) = 合計 47 思えるが実測31なので途中 pass 多数
- とはいえ revise 判定が増えた事実は変わらず

---

## 5. P1-C の最終判定

| 観点 | 評価 |
|---|---|
| cache hit 率向上 | ❌ ほぼゼロ (自動 cache が元々効いてた) |
| HBコスト削減 | ❌ 逆に +11% |
| `cost/draft` 削減 | ❌ +13% |
| judgment の副作用 | ⚠️ revise判定 +34% (品質向上かもしれないが実証不明) |
| 監査品質 | ? (POC未実施、15/15 passed は変わらず) |

**結論: P1-C は期待効果を出さず、コスト増。ロールバック推奨**。

### ただし評価の難しい点
- judgment が厳しくなった副作用は**監査品質向上の可能性**もある
- revise → regenerate が増えた = より良い文章になった可能性
- これを測るには別途の品質評価が必要 (人手 or LLM-judge)

---

## 6. 次アクション案

### 推奨 A: P1-C ロールバック (安全・即効)
- 両プロンプトの順序を元に戻す
- コストは HB3 水準 ($5.04) に戻る

### 推奨 B: P1-C 維持 + 品質評価
- プロンプト順序変更の副作用を「品質向上」として受け入れるか判定
- revise 多発の質を人手かLLM-judgeで比較 (N=30 サンプル)
- 品質向上が確認できれば +11% コストは受容可能
- 確認できなければ A へ

### 推奨 C: P1-C は放棄して P1-B0 / P1-B へ進む
- cache hit 率は既に最大化されていた (発見)
- プロンプト順序は効かない
- 真の削減レバーは差分送信 (P1-B) か別経路
- P1-C はロールバックした上で P1-B0 (指摘位置の構造化) を検討

### 個人的見解
**C が最も筋が良い**。今回の実測で判明した事実:
- cache機構は既に十分効いている (cache_read/create 比率 約1.5倍)
- プロンプト順序調整では削減できない
- 真の削減は「コール数削減」or「可変部のサイズ削減」しかない
- P0-1 (リビジョン上限) がその第1案、P1-B (差分送信) が第2案
- P1-A (バッチ化) は POC 不合格で断念済み

---

## 7. 変更ファイル一覧 (今回)

- `src/adapters/llm/index.ts` (audit プロンプト順序変更 x 2)
- `src/services/post-generation/index.ts` (regenerateDraft プロンプト順序変更)
- `src/services/orchestration/index.ts` (死コード TODO コメント追加)

検証:
- `tsc --noEmit` EXIT 0
- `vitest run adapters/reexecution-safe` 20/20 passed
- `npm run job:heartbeat` 正常完了、`Generated 15 drafts, 15 passed audit`

---

## 8. 判断待ち事項

以下のいずれを取るかユーザー指示待ち:
- **(A) P1-C ロールバック** — コスト戻す、速効
- **(B) P1-C 維持 + 品質A/B** — +$0.54/HB 払う価値あるか検証
- **(C) P1-C ロールバック + P1-B0 / P1-B 調査着手** — 構造的に削減する方向
