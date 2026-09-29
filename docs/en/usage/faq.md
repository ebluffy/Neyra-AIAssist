<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# FAQ

## Internal API — это внешний облачный сервис?
Нет. Это локальный API процесса Neyra на вашей машине/сервере.

## Где включать/выключать плагины?
В `server/modules/<id>/plugin.yaml`, поле `enabled`.

## Где хранить токены?
Только в `.env`.

## Почему плагин не стартует после изменения config?
Проверьте `plugin.yaml` (`enabled/lifecycle`) и перезапустите процесс для resident-плагина.