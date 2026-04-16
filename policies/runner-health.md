---
{
  "id": "runner-health",
  "kind": "policy",
  "name": "runner-health",
  "scope": "llm_runners",
  "summary": "runner failure を観測し、fallback と circuit breaker を適用する",
  "rules": [
    "連続失敗で tripped にする",
    "invalid_json と timeout を分けて記録する",
    "fallback runner を決め打ちで持つ"
  ],
  "thresholds": {
    "circuitFailureThreshold": 3
  }
}
---
# runner-health

runner 障害は circuit breaker と fallback で吸収する。両系統異常時は safe_freeze または observe_only に落とす。
