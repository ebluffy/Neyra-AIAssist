# FAQ

## Control API — это внешний облачный сервис?
Нет. Это HTTP/WebSocket-стек в `server/core/api/` процесса Neyra на вашем домашнем сервере (или локальной машине). Публичный URL (`https://neyra.owyx.site/api/v1`) — только если вы сами настроили DNS, frp и reverse proxy.

## Где включать/выключать плагины?
В `server/modules/<id>/plugin.yaml`, поле `enabled`.

## Где хранить токены?
Только в `server/.env`.

## Почему плагин не стартует после изменения config?
Проверьте `plugin.yaml` (`enabled/lifecycle`) и перезапустите процесс для resident-плагина.