<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Модель конфигурации

## Источники

1. Корневой `server/config.yaml` (assistant, paths, верхнеуровневые переключатели).
2. Слои в `server/config/*.yaml` (llm, agent, memory, voice, modules, runtime, **server**).
3. Файлы плагинов `server/modules/<id>/config.yaml`.
4. Секреты `server/.env`.

## Merge-порядок

1. Загружается `server/config.yaml` и слои из `server/config/`.
2. `merge_plugin_configs(...)` подмешивает конфиги плагинов.
3. `apply_env_secrets(...)` перекрывает секреты из окружения.

## Правила

- Папка плагина `discord` → ключ верхнего уровня `discord` в общем конфиге.
- HTTP Control API и dashboard → `server/config/server.yaml` (`api:`, `dashboard:`); реализация в `server/core/api/` (не plugin).
- Остальные id → `plugins.<id>`.

См. также [config-reference](../setup/config-reference.md) и `docs/config-keys.md`.
