---
{
  "id": "reply-policy",
  "kind": "playbook",
  "name": "reply-policy",
  "owner": "threads",
  "purpose": "返信生成の安全方針を定義する",
  "inputs": ["reply_text", "brand_policy", "risk_signals"],
  "outputs": ["reply_decision", "reply_text"],
  "steps": ["classify_risk", "allow_safe_reply", "rewrite_or_quarantine_if_needed"],
  "successCriteria": {
    "result": "safe reply only"
  }
}
---
# reply-policy

返信は safe_auto_reply のみ outbox に進める。攻撃的、法務、医療、投資などの高リスク領域は quarantine する。
