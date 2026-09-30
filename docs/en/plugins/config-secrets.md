<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Config и секреты плагинов

- Параметры плагина: `server/modules/<id>/config.yaml`.
- Секреты: `server/.env` и `server/core/secrets_loader.py`.
- Не храните токены в `config.yaml` плагина.

## Merge
`server/core/plugins/config.py` подмешивает plugin config в общий runtime dict до подстановки env secrets.