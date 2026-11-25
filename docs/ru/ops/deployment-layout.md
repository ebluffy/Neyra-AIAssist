# Раскладка площадки Neyra (после 12.11.2026)

Одна площадка на домашнем сервере: ядро и сайт лежат рядом, база сайта — там же.

```
/opt/neyra/
├── server/   # ядро: main.py, core/, modules/, data/, .venv, config.yaml, .env
├── web/      # сайт v2: приложение и его база (Postgres)
└── server.pre-move-20261112-201015/   # остаток старого деплоя, можно удалить
```

## Что изменилось

До 12.11.2026 ядро лежало прямо в `/opt/neyra` (`main.py`, `core/`, `data/`, `.venv`). Перенос сделан скриптом: дерево переименовано в `server/`, создан пустой `web/`, поправлены абсолютные пути в venv и systemd-юните.

- systemd: `neyra.service` → `WorkingDirectory=/opt/neyra/server`, `ExecStart=/opt/neyra/server/.venv/bin/python /opt/neyra/server/main.py`.
- Данные и конфиг не копировались: `data/`, `config.yaml`, `.env`, `modules/` переехали вместе с деревом (переименование в пределах ФС).
- Даунтайм — около 40 минут по факту (ядро было остановлено до запуска скрипта); сам перенос занимает секунды.
- Остаток старого деплоя (`server/` с одним примером `modules/000EXAMPLE`, 76 КБ) отодвинут в `server.pre-move-20261112-201015/`, не удалён.

## Проверка после переноса

```bash
systemctl is-active neyra.service          # active
curl -fsS http://127.0.0.1:8787/v1/health/live   # {"ok":true}
/opt/neyra/server/.venv/bin/python -c 'import sys; print(sys.prefix)'  # /opt/neyra/server/.venv
```

`/v1/health/ready` требует токен (`dep_viewer`), поэтому без авторизации отвечает 401 — это норма.

## Что нужно поправить при следующем касании

- Удалить `server.pre-move-20261112-201015/` после того, как убедились, что всё работает.
- MCP devtools (`devtools/mcp_server`) запускать с `--server-root /opt/neyra/server`, если он установлен на этой же машине.
- Логи и бэкапы по-прежнему под `server/logs` и `server/data/backups`; в systemd путь не меняется.

## Сайт

`/opt/neyra/web/` — место для веб-клиента: приложение (`app/`) и его Postgres. Порт приложения — 127.0.0.1:3000, наружу публикуется через тот же reverse proxy/frp, что и ядро (см. `docs/ru/ops/api-reverse-proxy.md`). База сайта живёт в контейнере рядом и наружу не публикуется.
