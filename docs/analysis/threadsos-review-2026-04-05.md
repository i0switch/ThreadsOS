# ThreadsOS レビューまとめ

## 結論
現状の ThreadsOS は、Threads と note の自動実行の骨格まではありますが、完全自動運用として見ると重要な断線が残っています。

特に大きいのは次の3点です。

- human review 承認後の下書きが公開フローへ戻れない
- Threads と note の改善ループが実測値ではなく空データや未取得データで回る
- 仕様上の既定運用と、実装・テスト・運用文書が一致していない

そのため、今の状態で本番運用すると、見た目は動いても改善判断が誤る、または承認済みコンテンツが詰まる可能性が高いです。

## 検証結果
- build: 通過
- test: 1件失敗
- lint: 失敗
- 静的な型崩れよりも、状態遷移と運用ロジックの不整合が主問題

## 重大な所見

### 1. human review 承認後のドラフトが公開されない
human review を承認すると、ドラフトの状態は approved に変わります。

- [src/cli/review-approve.ts](src/cli/review-approve.ts#L37)
- [src/cli/review-approve.ts](src/cli/review-approve.ts#L45)

一方で、公開スロット投入と自動公開は audited のドラフトしか扱いません。

- [src/services/content-scheduler/index.ts](src/services/content-scheduler/index.ts#L374)
- [src/services/content-scheduler/index.ts](src/services/content-scheduler/index.ts#L448)
- [src/services/auto-publisher/index.ts](src/services/auto-publisher/index.ts#L97)
- [src/services/auto-publisher/index.ts](src/services/auto-publisher/index.ts#L191)

つまり、高リスク判定で human review に回ったものは、承認しても公開経路に戻れません。

影響:
- 承認フローが実質的に行き止まり
- 運用上は承認済みなのに投稿されない
- 完全自動運用の前提を崩す

### 2. Threads の改善ループが実測値で回っていない
Threads 投稿直後に保存される結果データはゼロ埋めです。

- [src/services/auto-publisher/index.ts](src/services/auto-publisher/index.ts#L125)

その後の followup では返信分類と分析は呼ばれますが、投稿メトリクス自体を更新する処理は使われていません。

- [src/services/orchestration/index.ts](src/services/orchestration/index.ts#L335)
- [src/services/engagement-analysis/index.ts](src/services/engagement-analysis/index.ts#L356)

さらに、メトリクス更新用の処理自体は存在するのに参照されていません。

- [src/services/engagement-analysis/index.ts](src/services/engagement-analysis/index.ts#L40)

影響:
- 投稿頻度調整が誤る
- 勝ちパターン分析が実績ではなく空値ベースになる
- 自動最適化が成立しない

### 3. browser_assisted 前提の note 自動運用で、公開後分析が止まる
heartbeat は note 公開後に実績取得と改善生成を実行します。

- [src/jobs/hourly-heartbeat.ts](src/jobs/hourly-heartbeat.ts#L398)
- [src/jobs/hourly-heartbeat.ts](src/jobs/hourly-heartbeat.ts#L399)

しかし browser_assisted の Note API 実装は、記事一覧を空配列で返し、統計もゼロ固定です。

- [src/adapters/note-api/index.ts](src/adapters/note-api/index.ts#L487)
- [src/adapters/note-api/index.ts](src/adapters/note-api/index.ts#L491)

そのため note 側の実績蓄積と改善生成は、仕様上は存在していても実質動いていません。

関連仕様:
- [CLAUDE.md](CLAUDE.md#L121)
- [CLAUDE.md](CLAUDE.md#L125)
- [CLAUDE.md](CLAUDE.md#L131)

影響:
- note の投稿頻度調整ができない
- note の内容改善ができない
- 完全自動運用の中核が未接続

## 高優先度の所見

### 4. Threads トークン更新が同一実行内に反映されない
heartbeat の冒頭で環境変数を読み込み、API クライアントを作っています。

- [src/jobs/hourly-heartbeat.ts](src/jobs/hourly-heartbeat.ts#L41)
- [src/jobs/hourly-heartbeat.ts](src/jobs/hourly-heartbeat.ts#L44)

その後でトークン更新を行い、.env を直接書き換えています。

- [src/jobs/hourly-heartbeat.ts](src/jobs/hourly-heartbeat.ts#L206)
- [src/jobs/hourly-heartbeat.ts](src/jobs/hourly-heartbeat.ts#L234)

この順序だと、同じ heartbeat 実行中は更新後トークンを使いません。

影響:
- 更新成功直後の処理が古いトークンで走る
- 認証切れ時の復旧が1サイクル遅れる
- .env を実行中に直接更新する運用は壊れやすい

### 5. NOTE_MODE の既定値が仕様と不整合
実装の既定値は research_only です。

- [src/config/env.ts](src/config/env.ts#L37)

一方で、現在の仕様では browser_assisted が運用デフォルトです。

- [CLAUDE.md](CLAUDE.md#L125)
- [CLAUDE.md](CLAUDE.md#L131)

setup は browser_assisted を書き込みますが、未セットアップ状態やテストでは既定値が使われます。

- [src/cli/setup.ts](src/cli/setup.ts#L123)
- [src/jobs/hourly-heartbeat.ts](src/jobs/hourly-heartbeat.ts#L67)

この不整合はそのままテスト失敗として出ています。

- [tests/config.test.ts](tests/config.test.ts#L21)

影響:
- セットアップ前提が崩れると note 自動投稿が止まる
- テストと実運用想定が一致していない
- 既定動作に対する信頼性が低い

## 中優先度の所見

### 6. note の価格設定自動化は仕様上必須だが、業務フローに未実装
仕様では、価格設定は Claude が自律判断する前提です。

- [CLAUDE.md](CLAUDE.md#L79)
- [CLAUDE.md](CLAUDE.md#L106)
- [CLAUDE.md](CLAUDE.md#L130)

ただし実際の note 公開処理では、価格や有料境界の意思決定は渡していません。

- [src/services/auto-publisher/index.ts](src/services/auto-publisher/index.ts#L205)

価格関連の型や API 断片はありますが、ドメインモデルや生成フロー側に価格判断ロジックがありません。

- [src/domain/note/index.ts](src/domain/note/index.ts#L20)

影響:
- 自動投稿はあっても自動価格調整は未成立
- 仕様で求める収益最適化ループに未到達

### 7. runbook が現行仕様とずれている
runbook では cookie ベースの非公式 API が主系として読める内容です。

- [docs/runbook.md](docs/runbook.md#L74)
- [docs/runbook.md](docs/runbook.md#L77)
- [docs/runbook.md](docs/runbook.md#L78)

一方、現行仕様は Playwright による本番自動投稿を主前提にしています。

- [CLAUDE.md](CLAUDE.md#L125)

影響:
- 運用担当が誤った前提でトラブルシュートする
- 実装と運用手順が乖離する

## テスト・品質の状態

### テスト失敗
config テストで NOTE_MODE の期待値が実装・環境とずれています。

- [tests/config.test.ts](tests/config.test.ts#L21)
- [src/config/env.ts](src/config/env.ts#L37)

### lint 失敗
lint は主に整形と軽微ルール違反です。重大なロジック欠陥の直接原因ではありませんが、修正前に最低限そろえた方がよいです。

主な対象:
- [src/adapters/llm/index.ts](src/adapters/llm/index.ts)
- [src/adapters/note-research/index.ts](src/adapters/note-research/index.ts)
- [src/adapters/note-api/playwright-client.ts](src/adapters/note-api/playwright-client.ts)
- [src/cli/setup.ts](src/cli/setup.ts)

## 総評
ThreadsOS は、ジョブ実行基盤、LLM 経由の生成・監査、Threads 投稿、note 投稿、human review、分析ストレージといった必要部品はかなりそろっています。問題は、部品がつながるべき箇所で状態遷移とデータ接続が崩れていることです。

特に以下の順で直さないと、本番での完全自動運用は危険です。

1. human review 承認後に公開フローへ復帰できるよう状態遷移を統一する
2. Threads と note の分析ループを、実測値を読む形に修正する
3. NOTE_MODE と runbook とテストを、現行仕様に合わせて一本化する
4. note の価格設定ロジックをドメインモデルから実装する
5. トークン更新を .env 書き換え依存から外す

## 次の推奨対応
1. このレビュー内容をもとに、致命度順で修正タスクへ落とし込む
2. まずは human review 復帰不全と実測値未接続の2件を先に直す
3. その後に NOTE_MODE と runbook の整合を取る
4. 最後に価格設定自動化を追加する
