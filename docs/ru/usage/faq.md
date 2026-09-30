<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# FAQ

## Control API — это внешний облачный сервис?
Нет. Это HTTP/WebSocket-стек в `server/core/api/` процесса Neyra на вашей машине (или мини-ПК). Публичный URL (`https://neyra.owyx.site/api/v1`) — только если вы сами настроили DNS, frp и reverse proxy.

## Где включать/выключать плагины?
В `server/modules/<id>/plugin.yaml`, поле `enabled`.

## Где хранить токены?
Только в `server/.env`.

## Почему плагин не стартует после изменения config?
Проверьте `plugin.yaml` (`enabled/lifecycle`) и перезапустите процесс для resident-плагина.