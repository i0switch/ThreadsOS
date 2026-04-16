# ハートビート トークン削減計画 v4.2 (実測ベース改訂版)

- 作成日: 2026-04-13
- 計測根拠: `tmp/heartbeat-measurement-report-2026-04-13.md` (1HB実測、44LLMコール)
- 前版: `tmp/heartbeat-token-reduction-plan-v4.1.md` (実測前の想定ベース、要訂正)

---

## v4.2 で訂正する前版の誤り

| v4.1 の前提 | 実測で判明した事実 |
|---|---|
| 「spawnSync で毎回新プロセス → cache ヒット不可」 | **誤り**。Anthropic サーバー側 cache (5分TTL) が有効。再利用率 **132%** |
| 「cache機構非依存の設計が必須」 | cache は効く。ただし **5分TTL と HB間隔の整合** が新論点 |
| 「最大コスト箇所は Executive プロンプト or 返信分類」 | **誤り**。実測では **thread-post-audit が単独で HB コストの 55%** |
| 「コール数削減が主戦術」 | コール数削減は有効だが、**プロンプト先頭固定化による cache 再利用最大化** が同等以上に重要 |

---

## 実測で見えた新しいコスト構造 (1HB)

| callSite | % of cost | コール数 | 平均トークン | 備考 |
|---|---:|---:|---:|---|
| **thread-post-audit** | **55%** | 26 | 14,938 | premium tier / 監査基準の固定部大 |
| **threads-regenerate-draft** | **35%** | 11 | 21,608 | standard / cache_read 96% 効いている |
| heartbeat-human-review-auto-eval | 2% | 3 | 21,883 | fast / 2回目以降 cache 80%復元 |
| threads-draft-generation | 7% | 3 | 19,794 | standard |
| executive-heartbeat-cycle | 2% | 1 | 22,226 | standard / cache_read=0 (先頭コール) |

### 未発火の 13 callSite
note生成系 (6箇所) / research系 (2) / cadence-optimizer / engagement-analysis返信分類 / note-engagement-analysis (2) / etc.
→ P2として継続計測。活動状況次第でコスト構造が変動する可能性あり。

---

## 改訂後の最適化戦術

### 2軸の戦略

**軸1: コール数削減** (従来P0-1の延長)
**軸2: プロンプト先頭固定化による cache 最大再利用** (v4.1で見逃していた軸)

両方を組み合わせる。

---

## P1 改訂版 (実測ベースで優先度再決定)

### P1-A 【最優先・最大コスパ】: thread-post-audit バッチ化

**根拠**: 実測で HB コストの 55% を単独で占める

- **対象**: `src/services/post-audit/index.ts:58` (`llm.audit`) + 呼び出し元 `orchestration/index.ts:settleThreadDraft`
- **修正方針**:
  1. `auditDraft` を単発から **5ドラフトバッチ** に変更
  2. `BASE_AUDIT_CRITERIA + profile.forbiddenTopics + profile.tone` をプロンプト先頭に1回だけ (cache対象化)
  3. 各ドラフトは `draftId + body` のリストで末尾に配置
  4. JSON配列で `{ draftId, verdict, severity, reasons, suggestions, score }` を返させる
  5. リビジョンループは従来どおり (ただし再監査もバッチ化可)
- **期待効果**:
  - コール数: 26 → **4-5 (-80%)**
  - cache_create: 380k → **~80k (監査基準が1回のみcreate)**
  - HBコスト: $2.75 → **~$0.6 (-79%)**
  - **HB全体で -43%** (単独修正としては最大)
- **リスク**: バッチで監査精度が下がる可能性 → 修正前後で `verdict` 分布をA/B (本番2HB比較)

### P1-B: threads-regenerate-draft 差分送信 + system prompt化

**根拠**: 実測で HB コストの 35%、cache_create が毎回 ~19k 発生

- **対象**: `src/services/post-generation/index.ts:180-207`
- **修正方針**:
  1. 初回は全文、2回目以降は **監査指摘箇所 + 修正対象段落のみ** を diff 形式で渡す
  2. `profileSection` をプロンプト先頭に固定配置 (cache対象化)
  3. feedback 部分を末尾配置 (可変部分)
- **期待効果**:
  - cache_create 211k → **~80k**
  - HBコスト: $1.75 → **~$1.0 (-43%)**
  - **HB全体で -15%**
- **リスク**: 差分送信で再生成品質が落ちる可能性

### P1-C: プロンプト先頭固定化 (全 callSite 横断)

**根拠**: cache は効くが「プロンプト先頭が同一」が条件。現状はコンテキスト埋め込み順が場当たり的

- **対象**: 全 18 callSite (まずは上位コスト 5 箇所)
- **修正方針**:
  1. 各プロンプトを `[固定ヘッダ][共有コンテキスト][可変入力]` の3層構造に統一
  2. `[固定ヘッダ]` に: 判断原則、JSON回答形式、選択肢リスト等
  3. `[共有コンテキスト]` に: ハートビート内で共通の profile / policy / competitor summary
  4. `[可変入力]` に: 個別ドラフトや個別返信
- **期待効果**: cache_read が 961k → 1.3M+ に増加 (実効課金を 20〜30% 削減)
- **リスク**: プロンプト構造変更で LLM 挙動が微妙に変わる可能性 → 順次A/B

