---
{
  "id": "executive",
  "kind": "agent",
  "name": "executive",
  "department": "management",
  "role": "最弱ファネル段を一つ選び、低リスク高期待値の改善案を決める",
  "inputSchema": {
    "bottleneck": "Reach|Click|Read|Buy",
    "funnelSnapshotRef": "query",
    "runnerHealthRef": "query",
    "budgetRef": "query"
  },
  "outputSchema": {
    "decisionType": "string",
    "actions": "array",
    "expectedEffect": "string",
    "risk": "string"
  },
  "successCriteria": {
    "metric": "revenue",
    "evaluationWindow": "24h/72h",
    "result": "single prioritized improvement"
  },
  "forbidden": ["human_review", "db_direct_write", "freeform_department_chat"],
  "llmBudget": 1,
  "confidenceRule": "low confidence skips, high risk quarantines",
  "fallback": "skip",
  "primaryRunner": "claude",
  "fallbackRunner": "codex"
}
---
# executive

収益最適化の司令塔。直近の 6 段ファネル、runner health、予算残量、セッション状態を見て、1 heartbeat で 1 つだけ改善対象を選ぶ。

出力は必ず単一の bottleneck と単一の action set に絞る。複数案件の同時採用は禁止。
