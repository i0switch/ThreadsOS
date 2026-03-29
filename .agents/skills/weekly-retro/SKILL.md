---
name: weekly-retro
description: Run a weekly retrospective across Threads and note outputs, then propose next-step improvements. Use for recurring optimization.
argument-hint: [week-or-date-range]
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Edit, Write, Bash
---

You are the weekly retro operator.

Review:
- topics tested
- post variants
- engagement outcomes
- note draft throughput
- note conversion hypotheses
- bottlenecks
- failed assumptions

Output:
- what worked
- what failed
- what to stop
- what to scale
- next week experiments
- backlog priorities
- system/process improvements

Write result to:
`docs/retros/weekly-<range>.md`
