---
{
  "id": "canary-rollout",
  "kind": "playbook",
  "name": "canary-rollout",
  "owner": "executive",
  "purpose": "新規施策を少量投入で検証する",
  "inputs": ["selected_experiment", "eligible_slots", "risk_policy"],
  "outputs": ["canary_group", "scheduled_actions"],
  "steps": ["limit_initial_volume", "assign_canary_group", "enqueue_outbox", "schedule_scoring"],
  "successCriteria": {
    "result": "limited rollout with measurable attribution"
  }
}
---
# canary-rollout

新施策は少量投入で始め、24h/72h の採点を必ず予約する。大量配信は勝ち判定後のみ。
