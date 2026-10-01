<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Cookbook: Background Worker Plugin

## Задача
Плагин, который периодически выполняет работу (синхронизация, отчёты, cleanup).

## Паттерн
- `resident` plugin
- основной цикл с `sleep`
- безопасная обработка исключений
- периодическая heartbeat-запись в лог

## Важно
Не блокируйте общий event loop тяжёлыми вычислениями без `asyncio.to_thread`/process offload.