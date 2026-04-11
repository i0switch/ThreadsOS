# ThreadsOS Agent Definitions

## Department Structure

### 1. Command & Control (管理・指揮系統)
- **Role:** Overall decision-making, policy adjustment, cross-department optimization
- **Leader:** Executive Director
- **Responsibilities:** Monitor proposals, make decisions, issue corrections, adjust posting frequency/reply policy/generation strategy

### 2. External Research (外部リサーチ部署)
- **Role:** Collect and organize latest information for assigned genres/themes
- **Leader:** Research Director
- **Agents:**
  - Trend Researcher - Latest news, trends, market understanding
  - Insight Extractor - Extract actionable insights from raw research
- **Outputs:** Research items shared to all departments

### 3. Competitor Analysis (競合リサーチ分析部署)
- **Role:** Cross-analyze competitor accounts, articles, strategies
- **Leader:** Competitive Intelligence Director
- **Agents:**
  - Post Analyst - Analyze competitor Threads posts
  - Article Analyst - Analyze competitor note articles
  - Strategy Analyst - Extract win/lose patterns
- **Outputs:** Competitor snapshots, improvement proposals

### 4. Threads Operations (Threads運用部署)
- **Role:** Execute Threads account operations
- **Leader:** Threads Operations Director
- **Agents:**
  - Post Generator - Create thread posts (hooks, CTAs, note transitions)
  - Reply Manager - Classify and respond to replies
  - Engagement Analyst - Track post metrics, analyze performance
  - Threads Competitor Watcher - Monitor competitor Threads activity
- **Outputs:** Published posts, reply decisions, engagement reports

### 5. note Operations (note運用部署)
- **Role:** Execute note.com account operations
- **Leader:** note Operations Director
- **Agents:**
  - Article Generator - Create note articles (ideas, outlines, drafts)
  - Engagement Analyst - Track article metrics, analyze performance
  - note Competitor Watcher - Monitor competitor note articles
- **Outputs:** Published articles, pricing proposals, engagement reports

## Agent State Model

Each agent has:
- `id` - Unique identifier
- `name` - Display name
- `department` - Parent department
- `role` - Functional role
- `status` - idle | working | proposing | awaiting_approval | paused
- `current_task` - What they're currently doing
- `last_completed_task` - Most recent completion
- `budget_remaining` - Tokens/calls left this heartbeat
- `last_active_at` - Timestamp

## Proposal Flow

```
Agent creates proposal
  -> Department Leader reviews & consolidates
    -> Executive evaluates (auto-approve if safe)
      -> Human dashboard (if risky or policy-changing)
        -> Approved: Execute
        -> Rejected: Return with feedback
```

## Budget Rules

| Level | Max LLM Calls/Heartbeat | Max Tokens/Call | Notes |
|-------|------------------------|-----------------|-------|
| Light tasks (routing, summary) | 10 | 2000 | Use Sonnet |
| Standard tasks (generation, audit) | 5 | 4000 | Use Sonnet |
| Heavy tasks (strategy, pricing) | 2 | 8000 | Use Opus if available |
| Emergency | Unlimited | 4000 | Override for critical issues |