### P1-D: HB間隔と 5分TTL の整合

**根拠**: 現状 hourly = 60分間隔 → HB間で cache 全損

- **現状確認**: HB内コール (19分)では cache 効果大 (961k read)、HB間では全消失
- **選択肢**:
  | 案 | メリット | デメリット |
  |---|---|---|
  | (a) HB頻度上げ (5分〜10分ごと) | cache 継続 | 発行リクエスト数増、書き込み系が重複 |
  | (b) 現状維持 | 変更なし | HB間 cache 無し |
  | (c) 「軽HB」を5分ごと、「重HB」を1時間ごとに分離 | cache 維持しつつ負荷分散 | 設計複雑化 |
- **推奨**: **(c) の軽HB導入を検討**。具体的には「Executive判断 + 軽いcontext refresh」を5分ごとに走らせ、生成系は従来通り1時間
- **実験タスク**: 意図的に 10分間隔でHB 2本回して cache miss を観測し、TTL境界を実測する

---

## P2 (計測継続 + 追加最適化)

### P2-A: 未発火 13 callSite の計測
- 1週間HB回して jsonl を溜める
- 特に note生成 / research / engagement-analysis返信分類 の実コストを把握
- 現状推定: note生成発火時は +$3〜5/HB、返信10件以上時は +$1/HB 程度

### P2-B: 集計ダッシュボード
- `scripts/token-usage-analyze.ts` (or dashboard) で以下を自動集計:
  - 日次 / HB毎のトークン推移
  - callSite別コスト
  - **tier (premium/standard/fast) 別コスト比率** (監査者の提案)
  - cache_read / cache_create 比率の経時変化
  - コスト異常時のアラート

### P2-C: cache 内訳分析
- regenerateDraft の cache_read=504k のうち、どの部分が既存body/systemPromptかを詳細計測
- 方法: 同一draft再生成時の cache_read 推移を見る、prompt分解してログ
- P1-B の差分送信設計を精緻化するための基礎データ

### P2-D: 競合スナップショット削減 (旧P2-1)
- `src/services/research/index.ts:341-343` の20件×500文字プロンプト
- 今回HB では未発火のため実測未取得
- 発火時に再計測して判断

---

## 削減見込み (実測ベース)

### 単独効果
| 項目 | HB内コスト削減 | HBコスト絶対値 |
|---|---|---|
| P1-A thread-post-audit バッチ化 | -43% | $5.02 → $2.86 |
| P1-B regenerateDraft 差分送信 | -15% | $5.02 → $4.27 |
| P1-C プロンプト先頭固定化 | -20〜30% | $5.02 → $3.5〜4.0 |

### 組合せ効果 (P1全完了 + キャッシュ最大化)
- HBコスト: $5.02 → **$1.5〜2.0 (-60〜70%)**
- 月額: $3,600 → **$1,080〜1,440**
- 計画書v4.1の目標 -45〜60% を**超過達成見込み**

---

## 着手順 (v4.2)

```
P1-A thread-post-audit バッチ化        ← 最優先。単独で -43%
   ↓ (1HB実測で効果検証)
P1-C プロンプト先頭固定化 (上位5箇所)  ← P1-Aと相性良い
   ↓ (1HB実測)
P1-B regenerateDraft 差分送信
   ↓
P1-D 軽HB/重HB分離 検討
   ↓
P2 (計測継続・未発火callSite対応)
```

**原則**: 各P1完了ごとに1HB回して `tmp/token-usage/*.jsonl` を取得、効果を実測で検証。

---

## 着手前の追加実験 (監査者提案)

1. **5分TTL境界の実測**
   - 5分、7分、10分間隔でHBを連続3本回す
   - cache_read が減るタイミングを特定
   - P1-D の「軽HB頻度」決定根拠

2. **tier別コスト内訳の再集計**
   - 現状 `premium` ($2.75 / 1tier) が 55%、`standard` 40%、`fast` 5%
   - premium単価はstandardの2〜3倍想定 → tier変更だけで削減可能か検討
   - 特に `thread-post-audit` を premium→standard に変更で品質劣化しないかA/B

3. **thread-post-audit バッチ化の最小POC**
   - 5ドラフト監査バッチ版プロンプトを1回叩いて JSON精度を確認
   - 本実装前に精度劣化リスクを見極め

---

## 残リスク

- **P1-A で監査精度劣化**: 5件まとめて判定させるとLLMが混線する可能性。POC必須
- **P1-C でプロンプト構造変更による挙動変化**: 既存のfew-shotや指示順に依存している箇所がある可能性
- **P1-D の軽HB/重HB分離**: 部署活動のタイミング設計が複雑化、副作用検証が必要
- **計測1HBのみ**: note/research系が未発火のため、本計画は「thread系が発火する標準HB」に最適化されている。他HBパターンでは優先度が変わる可能性

---

## 次アクション

1. 本 v4.2 をユーザー承認 → GOで **P1-A POC** から着手
2. POC で精度担保確認 → 本実装 → 1HB実測 → 次P1へ
3. 週次で `tmp/token-usage/*.jsonl` を集計 (P2-B のダッシュボード化前倒し可)
4. 未発火 callSite の発生を待って順次データ取得
