<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Тестирование плагинов

## Smoke
- `python scripts/invoke_plugin.py <plugin_id>`
- `cd server && python scripts/healthcheck.py --mode core --skip-http`

## Рекомендации
- Unit tests для функций трансформации payload.
- Интеграционный тест на корректный `run_plugin(ctx)`.
- Таймауты и обработка ошибок должны быть явными.