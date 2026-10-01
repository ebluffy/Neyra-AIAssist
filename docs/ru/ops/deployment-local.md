<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Локальный деплой

- Используйте `python server/main.py`.
- По умолчанию API на `127.0.0.1:8787`.
- Статика дашборда — из `server/dashboard/dist` (если собрана); Control API — `server/core/api/`.
- Для разработки фронтенда: `cd server/dashboard && npm run dev` (proxy на backend).