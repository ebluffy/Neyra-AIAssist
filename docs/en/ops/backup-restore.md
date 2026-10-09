# Backup and restore

- Trigger: `POST /v1/backup/run` (admin token).
- Artifacts and schedules: `server/config/memory.yaml` (`backup`, `external_storage`).
- Include `server/data/memory/`, `server/config.yaml`, `server/config/`, and `server/.env` in operational backups (never commit `.env`).

## Pending restore / rollback_failed

Restore stages under `.neyra_pending_restore/` and applies on next core start. If apply cannot roll live memory (or external sqlite) back, status is `rollback_failed`, the process exits, and `blocked.json` freezes pending so auto-restart will not re-apply. Manual recovery: restore memory from `aside_path` and/or external sqlite from `sqlite_aside_paths` (both in `blocked.json` / `last_restore_apply.json`) over the live paths if those folders/files still exist, then delete `.neyra_pending_restore/` (or at least `blocked.json` + staging) before starting again.
