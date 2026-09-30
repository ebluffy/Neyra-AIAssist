<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Quickstart

1. Создайте venv и установите зависимости:
   - `python -m venv .venv`
   - `.venv\\Scripts\\activate` (Windows)
   - `pip install -r requirements.txt`
2. Скопируйте `.env.example` -> `.env` и заполните ключи (из каталога `server/`).
3. Скопируйте короткий корень: `config.example.yaml` -> `config.yaml`.
4. Скопируйте слои: `config/*.example.yaml` -> `config/*.yaml` (llm, agent, memory, voice, modules, runtime, server). См. `docs/config-keys.md`.
5. Для плагинов скопируйте:
   - `modules/discord/config.example.yaml` -> `modules/discord/config.yaml`
   - `config/server.example.yaml` -> `config/server.yaml`
6. (опционально) dashboard:
   - `cd dashboard && npm install && npm run build`
7. Запуск из `server/`:
   - `python main.py`
