---
{
  "id": "funnel-diagnosis",
  "kind": "playbook",
  "name": "funnel-diagnosis",
  "owner": "executive",
  "purpose": "6段ファネルから最弱段を 1 つだけ選ぶ",
  "inputs": ["funnel_snapshots", "threads_metrics", "note_metrics", "revenue_events"],
  "outputs": ["bottleneck", "reasoning", "candidate_actions"],
  "steps": ["load_latest_metrics", "score_dropoffs", "select_single_bottleneck", "record_reasoning"],
  "successCriteria": {
    "result": "single bottleneck with evidence"
  }
}
---
# funnel-diagnosis

最新の funnel snapshot を読み、Reach, Click, Read, Buy のどこが最も詰まっているかを 1 つだけ返す。
