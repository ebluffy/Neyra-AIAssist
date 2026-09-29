# Stage 1b verification log

See also: [stage-1b-acceptance.md](stage-1b-acceptance.md)

## Honesty note (before/after)

Migrate on the developer machine happened **before** `--dry-run` existed.
Root `memory/` / `logs/` / `config.yaml` / `.env` are already gone, so dry-run shows `SKIP | source missing`.
Hub/Chroma numbers and the tree fingerprint below are the **post-migrate acceptance baseline**, not a pre-migrate snapshot.

- memory files: 14
- memory bytes: 2210613
- memory tree fingerprint (sha256): `e224ffc17f6d607524ea3bffd35f68a11f2a7dcde513881ed690a1f0ff1a6829`

## migrate --dry-run (post-migrate; sources already removed)

```text
== migrate_runtime_layout dry-run ==
| status | kind | source | destination | notes |
| SKIP | tree/file | config.yaml | - | source missing |
| SKIP | tree/file | .env | - | source missing |
| SKIP | tree/file | memory | - | source missing |
| SKIP | tree/file | logs | - | source missing |
| SKIP | file | interfaces\discord\lavalink\Lavalink.jar | - | source missing |
| SKIP | module config | interfaces\discord\config.yaml | - | source missing |
| SKIP | module config | interfaces\internal_api\config.yaml | - | source missing |
| SKIP | module config | interfaces\local_voice\config.yaml | - | source missing |
--- memory report (server target) ---
  memory_root: Z:\!Others\!Dev\AIAssist\server\data\memory
  hub_db: neyra_memory.db
  chroma_files: 6
  hub_tables: {'schema_migrations': 1, 'chat_log': 106, 'people': 7, 'person_facts': 0, 'diary_notes': 56, 'journal_entries': 0, 'working_memory_snapshots': 12, 'semantic_outbox': 0}
  hub_row_total: 182
```

## migrate --report-memory (post-migrate Hub/Chroma)

```text
--- memory report (server/data/memory) ---
  memory_root: Z:\!Others\!Dev\AIAssist\server\data\memory
  hub_db: neyra_memory.db
  chroma_files: 6
  hub_tables: {'schema_migrations': 1, 'chat_log': 106, 'people': 7, 'person_facts': 0, 'diary_notes': 56, 'journal_entries': 0, 'working_memory_snapshots': 12, 'semantic_outbox': 0}
  hub_row_total: 182
```

## verify --strict-memory

```text
== Stage 1b verify ==
OK legacy path scan (no interfaces/, frontend/, tools/mcp_server)
OK memory under server/data/memory, no root duplicates
OK paths.data_dir resolves to server/data
OK local_voice config merges to plugins.local_voice
```

## paths / NEYRA_DATA_DIR remapping smoke

```text
sqlite= Z:\!Others\!Dev\AIAssist\server\_tmp_data\memory\neyra_memory.db
chroma= Z:\!Others\!Dev\AIAssist\server\_tmp_data\memory\chroma_db
OK remapped
```

## compileall

```text
exit=0 (no output)
```

## healthcheck

```text
== Neyra Healthcheck ==
Root: Z:\!Others\!Dev\AIAssist\server
Mode: core
Status: OK
- Core files present
- LLM configuration and secrets look usable for this mode
- LLM HTTP probe skipped
```

## docker compose config

Run from repo root: `docker compose config` (do not commit output if secrets interpolate).
