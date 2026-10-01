# Режимы рантайма

## `python server/main.py` (core)

- Запускает Control API в `server/core/api/` (`/v1`), WebSocket и статику веб-дашборда.
- Создаёт один `NeyraAgent`.
- Поднимает resident-плагины в daemon thread.

## `python server/main.py --mode console`

- Терминальный чат для отладки промптов.
- Без HTTP-стека и без веб-панели.

## Resident vs on_demand

- `resident`: плагин стартует при запуске ядра.
- `on_demand`: плагин вызывается через API/инструменты по требованию.
