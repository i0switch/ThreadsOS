# ThreadsOS - Copilot Instructions

## What is ThreadsOS?
ThreadsOS is an autonomous operating system for Threads and note.com content operations.
It automates posting, engagement analysis, competitor research, reply management, and revenue optimization through a multi-department agent architecture.

## Architecture
- **Runtime:** Node.js 22 + TypeScript
- **DB:** SQLite + Drizzle ORM (better-sqlite3)
- **LLM:** Claude Code heartbeat mode (`claude -p` via llm-heartbeat-worker)
- **Server:** Fastify (dashboard API)
- **Test:** Vitest
- **Threads:** Meta Graph API (OAuth tokens)
- **note.com:** Playwright browser automation

## Key Design Principles
1. **Differential processing** - Never send full context to LLM. Only send deltas since last heartbeat.
2. **5-layer memory hierarchy** - Persistent policy / Department summaries / Event logs / Working memory / KPI snapshots
3. **Budget management** - Each agent has token/call limits per heartbeat
4. **Proposal-approval flow** - Agent proposes → Leader reviews → Executive decides → Human approves (if needed)
5. **Cost optimization** - Light model for routing/summarization, heavy model for strategy decisions only

## Directory Structure
```
src/
  adapters/     # External API clients (Threads, note, LLM, web search)
  agents/       # Agent definitions with roles and budgets
  app/          # Logger, error handling
  cli/          # CLI tools (setup, review, input)
  config/       # Environment config
  dashboard/    # Dashboard API routes and handlers
  db/           # Schema, bootstrap, migrations
  domain/       # Domain types (threads, note, department, memory)
  jobs/         # Scheduled jobs (heartbeat, research, pipeline)
  memory/       # Memory hierarchy implementation
  server/       # Fastify server setup
  services/     # Business logic (orchestration, scheduling, generation)
```

## Database
- 30+ SQLite tables via Drizzle ORM
- Key tables: topics, thread_post_drafts, note_drafts, content_slots, heartbeat_states, executive_cycles, department_runs, strategy_states, llm_task_queue
- New tables for: agent_states, proposals, memory layers, budget_tracking, kpi_snapshots

## Heartbeat Flow (13 steps per spec)
1. Heartbeat trigger
2. Collect event deltas
3. Importance scoring
4. Select target departments
5. Distribute minimal context
6. Department agents execute
7. Leaders integrate results
8. Send proposals to executive
9. Auto-approve safe actions
10. Route risky items to human review
11. Save logs
12. Update summaries
13. Update dashboard

## Testing
- Unit tests with Vitest
- Integration tests for job pipelines
- Idempotence/reexecution safety tests
- Dashboard API tests
- E2E heartbeat flow tests

## When reviewing ThreadsOS code
- Check that LLM calls use minimal context (no full history dumps)
- Verify budget limits are respected
- Ensure proposals have: what, why, evidence, expected effect, risk, priority
- Confirm differential processing (only new data since last run)
- Validate error handling with retry/fallback/hold patterns
