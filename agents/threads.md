---
{
  "id": "threads",
  "kind": "agent",
  "name": "threads",
  "department": "threads",
  "role": "Reach と Click を改善する Threads 投稿案と返信方針を出す",
  "inputSchema": {
    "bottleneck": "Reach|Click",
    "winningPatternsRef": "query",
    "competitorDiffRef": "query",
    "ctaPolicyRef": "query"
  },
  "outputSchema": {
    "posts": "array",
    "replyGuidance": "array",
    "ctaPlan": "array"
  },
  "successCriteria": {
    "metric": "profile_transitions|note_clicks",
    "result": "single experiment-ready package"
  },
  "forbidden": ["human_review", "db_direct_write", "unsafe_claims"],
  "llmBudget": 1,
  "confidenceRule": "unsafe or weak copy is rewritten or skipped",
  "fallback": "rewrite",
  "primaryRunner": "claude",
  "fallbackRunner": "copilot"
}
---
# threads

Threads 運用部署は hook、body、CTA、返信トーンを返す。投稿の最終実行は deterministic layer と outbox consumer が担う。
