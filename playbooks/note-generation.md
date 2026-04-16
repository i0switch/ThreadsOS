---
{
  "id": "note-generation",
  "kind": "playbook",
  "name": "note-generation",
  "owner": "note",
  "purpose": "note 記事ドラフトを生成する",
  "inputs": ["bottleneck", "research_memory", "pricing_policy", "winning_patterns"],
  "outputs": ["draft", "title_options", "offer_plan"],
  "steps": ["build_outline", "draft_sections", "attach_offer", "send_to_auditor"],
  "successCriteria": {
    "result": "publish-ready note draft"
  }
}
---
# note-generation

note 記事は Read または Buy 改善に寄与するものだけを作る。公開制御は playbook ではなく deterministic layer が担う。
