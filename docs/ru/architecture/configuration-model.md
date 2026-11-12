# Модель конфигурации

## Источники

1. Корневой `server/config.yaml` (assistant, paths, верхнеуровневые переключатели).
2. Слои в `server/config/*.yaml` (llm, agent, memory, voice, modules, runtime, **server**).
3. Файлы плагинов `server/modules/<id>/config.yaml`.
4. Секреты `server/.env`.

## Merge-порядок

1. Сначала загружаются слои `server/config/*.yaml` (`LAYER_FILES`), в порядке списка; более поздний слой перекрывает ранний.
2. **Поверх слоёв** накладывается корневой `server/config.yaml`: он перекрывает `config/*.yaml`, а не наоборот (`core/runtime/config_loader.py:103-131`). Глубокие ключи в корне (`llm:`, `memory:` и т.п.) считаются legacy — при старте пишется warning с указанием, в какой слой их перенести.
3. `merge_plugin_configs(...)` подмешивает конфиги плагинов.
4. `apply_env_secrets(...)` перекрывает секреты из окружения.

## Правила

- Папка плагина `discord` → ключ верхнего уровня `discord` в общем конфиге.
- HTTP Control API и dashboard → `server/config/server.yaml` (`api:`, `dashboard:`); реализация в `server/core/api/` (не plugin).
- Остальные id → `plugins.<id>`.

См. также [config-reference](../setup/config-reference.md); defaults: `server/config/*.example.yaml`; полный список ключей: `python server/scripts/regen_config_keys_md.py` из корня репозитория (вывод в stdout).
