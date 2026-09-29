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

- Запустите ядро (вместе с API): `python server/main.py`
- Используйте `ws://127.0.0.1:8787/v1/ws/chat` и `ws://127.0.0.1:8787/v1/ws/audio`

## Продакшен

Поставьте reverse proxy (Nginx, Caddy, Traefik) с TLS:

- внешние клиенты ходят только на `wss://...`
- прокси прокидывает на локальный `ws://127.0.0.1:8787`

Важно:

- сохраняйте заголовки `Upgrade` и `Connection` для апгрейда WebSocket
- пробрасывайте `Authorization` (или используйте `?token=` в query)
- на публичном интерфейсе только HTTPS/WSS (без plain WS)

## Дорожная карта (этап 1 — мост для Web UI)

Для внешних клиентов чата/аудио продакшен почти всегда требует `wss://`. **Этап 1** добавляет **двусторонний мост** React-дашборда и Event Bus (pub/sub по WebSocket), чтобы браузер стал полноценным real-time control plane — см. `PLAN.md`, раздел «Этап 1». Сейчас этап отложен (сначала soak Discord+music). До моста дашборд опирается в основном на REST `/v1`, а эндпоинты `/v1/ws/chat` и `/v1/ws/audio` предназначены для программных клиентов.