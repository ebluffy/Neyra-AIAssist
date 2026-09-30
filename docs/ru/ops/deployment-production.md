<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Продакшн деплой (базовый чеклист)

- Запускать под process manager (systemd/supervisor/pm2 wrapper) из каталога `server/` или с `PYTHONPATH=server`.
- Включить `API_TOKEN` (или роли viewer/maint) в `server/.env` — **обязательно** при bind ≠ loopback и при публикации в интернет.
- Использовать reverse proxy с TLS ([api-reverse-proxy](api-reverse-proxy.md), [wss-deployment](wss-deployment.md)).
- **Публикация домена (Этап 3):** предпочтительно Neyra на мини-ПК + **frpc** → VPS (**frps** + Caddy); данные не уезжают на VPS — см. [`docs/PLAN.md`](../../PLAN.md) §3.
- Ограничить входящий доступ: порт 8787 не открывать наружу напрямую.
- Настроить регулярный backup (`server/data/memory/`, конфиги) и наблюдение по health/status log (`server/logs/`).
- Фиксировать версии зависимостей и проверять smoke после обновлений.
