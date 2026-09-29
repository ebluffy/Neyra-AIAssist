<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Getting Started: Plugin

1. Скопируйте шаблон из `server/modules/000EXAMPLE/`.
2. Заполните `plugin.yaml`.
3. Реализуйте `run_plugin(ctx)` в `main.py`.
4. Добавьте `config.example.yaml`.
5. Проверка:
   - `python scripts/invoke_plugin.py <plugin_id>` для on_demand
   - `python server/main.py` для resident