---
{
  "id": "note",
  "kind": "agent",
  "name": "note",
  "department": "note",
  "role": "Read と Buy を改善する note 記事案を返す",
  "inputSchema": {
    "bottleneck": "Read|Buy",
    "pricingPolicyRef": "query",
    "winningPatternsRef": "query",
    "outlineRef": "query"
  },
  "outputSchema": {
    "draft": "object",
    "titleOptions": "array",
    "offerPlan": "array"
  },
  "successCriteria": {
    "metric": "note_views|purchases|revenue",
    "result": "publish-ready article draft"
  },
  "forbidden": ["human_review", "manual_relogin_dependency", "db_direct_write"],
  "llmBudget": 1,
  "confidenceRule": "weak article sections trigger rewrite, risky monetization skips",
  "fallback": "rewrite",
  "primaryRunner": "claude",
  "fallbackRunner": "codex"
}
---
# note

note 運用部署は記事構成、タイトル、導線、価格文脈を返す。session 異常時は publish せず Threads-only に退避する。
