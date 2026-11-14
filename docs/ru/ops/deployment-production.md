# Продакшн деплой (базовый чеклист)

- Запускать под process manager (systemd/supervisor/pm2 wrapper) из каталога `server/` или с `PYTHONPATH=server`.
- Включить `API_TOKEN` (или роли viewer/maint/web) в `server/.env` — **обязательно** при bind ≠ loopback и при публикации в интернет. Для сайта — `API_WEB_TOKEN` и identity `NEYRA_IDENTITY_JWT_SECRET`/`_ISSUER`.
- **Vault провайдеров.** `NEYRA_VAULT_KEY` хранится в `server/.env` (0600) и не коммитится. `devtools/deploy/update-core.sh` до import-smoke запускает `server/scripts/ensure_vault_key.py`: переносит старый `<data_dir>/secrets/vault.key`, перешифровывает записи v1 → v2 и проверяет расшифровку. Каталог данных берётся как у ядра (`NEYRA_DATA_DIR`, затем `paths.data_dir`). При ручном откате верните и `.env`, и `data/secrets` из бэкапа: без старого ключа секреты провайдеров не расшифруются.
- Использовать reverse proxy с TLS ([api-reverse-proxy](api-reverse-proxy.md), [wss-deployment](wss-deployment.md)).
- **Публикация домена (Этап 3):** предпочтительно Neyra на домашнем сервере + **frpc** → VPS (**frps** + Caddy); данные не уезжают на VPS — см. [`docs/PLAN.md`](../../PLAN.md) §3.
- Ограничить входящий доступ: порт 8787 не открывать наружу напрямую.
- Настроить регулярный backup (`server/data/memory/`, конфиги) и наблюдение по health/status log (`server/logs/`).
- Фиксировать версии зависимостей и проверять smoke после обновлений.
