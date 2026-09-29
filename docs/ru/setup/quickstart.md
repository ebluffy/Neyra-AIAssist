<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Quickstart

1. Создайте venv и установите зависимости:
   - `python -m venv .venv`
   - `.venv\\Scripts\\activate` (Windows)
   - `pip install -r requirements.txt`
2. Скопируйте `.env.example` -> `.env` и заполните ключи.
3. Скопируйте `config.example.yaml` -> `config.yaml`.
4. Для плагинов скопируйте:
   - `server/modules/discord/config.example.yaml` -> `server/modules/discord/config.yaml`
   - `server/modules/internal_api/config.example.yaml` -> `server/modules/internal_api/config.yaml`
5. (опционально) frontend:
   - `cd server/dashboard && npm install && npm run build`
6. Запуск:
   - `python server/main.py`