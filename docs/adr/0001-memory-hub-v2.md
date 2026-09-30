# ADR-0001 — Memory Hub v2 (SQLite truth + Chroma semantic index)

**Status:** Accepted (implemented; Hub under `server/core/memory/`, data under `server/data/memory/`)  
**Date:** 2026-07-21  
**Context:** [`docs/PLAN.md`](../PLAN.md) Stage 1 / Phase 1A (historical); layout later moved in Stage 1b

## Decision

Neyra uses a single **MemoryHub** facade (`core/memory/`) as the only entry point for durable memory and prompt injection of memory sections.

| Layer | Store | Role |
|-------|--------|------|
| Dialog truth | SQLite `chat_log` | Full turns (who / what / when / where / meta) |
| Structured truth | SQLite tables | people, diary, journal, working memory |
| Semantic index | Chroma (adapter) | Only recallable content by `metadata.type` |
| STM | RAM (+ optional view of last N from `chat_log`) | Active window |

## Concurrency

One writer contour per process: sync `sqlite3` with a process-wide `threading.RLock`, WAL mode. Async callers use `asyncio.to_thread` for Hub writes. No parallel SQLite writers from plugins.

## Timestamps / timezone

- **Storage:** Hub SQLite `ts` / `created_at` columns are always **UTC ISO** (with offset), so `ORDER BY ts` stays chronological across hosts and after TZ changes. Incoming values are normalized via `core.timeutil.to_utc_iso`.
- **Wall clock:** reflection windows, WM labels, and `get_current_time` use the **host OS timezone** by default. Optional override: `system.timezone` (IANA, e.g. `Europe/Moscow`) via `configure_timezone`.
- **Readers:** convert with `to_local()`; do not early-`break` on TEXT order when filtering windows (mixed legacy offsets possible during migration).

## RAG write policy

Config `memory.rag_write_mode`: `off` | `digest` | `important_only`.  
Raw full-chat embed on every turn is **forbidden** (Hub `save_dialog_semantic` no-ops).  
Escape hatch for migration only: `legacy_dialog`.  
Knowledge / important fragments still go through `remember_knowledge` (unless `off`).

## Events

| Event | Meaning |
|-------|---------|
| `memory.short_term_update` | STM size / window changed |
| `memory.long_term_write` | Semantic index write (not chat_log) |
| `memory.chat_log_append` | Row(s) appended to SQLite chat_log |
| `memory.journal_updated` | Journal row changed |
| `memory.working_memory_updated` | WM snapshot changed |

## Vector backend seam

`SemanticIndex` protocol + Chroma adapter. Future sqlite-vss (plan stage 2 / autonomy) plugs in without changing agent call sites.

## Cutover (done) — legacy import abandoned

The `hub_legacy_import` / `hub_legacy_fallback` / `hub_dual_write_legacy` config flags have been
**removed entirely** — Hub SQLite is now the sole store for people/diary/journal/WM whenever a
`MemoryHub` is attached (no JSON/JSONL/MD writes, no fallback reads). There was no meaningful
on-disk legacy data to migrate, so Phase 1A goes further than disabling the flags: the entire
legacy-import subsystem has been **removed**, not just gated off:

- `core/memory/legacy_import.py`, `run_hub_legacy_import()`, and `POST /v1/memory/import-legacy`
  no longer exist.
- The marker-gated automatic import at startup (Hub empty + legacy files on disk) is gone —
  `_init_people_db` seeds baseline dossiers into Hub (or memory-only cache without a Hub) purely
  based on whether Hub/cache already has data, never by globbing `people_db/*.json`.
- `PeopleDB` no longer touches the filesystem at all: no `db_dir`, no `_load_all()`, no JSON
  `_save()`. It is an in-memory `_cache` that Hub writes through to when a `MemoryHub` is
  attached (`hydrate_from_hub()` fills the cache back in); without a Hub it is memory-only for
  that process (console/emergency use, no persistence).
- `NeyraDiary` no longer appends/reads/trims a JSONL file at all — Hub-only when `memory_hub` is
  set; without a Hub, entries live in an in-memory list for that process only.
- `ReflectionEngine` never loads `journal.json` as a seed for `_journal` — it always starts empty
  and hydrates from Hub SQLite via `list_journal_entries(limit=1000, newest_first=True)`, reversed
  in RAM for chronological order (fixes a bug where `newest_first=False` + `LIMIT` could silently
  drop the most recent entries, including today's, once the table grew past the limit). Writing
  `journal.json` is optionally kept **only** when no Hub is attached at all — a write-only
  console artifact that is never loaded back.

## Consequences

- Agents, Internal API `/v1/memory/*`, tools (`recall_chat`, `search_memory`, …), MCP debug, and dashboard must talk to Hub.
- Prompt injection (people / diary / WM / semantic) goes through Hub only; no legacy-file fallback once a Hub is attached.
- Phase 1B may rearrange packages; import shims stay stable (`from core.memory import …`).
