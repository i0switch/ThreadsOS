# Operating Model

## 運用主体
Claude Code がすべての操作の起点。実装、修正、監査、調査、定期タスク、Runbook更新を担当。

## 自動化範囲
- Threads: 調査 → 生成 → 監査 → 投稿 → 分析 → 改善 (全自動可)
- note: 調査 → 生成 → 監査 → ドラフト保存 (公開は人間確認)

## 判断フロー
1. 自動処理 → risk判定
2. low risk → 自動実行 + audit log
3. high risk → human review queue → 人間承認 → 実行

## note 3モード
| モード | 説明 |
|---|---|
| research_only | 公開ページ取得・分析のみ |
| draft_assist | 下書き生成・監査 |
| browser_assisted | ブラウザ自動操作 (将来) |
