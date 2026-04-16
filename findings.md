# Findings

- Initial scan: existing runtime ledger already has job leases and execution outbox support in src/db/repositories/runtime-ledger.ts.
- Initial scan: runtime state and safety services already model partial degradation, but Phase 3 likely needs explicit global degrade modes and transition logic.
- Initial scan: there are existing heartbeat-oriented job and dashboard paths, so Phase 3 should extend current wiring rather than replace it.
- Package scripts currently expose individual jobs, but there is no explicit 15m/1h/1d/1w tier abstraction yet.
- Existing safety service only evaluates cost degradation and repeated failures; it does not model the spec's Full Autonomy / Threads-only / Observe-only / Safe Freeze modes.
- Existing job wrappers already use a shared runJob helper with job lease acquisition and scheduled/job run persistence, so the new tier jobs should reuse runJob rather than reimplement locking.
- Session health, runner health, anomaly events, funnel snapshots, and winning pattern data already exist in schema, which is enough to compute deterministic degrade-mode and rollback decisions.
- Existing individual jobs map naturally onto tiers: follow-up and health sync for 15m, hourly-heartbeat for 1h, daily topic/threads/note jobs for 1d, and weekly-retro for 1w.
- Existing Phase 2 schema already had winning_patterns and rollbacks tables. Phase 3 can layer on operations_mode_state and reuse those existing audit tables instead of redefining them.
- hourly-heartbeat has note-specific side effects outside department executors, so mode enforcement must happen both before action execution and before pre-seeding/forced note publish hooks.