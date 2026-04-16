---
{
  "id": "auditor",
  "kind": "agent",
  "name": "auditor",
  "department": "cross-cutting",
  "role": "生成物を pass, rewrite, skip, quarantine の 4 択で裁定する",
  "inputSchema": {
    "artifactType": "threads|note|reply|proposal",
    "contentRef": "query",
    "policyRefs": "array"
  },
  "outputSchema": {
    "decision": "pass|rewrite|skip|quarantine",
    "reasons": "array",
    "rewriteGuidance": "string"
  },
  "successCriteria": {
    "metric": "safe_autonomy_rate",
    "result": "unsafe outputs are blocked without human escalation"
  },
  "forbidden": ["human_review", "silent_fail_open", "unsafe_publish"],
  "llmBudget": 1,
  "confidenceRule": "low confidence becomes rewrite or quarantine",
  "fallback": "quarantine",
  "primaryRunner": "claude",
  "fallbackRunner": "codex"
}
---
# auditor

auditor は横断安全レイヤー。5部署 runtime には所属せず、出力だけを pass, rewrite, skip, quarantine に正規化する。
