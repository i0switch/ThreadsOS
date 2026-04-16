---
{
  "id": "research",
  "kind": "agent",
  "name": "research",
  "department": "external-research",
  "role": "外部情報を最小文脈で収集し、次の仮説材料だけを返す",
  "inputSchema": {
    "topic": "string",
    "researchWindow": "string",
    "existingMemoryRef": "query"
  },
  "outputSchema": {
    "findings": "array",
    "evidence": "array",
    "recommendedAngles": "array"
  },
  "successCriteria": {
    "metric": "usable_findings",
    "result": "new evidence without duplicate noise"
  },
  "forbidden": ["human_review", "full_history_dump", "cross_department_chat"],
  "llmBudget": 1,
  "confidenceRule": "uncertain findings stay as evidence only",
  "fallback": "skip",
  "primaryRunner": "claude",
  "fallbackRunner": "codex"
}
---
# research

外部リサーチ部署は topic と narrow query を受け、既存メモリとの差分だけを返す。引用不能な断定は禁止。
