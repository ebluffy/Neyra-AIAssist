<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Troubleshooting

## API не отвечает
- Проверьте, что `python server/main.py` запущен.
- Проверьте host/port в `server/config/server.yaml` (секция `api:`).

## 401 Unauthorized
- Либо задайте корректный Bearer, либо очистите `API_TOKEN`.

## Discord plugin не стартует
- Проверьте `server/modules/discord/plugin.yaml` (`enabled: true`).
- Проверьте `DISCORD_TOKEN` в `server/.env`.

## Ошибки вебхуков
- Смотрите `/v1/webhooks/deliveries` и `/v1/webhooks/dlq`.
- Проверьте `target_url`, secret и сетевую доступность endpoint-а.