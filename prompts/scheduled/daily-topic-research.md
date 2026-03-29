# Daily Topic Research

## Goal
今日の Threads -> note 導線に使える有望トピックを選定する。

## Inputs
- `CLAUDE.md`
- `docs/architecture.md`
- `docs/progress.md`
- 直近7日分の `docs/analysis/`
- 直近7日分の `docs/research/`
- 利用可能なら関連 connectors の読み取り結果

## Steps
1. 既存の勝ちパターンと失敗パターンを確認する
2. 今日狙うべきトピック候補を10件出す
3. 各候補について以下を整理する
   - 想定読者
   - 悩み
   - Threadsでのフック
   - noteへ展開する理由
   - リスク
4. 上位3件を選び、採用理由を明記する
5. 結果を `docs/research/daily-topic-research-YYYY-MM-DD.md` に保存する
6. `docs/progress.md` に要約を1段落追記する

## Deliverables
- daily topic research file
- top 3 priority topics
- recommended angle for today

## Prohibited
- そのまま投稿しない
- 根拠のない断定をしない
- 既存テーマの焼き直しを雑に増やさない

## Human Review Conditions
- 高リスクなテーマ
- 規約グレーなテーマ
- 強い収益断定を伴うテーマ
