# Выкладка сайта

`deploy-web.sh` собирает standalone-бандл, снимает дамп базы, применяет миграции
`web/db/migrations` и перезапускает `neyra-web.service`.

## Права: что принадлежит root, а что openbot

`/opt/neyra/web` — `root:root 0755`. openbot владеет только `app/` и `node/` и
читает `.env` (`root:openbot 0640`). Поэтому openbot не может подменить
`docker-compose.yml`, `db.env` или `.env`, а root не пишет в openbot-каталоги.

| Путь | Владелец | Режим | Кто пишет |
| --- | --- | --- | --- |
| `/opt/neyra/web` | root:root | 0755 | setup |
| `/opt/neyra/web/app`, `node` | openbot:openbot | — | deploy |
| `/opt/neyra/web/.env` | root:openbot | 0640 | setup (openbot читает) |
| `/opt/neyra/web/docker-compose.yml` | root:root | 0644 | setup |
| `/opt/neyra/web/db.env` | root:root | 0600 | setup (только compose) |
| `/var/backups/neyra-web` | root:root | 0700 | root-хелпер |

## Дамп базы

Единственный путь к docker — root-хелпер `openbot-admin db-dump` (docker-сокет
есть только у root). `neyra-web-setup.sh` ставит его сам и пишет узкое правило
sudoers; прямых правил `docker compose exec` от root нет.

```bash
sudo install -m 0755 devtools/deploy/openbot-admin /usr/local/sbin/openbot-admin
echo 'openbot ALL=(root) NOPASSWD: /usr/local/sbin/openbot-admin db-dump' \
  | sudo tee /etc/sudoers.d/openbot-admin
sudo visudo -cf /etc/sudoers.d/openbot-admin
```

Хелпер работает только с root-путями:

- `BACKUP_DIR=/var/backups/neyra-web` (родитель `/var/backups` — root);
- `COMPOSE_FILE=/opt/neyra/web/docker-compose.yml`, `COMPOSE_ENV_FILE=/opt/neyra/web/db.env`;
- родитель каждого пути должен принадлежать root и не быть writable для группы и
  остальных, иначе отказ (`openbot` мог бы подменить каталог или файл);
- запись дампа: `mktemp` (O_EXCL, 0600) через fd проверенного каталога, затем
  `mv` в `pre-migrate-*.dump` — подложенная ссылка заменяется, а не раскрывается.

Compose вызывается явно: `docker compose -p web --env-file /opt/neyra/web/db.env
-f /opt/neyra/web/docker-compose.yml`. Проект `web` сохраняет имена контейнеров
существующих площадок.

Имя сервиса БД: `NEYRA_DB_SERVICE`, иначе сначала `postgres` (как в
`web/docker-compose.yml`), затем `db` (старые площадки).

Переменные: `NEYRA_COMPOSE_FILE`, `NEYRA_COMPOSE_ENV_FILE`,
`NEYRA_COMPOSE_PROJECT`, `NEYRA_BACKUP_DIR`, `NEYRA_DB_SERVICE`, `NEYRA_DB_USER`,
`NEYRA_DB_NAME`, `NEYRA_KEEP_DUMPS`.

## Пропуск миграций

`SKIP_DB_MIGRATIONS=1` не отключает проверку схемы: скрипт считает sha256 набора
`web/db/migrations/*.sql` и сверяет с отметкой `/opt/neyra/web/app/web/.schema-migrations.sha`
от прошлой выкладки. Если в ветке появились новые миграции, выкладка останавливается,
пока их не применят обычным запуском. Это защищает от старта сайта на старой схеме.

## Проверка без площадки

`DRY=1 bash devtools/deploy/deploy-web.sh` собирает standalone-бандл и проверяет
путь выкладки, но не пишет в `/opt/neyra`: ни дамп, ни миграции, ни `rsync`.

## Обновление ядра и data_dir

`update-core.sh` до шага vault резолвит `data_dir` ядра (`NEYRA_DATA_DIR` →
`paths.data_dir` → `./data`) через `check-data-dir.py`. Если каталог лежит вне
выкладываемого `/opt/neyra/server`, скрипт останавливается: полный бэкап и
автооткат копируют только каталог выкладки, и внешние данные в них не попадут.

