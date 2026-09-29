<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Режимы рантайма

## `python server/main.py` (core)
- Запускает Internal API (`/v1`), WebSocket и веб-интерфейс.
- Создаёт один `NeyraAgent`.
- Поднимает resident-плагины в daemon thread.

## `python server/main.py --mode console`
- Терминальный чат для отладки промптов.
- Без HTTP-стека и без веб-панели.

## Resident vs on_demand
- `resident`: плагин стартует при запуске ядра.
- `on_demand`: плагин вызывается через API/инструменты по требованию.