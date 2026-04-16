---
{
  "id": "degrade-modes",
  "kind": "playbook",
  "name": "degrade-modes",
  "owner": "executive",
  "purpose": "障害時の運転モードを切り替える",
  "inputs": ["runner_health", "session_health", "adapter_health", "system_controls"],
  "outputs": ["mode", "reason"],
  "steps": ["evaluate_note_session", "evaluate_runner_failures", "evaluate_adapter_failures", "select_mode"],
  "successCriteria": {
    "result": "deterministic mode selection"
  }
}
---
# degrade-modes

Mode は full_autonomy, threads_only, observe_only, safe_freeze の 4 つ。手動承認待ちという mode は持たない。
