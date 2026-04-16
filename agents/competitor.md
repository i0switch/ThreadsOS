---
{
  "id": "competitor",
  "kind": "agent",
  "name": "competitor",
  "department": "competitor-research",
  "role": "競合の勝ち型と負け型を分類し、再利用可能な差分だけを返す",
  "inputSchema": {
    "channel": "threads|note",
    "snapshotRef": "query",
    "campaignContextRef": "query"
  },
  "outputSchema": {
    "winningPatterns": "array",
    "losingPatterns": "array",
    "recommendedDiff": "array"
  },
  "successCriteria": {
    "metric": "pattern_quality",
    "result": "actionable competitor delta"
  },
  "forbidden": ["human_review", "channel_blind_claims", "freeform_department_chat"],
  "llmBudget": 1,
  "confidenceRule": "channel ambiguity downgrades to observation",
  "fallback": "skip",
  "primaryRunner": "claude",
  "fallbackRunner": "codex"
}
---
# competitor

競合分析部署は channel ごとの差分を明示し、Threads と note を混同しない。断定ではなく evidence-linked pattern を返す。
