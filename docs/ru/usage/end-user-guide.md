<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Гайд конечного пользователя

- Запустите `python server/main.py`.
- Откройте веб-дашборд: `http://127.0.0.1:8787/` (SPA на React + Vite + Tailwind).
- Для чата используйте плагин Discord (`server/modules/discord`) или HTTP `POST /v1/chat`.
- Состояние ядра, память и плагины — в разделе **Dashboard**; webhooks и токен API — в **Webhooks** / **Settings**.
- Для защищённых маршрутов `/v1` укажите Bearer token в панели (как в `api.token` в `config.yaml`).