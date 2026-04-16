---
{
  "id": "experiment-selection",
  "kind": "playbook",
  "name": "experiment-selection",
  "owner": "executive",
  "purpose": "仮説候補から 1 つの実験だけを採用する",
  "inputs": ["bottleneck", "candidate_hypotheses", "risk_policy"],
  "outputs": ["selected_experiment", "rejected_hypotheses"],
  "steps": ["rank_by_expected_effect", "filter_high_risk", "select_single_experiment", "schedule_scoring"],
  "successCriteria": {
    "result": "one experiment ready for canary"
  }
}
---
# experiment-selection

改善仮説は 3 つ作っても採用は 1 つだけ。高リスク案は採用せず skip または quarantine に回す。
