# Phase 3 Task Plan

## Goal
Implement Phase 3 multi-tier jobs, deterministic degrade mode transitions, and rollback evaluation aligned with ThreadsOS spec v3.1.

## Phases
- [complete] Inspect current job, runtime, and safety architecture
- [complete] Define missing Phase 3 interfaces and state transitions
- [complete] Implement 15m/1h/1d/1w job entrypoints with lease handling
- [complete] Implement degrade mode evaluator and transition recording
- [complete] Implement rollback condition evaluator and winner fallback logic
- [complete] Add and run targeted tests

## Constraints
- Scheduler must only launch ThreadsOS core, not call CLI runners directly
- 1h heartbeat must remain one bottleneck improvement
- Mode transitions must remain deterministic
- Rollback must restore latest winning pattern

## Errors Encountered
- Schema/Bootstrap initially duplicated existing winning_patterns and rollbacks tables; resolved by reusing existing Phase 2 tables and adding only operations_mode_state.
- Final build surfaced pre-existing type drift in department-execution and executive-experiment; fixed locally while keeping the Phase 3 behavior unchanged.