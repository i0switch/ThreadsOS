# ThreadsOS マネタイズ修復計画 v1 (2026-04-14)

- 作成日: 2026-04-14
- 目的: note記事公開ゼロ・収益ゼロ・誤った人間レビュー止まりを解消
- 委譲方針: 本計画書 → Codex 監査 → 実装 → Codex 監査 → HB → 最終レポート

---

## 状況 (実測済)

| 指標 | 実態 |
|---|---|
| 公開済み note 記事 | **0件** |
| 累計収益 | **0円** |
| audited note drafts | 33件 (publish条件 score≥6 を満たすもの存在) |
| pending note slots (期限到来済) | 2件 (draft 有、audited 済、score=7) |
| nightly-note-pipeline failed回数 | 38/67 (57%) |
| Threads 投稿 | 57件、全て likes=0 imp=0 (計測不能状態) |
| 人間レビュー pending | 4件、うち妥当は1件のみ |

前回の hourly-heartbeat サマリ:
> `Generated 15 drafts, 15 passed audit. Auto-published 1 threads posts. **Auto-published 0 notes**`

→ `publishApprovedNoteDrafts` は呼ばれたが 0 件返却。eligibleSlots が空か、`publishArticle` が例外で全件 skip。

---

## 4 つの課題

### 課題A 【最優先・金に直結】: note 記事が1件も自動公開されていない
- `eligibleSlots` は全条件満たす (slot期限到来、draft audited、score=7)
- にもかかわらず `Auto-published 0 notes`
- 仮説:
  - (A1) Playwright 経由の `noteApi.publishArticle` が実行時エラー (storageState 切れ・UI変更・rate limit)
  - (A2) `reserveSlot` で lock に失敗している (並行実行問題)
  - (A3) `catch` で例外握りつぶし `results` に push していない
- 着手順:
  1. `publishArticle` の呼び出しを追いかけ例外ハンドリング経路を読む
  2. 直近のHB実行時の note 関連ログを再取得
  3. 原因特定後に修正

### 課題B: 禁止トピック判定が厳しすぎる
- 現状 `operator_profiles.forbidden_topics = ["性的な表現","効果保証","特定個人の誹謗中傷","医療的アドバイス"]`
- 2026-04-13 に「身体の関係を持ってから」で human_review 行き (ユーザー判断: これぐらいはOK)
- 修正案:
  - `forbidden_topics` の `"性的な表現"` を `"露骨な性行為描写・R18本編"` に書き換え (より具体化)
  - 以降は暗喩・比喩表現は通過させる
  - DB更新のみで完結、コード変更不要

### 課題C: LLM応答パース失敗が human_review に飛んでいる (2件)
- `adapters/llm/index.ts:200-208` の audit fallback で `verdict="human_review"` 固定
- ユーザー指摘「意味わからん」の中身 = ただのシステムエラーで人間止めるな
- 修正案:
  - fallback verdict を `"human_review"` → **`"revise"`** に変更 (reasons に "LLM応答パース失敗、再生成推奨" を残す)
  - revise なら `settleThreadDraft` の再生成ループで自動リトライされる
  - 3回連続で revise 判定が続いた場合のみ最終的に human_review へ (既存のリビジョン上限ロジックでカバー)

### 課題D: 低 score note draft が human_review に飛んでいる (1件)
- 現状: `note-audit/index.ts` で Score 5 以下相当を `verdict="human_review"` にしている可能性
- ユーザー意図: 自動で再監査・再生成ループで消化してほしい
- 修正案:
  - note-audit のfallback verdict も `"revise"` に変更
  - score が低い (<=4) は自動で再生成ループに
  - リビジョン上限 (P0-1で 2 に引き下げ済) を超えた場合のみ human_review

### 課題E (付随): Threads のエンゲージメント計測がゼロ
- 57投稿すべて likes/imp/replies=0
- 仮説: Threads API 計測エンドポイント呼び出しエラー、または metrics 保存失敗
- **本計画ではスコープ外**。課題A〜D完了後に別タスクで調査

### 課題F (付随): P1-C ロールバック済 (本日実施分)
- 既に完了。今回HBで再計測する対象

---

## 修正案 (優先度順)

### Fix-1 (課題A): note publish 失敗原因の特定と修正
- **調査**: `src/services/auto-publisher/index.ts:556-700` の `publishApprovedNoteDrafts` 本体と try/catch、`src/adapters/note-api/playwright-client.ts` の `publishArticle` 実装、logger.error が出す内容を精査
- **実装**:
  - try/catch で 握り潰してるなら `logger.error` + `outbound_notifications` に記録 + slot status を `failed` に変更 (同じ slot で無限リトライ回避)
  - Playwright storageState 切れなら `data/note-storage-state.json` の再取得を促す通知生成
- **副次対応**: 原因が認証切れの場合は `npm run note:login` を手動で走らせる案内

### Fix-2 (課題C,D): human_review fallback を revise に格下げ
- **対象1**: `src/adapters/llm/index.ts` の `ClaudeLlmClient.audit` (L200-208) と `HeartbeatLlmClient.audit` (同様箇所)
  - パース失敗時の fallback を `verdict: "human_review"` → `"revise"` へ
- **対象2**: `src/services/note-audit/index.ts` の fallback
  - 同様に `"revise"` へ格下げ (既存のリビジョンループで消化)
- **DB掃除**: 既存 `human_review_items.pending=4` のうち「LLM応答のパース失敗」「Score 5/10 要再監査」の3件を `status='auto_cleared'` に一括更新

### Fix-3 (課題B): 禁止トピック表記を具体化
- **DB更新**: `operator_profiles.forbidden_topics` の JSON 配列を
  - `["性的な表現", ...]` →
  - `["露骨な性行為描写・R18本編", "医療的アドバイス(具体的な診断・治療提案)", "特定個人の誹謗中傷", "効果保証(絶対/確定を伴う断定)"]`
- コード変更なし

### Fix-4 (課題E): スコープ外
- 今回は対応せず、完了後に別計画

---

## 実施フロー

```
① 本v1計画を Codex 監査
   ↓ OKなら
② Fix-1 調査 (publishArticle 経路読み、失敗原因特定)
   ↓ 原因判明後
③ Fix-1 実装 → Codex監査
   ↓
④ Fix-2 実装 → Codex監査
   ↓
⑤ Fix-3 (DB更新) → Codex監査
   ↓
⑥ HB実行 → 結果レポート
```

---

## 期待される結果

- note 記事が **少なくとも1件** 公開される (課題Aが解けた場合)
- human_review pending が **4件 → 1件以下** に
- Threads 監査で「身体の関係」級は revise/pass で通過し、人間止まり解消
- 収益 1000円到達への第一歩 (note 公開 1件 + 有料設定 → 1件でも売れれば)

---

## 未決事項 (Codex 監査で意見求む)

1. Fix-1 調査後の修正方針 (storageState 切れなら運用で解決可、コード変更必要性)
2. Fix-2 で `human_review` fallback を全廃するか、重大エラー (API quota 枯渇等) だけ残すか
3. Fix-3 の `forbidden_topics` 表現は厳しすぎ/ゆるすぎの感覚
4. 課題F (P1-C ロールバック後) の HB実測をこの計画のついでに取るか
