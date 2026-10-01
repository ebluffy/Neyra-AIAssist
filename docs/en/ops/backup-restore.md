# Backup and restore

- Trigger: `POST /v1/backup/run` (admin token).
- Artifacts and schedules: `server/config/memory.yaml` (`backup`, `external_storage`).
- Include `server/data/memory/`, `server/config.yaml`, `server/config/`, and `server/.env` in operational backups (never commit `.env`).
