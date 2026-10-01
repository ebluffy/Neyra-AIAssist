# Getting Started: Plugin

1. Скопируйте шаблон из `server/modules/000EXAMPLE/`.
2. Заполните `plugin.yaml`.
3. Реализуйте `run_plugin(ctx)` в `main.py`.
4. Добавьте `config.example.yaml`.
5. Проверка:
   - `cd server && python scripts/invoke_plugin.py <plugin_id>` для on_demand
   - `cd server && python main.py` для resident
   - Доп. pip-зависимости плагина — в `server/requirements.txt` (не отдельный lock в `modules/`)