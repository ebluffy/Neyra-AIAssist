<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Гайд конечного пользователя

- Запустите ядро: `python server/main.py` (или из cwd `server/`: `python main.py`).
- Откройте веб-дашборд: `http://127.0.0.1:8787/` (SPA на React + Vite + Tailwind).
- **Первый визит:** задайте **ключ доступа к дашборду** (не менее 8 символов; удобно сгенерировать hex-32). Дальше — вход тем же ключом. Подробнее: [web-ui](../architecture/web-ui.md).
- Для чата используйте плагин Discord (`server/modules/discord`) или HTTP `POST /v1/chat`.
- Состояние ядра, память и плагины — в разделе **Dashboard**; webhooks и токен API — в **Webhooks** / **Settings**.
- После входа дашборд получает session-токен и ходит в `/v1` с ним (роль admin). Отдельный `API_TOKEN` в `.env` / **Settings** — для Discord, MCP и скриптов.

Публичный API (если настроен): `https://neyra.owyx.site/api/v1`; streaming-чат по WebSocket: `wss://neyra.owyx.site/api/v1/ws/chat` — см. [api-reverse-proxy](../ops/api-reverse-proxy.md).
