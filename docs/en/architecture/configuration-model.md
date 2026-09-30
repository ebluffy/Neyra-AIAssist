<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Модель конфигурации

## Источники
1. Корневой `config.yaml`.
2. Файлы плагинов `server/modules/<id>/config.yaml`.
3. Секреты `.env`.

## Merge-порядок
1. Загружается `config.yaml`.
2. `merge_plugin_configs(...)` подмешивает конфиги плагинов.
3. `apply_env_secrets(...)` перекрывает секреты из окружения.

## Правила
- Папка плагина `discord` → ключ верхнего уровня `discord` в общем конфиге.
- Продуктовый HTTP API и dashboard — слой `config/server.yaml` (`api:`, `dashboard:`), пакет `core.api` (не plugin).
- Остальные id → `plugins.<id>`.