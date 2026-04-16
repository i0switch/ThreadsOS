---
{
  "id": "rollback-policy",
  "kind": "playbook",
  "name": "rollback-policy",
  "owner": "executive",
  "purpose": "指標急落時の巻き戻し条件を定義する",
  "inputs": ["experiment_result", "baseline_metrics", "complaint_signal"],
  "outputs": ["rollback_decision", "rollback_scope"],
  "steps": ["compare_to_baseline", "check_drop_thresholds", "record_rollback_evidence", "pause_or_revert"],
  "successCriteria": {
    "result": "rollback executed with evidence"
  }
}
---
# rollback-policy

CTR、購入率、苦情シグナルが閾値を超えて悪化した場合は rollback を記録し、対象範囲を戻す。
