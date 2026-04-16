---
{
  "id": "safety",
  "kind": "policy",
  "name": "safety",
  "scope": "all_execution",
  "summary": "危険な出力は rewrite, skip, quarantine のいずれかに落とす",
  "rules": [
    "高リスク出力は quarantine",
    "軽微な違反は rewrite",
    "修復不能な案は skip"
  ],
  "thresholds": {
    "minConfidenceForAutoExecute": 0.7
  }
}
---
# safety

安全は横断レイヤー。human_review に逃がさず deterministic に停止、修正、隔離を行う。
