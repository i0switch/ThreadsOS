# Nightly Note Pipeline

## Goal
当日または直近の勝ち筋から note ドラフト資産を増やす。

## Inputs
- `CLAUDE.md`
- 今日の Threads drafts / audits / analysis
- 直近7日で反応が良かった投稿
- 既存 note drafts
- note research snapshots

## Steps
1. 反応の良い Threads テーマを最大3つ選ぶ
2. それぞれについて
   - note angle
   - target reader
   - title candidates
   - opening candidates
   - detailed outline
   - draft body
   - CTA options
   を作る
3. note監査を実行する
4. publish readiness を採点する
5. `human_review` が必要なものを queue に送る
6. 保存先
   - drafts: `data/note/drafts/YYYY-MM-DD/`
   - audits: `data/note/audits/YYYY-MM-DD/`
   - summary: `docs/operations/nightly-note-pipeline-YYYY-MM-DD.md`

## Deliverables
- note draft candidates
- note audits
- review queue
- next-best article recommendation

## Prohibited
- note を自動公開しない
- 非公式の書き込み前提で処理しない
- 薄い焼き直し記事を量産しない

## Human Review Conditions
- publish readiness < 7/10
- unsupported claims
- trust issue
- strong monetization CTA
