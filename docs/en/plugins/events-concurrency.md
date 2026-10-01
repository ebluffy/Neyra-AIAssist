<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# События и конкурентность

- Use `server/core/runtime/event_bus.py` for event exchange.
- Долгие операции выносите в `asyncio.to_thread`/отдельный процесс.
- Resident plugins не должны блокировать event loop API.
- Для внешних вызовов всегда ставьте timeout и retry policy.