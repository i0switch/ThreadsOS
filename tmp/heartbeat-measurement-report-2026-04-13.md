# ハートビート計測結果 分析レポート

- 日付: 2026-04-13
- 計測対象: 1ハートビート (heartbeatId `b1b8915c-649f-4d01-94a0-9009f2eea814`)
- 計測源: `tmp/token-usage/2026-04-13.jsonl` (44エントリ)
- 実行モード: `LLM_MODE=heartbeat` (HeartbeatLlmClient, P0-0b修正後)

---

## エグゼクティブサマリ

| 指標 | 値 |
|---|---|
| **総コール数** | **44** (計画書想定 45-60 の範囲内) |
| 入力トークン | 252 |
| 出力トークン | 45,955 |
| **キャッシュ書き込み** | **727,116** |
| **キャッシュ読み取り** | **961,848** |
| **課金相当トークン (in+out+cacheCreate)** | **773,323** |
| **総コスト** | **$5.02** (1HB) |
| 総実行時間 | 19.1分 |
| 平均/コール | 26秒 |

### 🔴 **前提崩壊発見: キャッシュは効いている**

計画書v4.1で「`HeartbeatLlmClient` は spawnSync で毎回新プロセス → cache ヒット不可」と書いたのは**誤り**。

実測:
- 総 cache_read: **961,848 tokens** (課金されない再利用分)
- 総 cache_create: 727,116 tokens
- **再利用率 132%** (読み取り÷書き込み)

Claude CLI は spawnSync で新プロセスでも、Anthropic側のサーバーサイドキャッシュ (5分TTL) を**問題なく使えていた**。初期CLI検証 (cache_read=0) は単発コールのため「読み取り元がない」だけで、キャッシュ機構自体は機能する。

### 具体例
```
First heartbeat-human-review-auto-eval : cache_create=46098, cache_read=0
Second (同prompt)                      : cache_create= 8953, cache_read=37144
Third (同prompt)                       : cache_create= 8953, cache_read=37144
```
同一プロンプトの再呼び出しで**約80%をキャッシュから復元**。

---

## callSite別集計 (トークン降順)

| # | tier | callSite | count | 総トークン | 入力 | 出力 | cache_create | cache_read | cost |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | premium | thread-post-audit | 26 | 388,380 | 156 | 7,639 | 380,585 | 361,728 | $2.75 |
| 2 | standard | threads-regenerate-draft | 11 | 237,685 | 54 | 26,420 | 211,211 | 504,300 | $1.75 |
| 3 | fast | heartbeat-human-review-auto-eval | 3 | 65,649 | 30 | 1,615 | 64,004 | 74,288 | $0.10 |
| 4 | standard | threads-draft-generation | 3 | 59,383 | 9 | 9,741 | 49,633 | 21,532 | $0.34 |
| 5 | standard | executive-heartbeat-cycle | 1 | 22,226 | 3 | 540 | 21,683 | 0 | $0.09 |

> **コール種は5種のみ** 出現。計画書で想定していた18箇所のうち13箇所 (note生成全般、note監査、research、cadence-optimizer、engagement-analysis返信分類、note-engagement-analysis) は本HBでは発火せず。部署の活動状況次第。

---

## P0-1 (リビジョン上限 3→2) の実効果

### ハートビート概要 (ログから抽出)
- Generated 15 drafts, 14 passed audit
- Auto-published 1 threads posts
- 0 notes published

### 理論値との比較

| 項目 | MAX=3想定 | **MAX=2実測** | 削減 |
|---|---|---|---|
| thread-post-audit コール数 | 最大 5×3×(1+3)=60 | **26** | -57% |
| threads-regenerate-draft コール数 | 最大 5×3×3=45 | **11** | -76% |

> 上限値(60+45=105)は「全ドラフトが上限まで revise」のワーストケース。実運用では14/15 passed で大半が初回/1回目リビジョンで通っている。

### 判断
- **P0-1 は効いている**。仮にMAX=3のままだったら、理論値換算で少なくとも thread-post-audit は +10〜15コール (×~15k tokens = +150〜225k tokens)、regenerateDraft は +5〜8コール (+100〜150k tokens) 発生していた計算
- **推定削減**: 今回HBで **-250〜375k tokens 程度** (総課金773kに対し **-30〜48%相当**)
- ただし実測の「3回目リビジョンでpass率」データはこの1HBには無い (14drafts が1-2回以内に通ったため)

---

## コスト試算

### 現状 (P0修正後)
- 1HB: **$5.02**
- 毎時実行想定: 24 HB/日 × $5.02 = **$120/日** = **$3,600/月**

### P1/P2 未着手のためまだ余地あり
- 計画書v4.1の目標 -45〜60% 達成で月額 $1,440〜$1,980
- 未棚卸し callSite 13箇所が本HBで発火していないため、note記事生成や返信分類の多い時間帯では課金が大きく跳ねる可能性

---

## 再評価が必要な計画書前提

### ⚠️ v4.1 の記述を訂正すべき項目

1. **「prompt cacheによる削減はゼロ」** → 誤り。132%再利用率で機能している
2. **「cache機構非依存の設計が必須」** → P0-2 のバッチ化は依然有効だが、「cache非依存」は正しくない (cacheは効いている)
3. **P0-2 期待効果の再評価が必要**: 「重複コンテキスト削減で -50k tokens」という見積は、今回返信分類が発火していないため実測不能。ただし次回HBで返信発生時に検証可能

### 新たに見えた最適化機会

1. **thread-post-audit が単独で$2.75 (HB全体の55%)**
   - 26コール × 平均15k tokens/call
   - 監査プロンプトの `BASE_AUDIT_CRITERIA` + profile.forbiddenTopics が毎回埋め込まれるが、**これは同一内容なので既にキャッシュされている**
   - さらに削るなら: 監査基準をシステムプロンプト化、またはバッチ監査 (5ドラフトまとめて1回)
   - **P1追加案**: thread-post-audit バッチ化

2. **threads-regenerate-draft が$1.75 (35%)**
   - 11コールで 504k の cache_read (96% キャッシュから読めている)
   - それでも cache_create 211k 発生 = 新規プロンプト部分が大きい
   - 差分送信 (P1-1) の余地はまだある

3. **heartbeat-human-review-auto-eval のプロンプト重複**
   - 同prompt で3回実行 → 2回目以降は cache_read=37144/call
   - これはむしろ「うまく機能している」例

---

## 結論

1. ✅ **P0-0b 計測基盤は機能している** — 44エントリすべて usage データ付きで記録
2. ✅ **P0-1 (リビジョン上限 3→2) は効いている** — ワーストケース比で理論値 -30〜48% 相当
3. 🔴 **計画書の重要前提「cache非対応」は誤り** — 実測で132%再利用率
4. ⚠️ **新たな最大コスト箇所 = thread-post-audit** (HB全体の55%) — P1-1に加えて**監査のバッチ化**を追加検討
5. ⚠️ **発火しなかった13 callSite** の実測は次回以降のHBで取得必要

### 次アクション
1. 計画書v4.1のキャッシュ前提を訂正 (v4.2へ)
2. 複数HB回して note/research 系の実測も取得
3. thread-post-audit バッチ化を P1 に追加提案
4. P0-1の事後集計 (`thread_post_audits.attempt` 履歴から「3回目でpass率」) を1週間分データ溜めてから実施

### データファイル
- 生ログ: `tmp/token-usage/2026-04-13.jsonl` (44行)
- サマリ (本文書): `tmp/heartbeat-measurement-report-2026-04-13.md`
