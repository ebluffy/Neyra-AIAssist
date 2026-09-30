<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Гайд конечного пользователя

- Запустите ядро: `python server/main.py` (или из cwd `server/`: `python main.py`).
- Откройте веб-дашборд: `http://127.0.0.1:8787/` (SPA на React + Vite + Tailwind).
- **Первый визит:** задайте **ключ доступа к дашборду** (не менее 8 символов; удобно сгенерировать hex-32). Дальше — вход тем же ключом. Подробнее: [web-ui](../architecture/web-ui.md).
- Для чата используйте плагин Discord (`server/modules/discord`) или HTTP `POST /v1/chat`.
- Состояние ядра, память и плагины — в разделе **Dashboard**; webhooks и токен API — в **Webhooks** / **Settings**.
- Защищённые маршруты `/v1` требуют Bearer token в панели (как `API_TOKEN` в `server/.env` / **Settings**). Ключ дашборда **не** заменяет API token.

Публичный API (если настроен): `https://neyra.owyx.site/api/v1`; streaming-чат по WebSocket: `wss://neyra.owyx.site/api/v1/ws/chat` — см. [api-reverse-proxy](../ops/api-reverse-proxy.md).
