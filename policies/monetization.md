---
{
  "id": "monetization",
  "kind": "policy",
  "name": "monetization",
  "scope": "funnel",
  "summary": "収益を主目的にしつつ、代理指標は補助判断に使う",
  "rules": [
    "最終目的関数は revenue",
    "代理指標は tie-breaker として使う",
    "重みは固定値でコードに焼き込まない"
  ],
  "thresholds": {
    "proxyWeightReviewDays": 7
  }
}
---
# monetization

revenue を最上位に置き、purchases, note_views, note_clicks, profile_transitions を補助指標として扱う。
