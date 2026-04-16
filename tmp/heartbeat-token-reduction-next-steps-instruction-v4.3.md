# ハートビート トークン削減 次アクション指示書 v4.3

- 作成日: 2026-04-13
- 前提: `thread-post-audit` のバッチ監査実装は入った
- 現状: まだ「削減達成」ではなく、**実装土台完成段階**

---

## 目的

次の3点を片付けて、P1-A を「実装した」から「効果確認まで終わった」に進める。

1. バッチサイズ無制限のリスクを消す
2. 計測ログで単発監査とバッチ監査を区別できるようにする
3. 実測で削減効果を確認する

---

## 最優先タスク

### Task 1: バッチサイズ上限を入れる

目的:
- 15件全投入の巨大プロンプトを防ぐ
- LLMの JSON 配列パース精度低下を防ぐ
- v4.3 計画書の「5件バッチ」に実装を揃える

対象ファイル:
- `src/services/post-audit/index.ts`
- 必要なら `src/services/orchestration/index.ts`

やること:
1. `BATCH_SIZE = 5` を定数化
2. `auditDraftsBatch()` 内で `draftIds` を 5件ずつ chunk する
3. chunk ごとに LLM を呼ぶ
4. 各 chunk の結果を `Map<string, ThreadPostAudit>` にマージする
5. フォールバックは今のまま維持する

完了条件:
- N件ドラフトなら `thread-post-audit-batch` が `Math.ceil(N/5)` 回呼ばれる
- `N=1, 4, 5, 6, 15` の5ケースで挙動確認する
- 既存テストが落ちない
- `tests/reexecution-safe.test.ts` が通る

注意:
- chunk は `post-audit` 側で閉じる方が安全
- `orchestration` 側まで chunk ロジックを持ち込まない

---

### Task 2: label を単発監査と分ける

目的:
- `tmp/token-usage/*.jsonl` で単発版とバッチ版の区別をつける
- 実測時に「何が減ったか」を追えるようにする
- POC期間中に単発版とバッチ版が並走しても、コスト追跡とフォールバック発生頻度を観測できるようにする

対象ファイル:
- `src/services/post-audit/index.ts`

やること:
1. 単発監査は現状どおり `thread-post-audit`
2. バッチ監査は `thread-post-audit-batch` に変更
3. フォールバックで単発に落ちた場合は `thread-post-audit` で記録される状態を維持

完了条件:
- jsonl 上で `thread-post-audit`
- `thread-post-audit-batch`

この2つが分かれて見える

---

### Task 3: P1-A POC をやる

目的:
- バッチ監査で品質が落ちてないかを先に確認する
- 「速くなったけど判定が雑になった」を防ぐ

対象:
- `thread-post-audit`

比較方法:
1. 既存 `thread_post_drafts` テーブルから比較対象を N=30〜50 件サンプリングする
   - 優先: `status='audited'`
   - 足りなければ `draft` も含める
2. 単発監査で結果を取る
3. バッチ監査で結果を取る
4. 以下を比較する

判定基準:
- `verdict` 一致率 90%以上
- `severity` 一致率 85%以上
- `score` 絶対差中央値 1以下
- `reasons/suggestions` の平均項目数差分 ±1 以内

完了条件:
- 上の3指標を表にして残す
- 合格 or 要修正を明示する

DB副作用対策:
- POC実施時は production 相当の監査履歴を汚さないこと
- 優先案:
  1. `saveAuditResult()` を通さない POC専用の dry-run 経路を一時追加
  2. それが難しければ、POC対象 `draftId` を控えたうえで実行後に `thread_post_audits` / `human_review_items` の該当レコードを削除する

不合格時の分岐:
- `verdict` 一致率 90% 未満なら Task 4 は中止
- `runDailyThreadsPlan()` は単発版フローに戻す
- 原因を「バッチサイズ」「プロンプト設計」「JSON形式」の3観点で切り分けて別タスク化する

保存先候補:
- `tmp/heartbeat-token-reduction-p1a-poc-2026-04-13.md`

---

### Task 4: 本番1HBを再測定する

目的:
- 実装後の本当の削減率を取る
- v4.3 の `-31%` 見積もりに対して、実績を確認する

やること:
1. バッチサイズ上限 + label分離後の状態で 1HB 実行
2. `tmp/token-usage/YYYY-MM-DD.jsonl` を取得
3. 次を比較する

比較対象:
- 修正前: `tmp/token-usage/2026-04-13.jsonl`
- 修正後: 新しい jsonl

実行前確認:
1. `LLM_MODE=heartbeat` になっていること
2. Anthropic usage 残量を確認すること

見る指標:
- `thread-post-audit` の件数
- `thread-post-audit-batch` の件数
- `thread-post-audit` 系合計 cost
- `thread-post-audit` 系 `cost ÷ 処理ドラフト数` の正規化値
- cacheCreationTokens
- cacheReadTokens
- HB全体 cost は参考値として併記

評価ルール:
- hourly-heartbeat は部署活動状況で内容が揺れるため、完全同条件比較はできない
- 主指標は **`thread-post-audit` 系 cost ÷ ドラフト数** にする
- HB全体 cost は傾向確認用の参考値として扱う

完了条件:
- before / after の比較表を作る
- 「`thread-post-audit` 系 cost ÷ ドラフト数` が何%減ったか」を数値で出す
- HB全体 cost については「参考値」と明記して併記する

保存先候補:
- `tmp/heartbeat-token-reduction-measurement-after-p1a.md`

---

## 優先順位

順番はこれで固定でいい。

1. `BATCH_SIZE=5` 導入
2. label を `thread-post-audit-batch` に分離
3. P1-A POC 実施
4. 本番1HB再測定
5. 結果レポート作成

---

## 今はやらないこと

以下はまだ後でいい。

- `note-audit` のバッチ化
- `P1-B0` 指摘位置の構造化
- `P1-B` regenerateDraft 差分送信
- `P1-C` プロンプト先頭固定化
- `P1-D-EXP` TTL測定ハーネス
- `P2-B` ダッシュボード

理由:
- 先に P1-A の実効果と品質を確定しないと、次の優先順位がブレるから

---

## 完了時に残すべき成果物

最低でもこの2つは残す。

1. POC結果レポート
2. 1HB再測定レポート

推奨ファイル名:
- `tmp/heartbeat-token-reduction-p1a-poc-YYYY-MM-DD.md`
- `tmp/heartbeat-token-reduction-measurement-after-p1a-YYYY-MM-DD.md`

---

## 一言でいうと

次にやることは、

**5件バッチに直す → 計測ラベルを分ける → 品質比較する → 1HB実測する**

これだけでいい。
