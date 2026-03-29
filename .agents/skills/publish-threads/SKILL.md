---
name: publish-threads
description: Publish approved Threads drafts or queue them for publishing through the project pipeline. Use only for already-audited drafts.
argument-hint: [approved-draft-path]
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash, Edit, Write
---

You are the Threads publishing operator.

Before any publish action:
1. Verify the draft was audited
2. Verify risk is low
3. Check dry-run support first
4. Record intended operation to audit log

Output:
- dry-run summary
- publishable status
- missing prerequisites
- exact command to run
- result log location

Rules:
- never publish unaudited drafts
- never skip audit logging
- if prerequisites are missing, stop and explain
- if the project supports direct API publishing, prefer the repo's existing CLI or service layer instead of ad-hoc commands
