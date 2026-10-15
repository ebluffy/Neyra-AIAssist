# Model Trace Contract

`server/core/agent/model_trace.py` remains the single source of per-turn LLM
evidence. The Stage 4 fields are additive; existing `turn_id`, `timestamp`,
`status`, `calls`, and call routing fields remain available.

## Call records

- `call_id` is a local identity for one attempted invocation. Retries are
  separate calls and retain their `attempt` value.
- `provider_request_id` is populated only from provider response metadata.
  Missing provider IDs remain `null`. Completion `id` is recorded separately
  as `provider_response_id` and never presented as a request ID.
- `started_at`, `ended_at`, `duration_ms`, and
  `first_meaningful_token_{at,ms}` use local timing. A non-streaming result
  marks the completed result as the first meaningful token when no earlier
  token was observed.
- `provider_usage` preserves the provider's usage keys. `usage` is a small
  normalized view for input/output/cache token counts and does not replace the
  provider payload. Missing values remain absent or `null`, never zero.
- `status` records completion, failure, or cancellation. `purpose` remains
  caller supplied and retries do not create a synthetic completed call.
- `cost_estimate` and `actual_billing` are independent nullable fields;
  trace collection does not claim that an estimate was charged.

## Background tasks

Per-exchange diary, working-memory refresh, semantic dialogue persistence,
scheduled reflection/consolidation and Discord intent classification run in
separate reports (`kind: background`). `parent_turn_id` links known originating
turns; standalone scheduled jobs have no parent. LLM calls inside jobs are
real call records. Coder calls and deep delegation belong to their enclosing
brain turn. Jobs never mutate closed turn reports; shutdown cancels pending jobs.

Hub writes compare per-scope generations captured when a job starts (nested
jobs inherit the original snapshot). A diary wipe invalidates stale diary
writes; journal-only cleanup does not cancel diary, WM or semantic persistence.
Failed wipes do not advance generations. There is one canonical turn-diary job
controlled by memory.diary_after_turn; legacy async/emotional diary options
are deprecated and ignored, not additional background generators.

Streaming observes every chunk, including initial and trailing metadata-only
chunks. Only substantive text satisfies the first-token timeout. Provider usage
and request IDs are collected when present; missing values stay unknown. SDK
response headers are enabled. Compatible gateways may opt in with
`llm.providers.<name>.capabilities.supports_stream_usage: true` (default false).
Only known numeric usage counters are retained; arbitrary metadata is discarded.

`begin_task`/`end_task` record memory, reflection, coder, or other background
work in its owning report without fabricating an LLM call. Each task has a
local `task_id`, `purpose`, timing, lifecycle status, and optional
`parent_call_id` or `parent_task_id` when the relation is known. `finish`
closes still-running tasks so a completed report cannot contain a false
running record.

## Compatibility and migration

Consumers should ignore unknown fields and tolerate nullable values. Existing
stored reports do not need a data migration: readers treat absent fields as
unknown. Activity holds the last 200 turns and separately 200 jobs, merged by
timestamp for the protected API. Jobs cannot evict Discord `/model` history.
Both REST and final WS done carry the closed report; it updates existing
chat-log metadata and is published through `llm.turn.completed`. Removed chat
rows are never recreated. Background reports remain process-local and on the
Event Bus. Reports contain no prompt, response, personal ID or reasoning.
SDK-internal HTTP retries, upstream routing and actual billing are not proven
by these reports. Cost fields remain independent unknown values.
