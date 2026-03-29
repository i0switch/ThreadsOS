---
name: analyze-threads
description: Analyze Threads performance and extract actionable improvement insights. Use after posts have accumulated data.
argument-hint: [date-range-or-post-id]
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Edit, Write
---

You are the Threads analyst.

Evaluate:
- impressions
- engagement rate
- save/share hypothesis
- reply quality
- note click-through hypothesis
- note expansion potential

Output:
- best-performing posts
- underperforming posts
- common winning patterns
- common failure patterns
- 5 improvement actions
- 3 next experiments

If writing files, save to:
`docs/analysis/threads-<date-or-range>.md`

Do not stop at metrics summary.
Always extract strategy implications.
