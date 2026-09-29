# Stage 1b verification log

See also: [stage-1b-acceptance.md](stage-1b-acceptance.md)

## migrate --dry-run

`	ext
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
`

## migrate --report-memory

`	ext
--- memory report (server/data/memory) ---
  memory_root: Z:\!Others\!Dev\AIAssist\server\data\memory
  hub_db: neyra_memory.db
  chroma_files: 6
  hub_tables: {'schema_migrations': 1, 'chat_log': 106, 'people': 7, 'person_facts': 0, 'diary_notes': 56, 'journal_entries': 0, 'working_memory_snapshots': 12, 'semantic_outbox': 0}
  hub_row_total: 182
`

## verify --strict-memory

`	ext
== Stage 1b verify ==
OK legacy path scan (no interfaces/, frontend/, tools/mcp_server)
OK memory under server/data/memory, no root duplicates
OK paths.data_dir resolves to server/data
OK local_voice config merges to plugins.local_voice
`

## compileall

`	ext
(ok, no output)
`

## healthcheck

`	ext
== Neyra Healthcheck ==
Root: Z:\!Others\!Dev\AIAssist\server
Mode: core
Status: OK
- Core files present
- LLM configuration and secrets look usable for this mode
- LLM HTTP probe skipped
`

## docker compose config

Run from repo root: docker compose config (do not commit output if secrets interpolate).