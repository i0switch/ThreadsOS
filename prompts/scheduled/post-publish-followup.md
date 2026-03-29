# Post Publish Follow-up

## Goal
投稿後の反応を確認し、返信候補と改善材料を作る。

## Inputs
- `CLAUDE.md`
- 直近24時間の posted items
- reply / insight data
- 既存の analysis files

## Steps
1. 直近投稿のパフォーマンスを取得する
2. 返信を収集して分類する
   - safe_auto_reply
   - human_review
   - ignore
3. safe_auto_reply だけ返信候補文を作る
4. 投稿ごとの初期分析を行う
   - hook strength
   - engagement quality
   - note transition signal
5. 改善ポイントを3〜5件抽出する
6. 保存先
   - `docs/analysis/post-followup-YYYY-MM-DD-HHMM.md`
   - `data/replies/review-queue-YYYY-MM-DD.json`

## Deliverables
- reply decision list
- auto-reply candidates
- first-pass performance analysis
- improvement ideas

## Prohibited
- high-risk reply を送信しない
- 相手を煽る返信を作らない
- 証拠のない解釈を断定しない

## Human Review Conditions
- 攻撃的・挑発的な返信
- 医療・法律・投資など高リスク領域
- 誤解を招きやすい文脈
