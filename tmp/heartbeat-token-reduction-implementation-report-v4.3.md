# ハートビート トークン削減 実装レポート v4.3

- 作成日時: 2026-04-13 21:41:58
- 対象計画: `tmp/heartbeat-token-reduction-plan-v4.3.md`
- 今回の実装範囲: **P1-A の最小安全版**
- 実装者メモ: レポート改訂ではなく、アプリ本体に変更を入れた結果の記録

---

## 今回やったこと

### 1. `thread-post-audit` のバッチ監査を実装

対象:
- `src/services/post-audit/index.ts`

追加内容:
- `PostAuditService` に `auditDraftsBatch(draftIds, llm)` を追加
- 複数ドラフトを1回の `llm.generate()` でまとめて監査する処理を追加
- 返却形式は `Map<draftId, ThreadPostAudit>`
- バッチ結果を既存の監査保存処理に流し込めるよう、`saveAuditResult()` を共通化

維持した挙動:
- `thread_post_audits` への insert/update
- `thread_post_drafts.status` 更新
- `human_review_items` の起票・再承認
- 既存の単発 `auditDraft()` もそのまま使用可能

安全策:
- バッチ結果に特定ドラフトの結果が欠けていた場合、そのドラフトだけ単発 `auditDraft()` にフォールバック

### 2. Threads 日次プランをバッチ監査フローに切替

対象:
- `src/services/orchestration/index.ts`

追加内容:
- `settleThreadDraftsBatch()` を追加
- `runDailyThreadsPlan()` 内で、生成したドラフト群をまとめて監査するよう変更

新しい流れ:
1. ドラフト群をまとめて監査
2. `verdict === "revise"` のものだけ再生成
3. 再生成分を次ラウンドで再度まとめて監査
4. `MAX_THREAD_REVISION_ATTEMPTS = 2` の範囲で繰り返し

この変更で、少なくとも Threads 日次生成経路では `thread-post-audit` のコール回数をまとめられる土台が入った。

### 3. 回帰テストを追加

対象:
- `tests/reexecution-safe.test.ts`

追加内容:
- `auditDraftsBatch()` がドラフトごとの監査保存と human review 起票を壊していないことを確認するテスト
- `runDailyThreadsPlan()` がバッチ監査経路でも revise → regenerate → pass の流れを維持することを確認するモック更新

---

## 変更ファイル

- `src/services/post-audit/index.ts`
- `src/services/orchestration/index.ts`
- `tests/reexecution-safe.test.ts`

---

## 検証結果

実行コマンド:

```powershell
pnpm vitest run tests/reexecution-safe.test.ts
pnpm biome check src/services/post-audit/index.ts tests/reexecution-safe.test.ts
```

結果:
- `vitest`: **17/17 passed**
- `biome`: 対象2ファイルは **エラーなし**

補足:
- `src/services/orchestration/index.ts` 全体に対する `biome check` は、このファイルに既存の未整形差分が広く残っているため未収束
- 今回の実装自体はテスト通過済みで、追加した `orchestration` ロジックも実行確認できている

---

## 計画に対して何が進んだか

`tmp/heartbeat-token-reduction-plan-v4.3.md` 기준でいうと、今回進んだのは以下。

- **P1-A**
  - 完了したもの:
    - バッチ監査 API の追加
    - Threads 日次生成フローへの組み込み
    - 既存DB副作用の維持
  - まだ未着手:
    - 50ドラフト精度比較の POC
    - 実測 3〜5HB 追加取得
    - `DepartmentExecutionService` など他経路への水平展開
    - 実コスト削減率の再計測

- **P1-B / P1-B0**
  - 未着手
  - 指摘位置の構造化、差分送信はまだ入れていない

- **P1-C**
  - 未着手
  - プロンプト先頭固定化は今回まだやっていない

- **P1-D-EXP**
  - 未着手
  - TTL 測定用ハーネス `scripts/ttl-probe.ts` はまだ作っていない

---

## 期待できる効果

今回の変更だけでは、まだ v4.3 に書いた削減率を断定できない。

言えること:
- `runDailyThreadsPlan()` の Threads 監査は、単発監査の直列ループから、バッチ監査ベースのループに変わった
- そのため `thread-post-audit` のコール数削減に向かう実装土台は入った
- ただし、**何%減ったかは未計測**

まだ言えないこと:
- HB全体で -31% になる
- 月額がいくら下がる
- バッチ監査でも単発監査と同等品質が出る

この3つは次の実測が必要。

---

## 残る制約

1. 今回のバッチ監査導入先は、まず `runDailyThreadsPlan()` 経路のみ
2. 監査品質はまだ POC 未実施
3. コスト削減率は未計測
4. `orchestration/index.ts` には今回変更以外の既存未コミット差分が混在しているため、次の作業でも差分の見分けに注意が必要

---

## 次にやるべきこと

優先順:

1. `runDailyThreadsPlan()` を含むハートビートを1本回して、`tmp/token-usage/*.jsonl` で `thread-post-audit` の実コール数とコストを再測定
2. P1-A POC として、単発監査とバッチ監査の `verdict` 一致率を比較
3. 問題なければ、同じバッチ監査方式を他の Threads 系経路にも広げる
4. その後に `P1-C`、必要なら `P1-B0` へ進む

---

## 結論

今回は「レポートに従ってアプリを改善して」という依頼に対して、`thread-post-audit` バッチ化の最小安全版を実装した。

つまり、
- 計画だけの状態から
- 実際にコードがバッチ監査を使う状態へ

一段進んだ。

まだ「削減達成済み」とは言えないけど、少なくとも **次の測定で効果を確認できる実装状態** には入ってる。
