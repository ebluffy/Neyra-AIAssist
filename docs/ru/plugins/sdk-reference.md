<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# SDK Reference

## `PluginContext`
- `root`: корень сервера (`server/`, где лежит `main.py`).
- `config`: merged runtime config.
- `agent`: доступен там, где нужен общий агент (например Discord).

## Entrypoint
- Модуль плагина должен экспортировать:
  - `run_plugin(ctx: PluginContext) -> None`

## Вызов
- Core lifecycle: через `server/core/runtime/server.py`.
- On-demand: `cd server && python scripts/invoke_plugin.py <plugin_id>` или API invoke.