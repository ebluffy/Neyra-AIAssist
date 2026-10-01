<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Config и секреты плагинов

- Параметры плагина: `server/modules/<id>/config.yaml`.
- Секреты: `server/.env` и `server/core/secrets_loader.py`.
- Не храните токены в `config.yaml` плагина.

## Merge
`server/core/plugins/config.py` подмешивает plugin config в общий runtime dict до подстановки env secrets.