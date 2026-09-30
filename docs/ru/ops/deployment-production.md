<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Продакшн деплой (базовый чеклист)

- Запускать под process manager (systemd/supervisor/pm2 wrapper).
- Включить `API_TOKEN`.
- Использовать reverse proxy с TLS.
- Ограничить входящий доступ к API.
- Настроить регулярный backup и наблюдение по health/status log.
- Фиксировать версии зависимостей и проверять smoke после обновлений.