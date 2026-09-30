<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Развёртывание WebSocket (WSS)

Шлюз Neyra отдаёт:

- HTTP API: `/v1/*`
- WebSocket:

  - `/v1/ws/chat`
  - `/v1/ws/audio`

## Локальная разработка

- Запустите ядро (вместе с Control API): `python server/main.py`
- Используйте `ws://127.0.0.1:8787/v1/ws/chat` и `ws://127.0.0.1:8787/v1/ws/audio`

## Продакшен

Поставьте reverse proxy (Nginx, Caddy, Traefik) с TLS:

- внешние клиенты ходят только на `wss://...`
- прокси прокидывает на локальный `ws://127.0.0.1:8787`

Пример публичного чата (префикс `/api` из `server/config/server.yaml`): `wss://neyra.owyx.site/api/v1/ws/chat`.

Важно:

- сохраняйте заголовки `Upgrade` и `Connection` для апгрейда WebSocket
- пробрасывайте `Authorization` (или используйте `?token=` в query)
- на публичном интерфейсе только HTTPS/WSS (без plain WS)

## frp (мини-ПК → VPS)

Канон публикации для удалённого Tauri-клиента (Этап 3): Neyra на **мини-ПК**, наружу через **frpc** → **frps** на VPS → Caddy/nginx (TLS). WebSocket должен проходить всю цепочку без обрыва. Подробности — [`docs/PLAN.md`](../../PLAN.md) §3 и [api-reverse-proxy](api-reverse-proxy.md).

## Дашборд и дорожная карта

Веб-дашборд (`server/dashboard/`) в основном использует REST `/v1`. Двусторонний WebSocket-мост дашборда и Event Bus — backlog в [`docs/PLAN.md`](../../PLAN.md). Эндпоинты `/v1/ws/chat` и `/v1/ws/audio` предназначены для программных клиентов (в т.ч. будущий `client/`).
