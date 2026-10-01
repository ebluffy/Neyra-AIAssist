<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# WebSocket Audio

Endpoint: `ws://127.0.0.1:8787/v1/ws/audio`

Текущий статус: gateway-контракт (stub) для будущего полноценного аудио pipeline.

## Поддержка

- бинарные audio chunks
- `ping`/`pong`
- `commit` для финализации текущего батча
- interim/final transcript события (stub)