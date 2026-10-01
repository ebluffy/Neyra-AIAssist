# SDK Reference

## `PluginContext`
- `root`: server root (`server/`, where `main.py` lives).
- `config`: merged runtime config.
- `agent`: доступен там, где нужен общий агент (например Discord).

## Entrypoint
- Модуль плагина должен экспортировать:
  - `run_plugin(ctx: PluginContext) -> None`

## Вызов
- Core lifecycle: через `server/core/runtime/server.py`.
- On-demand: `cd server && python scripts/invoke_plugin.py <plugin_id>` или API invoke.