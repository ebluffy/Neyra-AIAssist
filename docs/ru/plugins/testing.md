<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Тестирование плагинов

## Smoke
- `cd server && python scripts/invoke_plugin.py <plugin_id>`
- `cd server && python scripts/healthcheck.py`

## Рекомендации
- Unit tests для функций трансформации payload.
- Интеграционный тест на корректный `run_plugin(ctx)`.
- Таймауты и обработка ошибок должны быть явными.