# Daily Threads Plan

## Goal
今日の Threads 投稿候補を作り、監査し、投稿キューに入れる。

## Inputs
- `CLAUDE.md`
- 当日分の `docs/research/daily-topic-research-YYYY-MM-DD.md`
- 直近の `docs/analysis/`
- 既存 draft / audit データ

## Steps
1. 上位3テーマから投稿候補を最低5本作る
2. 各候補に対して
   - audience
   - hook type
   - CTA type
   - note transition hypothesis
   - risk note
   を付与する
3. 候補を監査する
4. `pass / revise / reject` を付ける
5. `pass` のみを投稿キュー候補として保存する
6. 必要なら dry-run publish command を提案する
7. 結果を以下に保存する
   - drafts: `data/threads/drafts/YYYY-MM-DD/`
   - audits: `data/threads/audits/YYYY-MM-DD/`
   - summary: `docs/operations/daily-threads-plan-YYYY-MM-DD.md`

## Deliverables
- 5本以上の draft
- 各 draft の audit
- publish candidate list
- top 2 recommended posts

## Prohibited
- unaudited draft を publish しない
- note導線を露骨にしすぎない
- 同じ訴求をほぼ同文で量産しない

## Human Review Conditions
- `severity=high`
- 炎上 / 誤情報 / 攻撃性リスク
- 断定的な収益訴求
