<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Plugin System Overview

Плагин = папка `server/modules/<plugin_id>/`:
- `plugin.yaml` — манифест и lifecycle.
- `main.py` — входная точка `run_plugin(ctx)`.
- `config.example.yaml` — шаблон параметров.
- `config.yaml` — локальный runtime (не в git).

Загрузка и реестр: `core/plugins/loader.py`.
Контекст запуска: `core/plugins/sdk.py`.