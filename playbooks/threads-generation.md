---
{
  "id": "threads-generation",
  "kind": "playbook",
  "name": "threads-generation",
  "owner": "threads",
  "purpose": "Threads 投稿案と CTA を生成する",
  "inputs": ["bottleneck", "winning_patterns", "competitor_delta", "brand_policy"],
  "outputs": ["posts", "cta_plan"],
  "steps": ["select_hook_angle", "draft_post", "attach_cta", "send_to_auditor"],
  "successCriteria": {
    "result": "auditable thread drafts"
  }
}
---
# threads-generation

Threads 投稿は Reach または Click 改善に寄与するものだけを作る。大量生成は禁止。
