# Выкладка сайта

`deploy-web.sh` собирает standalone-бандл, снимает дамп базы, применяет миграции
`web/db/migrations` и перезапускает `neyra-web.service`.

## Дамп базы

Штатный путь — узкий root-хелпер `openbot-admin db-dump` (docker-сокет есть только
у root). `neyra-web-setup.sh` ставит его сам; вручную:

```bash
sudo install -m 0755 devtools/deploy/openbot-admin /usr/local/sbin/openbot-admin
echo 'openbot ALL=(root) NOPASSWD: /usr/local/sbin/openbot-admin db-dump' \
  | sudo tee /etc/sudoers.d/openbot-admin
sudo visudo -cf /etc/sudoers.d/openbot-admin
```

Запись дампа безопасна к симлинкам: хелпер пишет во временный файл `mktemp`
(0600, `O_EXCL`) и переименовывает его в `pre-migrate-*.dump`, поэтому
подложенная ссылка заменяется, а не раскрывается. Каталог `/opt/neyra/web/backups`
принадлежит `root:root` с правами `0700`; `openbot` в него не пишет.

Имя сервиса БД: `NEYRA_DB_SERVICE`, иначе сначала `postgres` (как в
`web/docker-compose.yml`), затем `db` (старые площадки).

Запасной путь без хелпера (только если `sudo -n openbot-admin` недоступен) —
`docker compose exec … pg_dump` в каталог `/opt/neyra/web/backups-app`
(`openbot:openbot`, `0700`, тоже через `mktemp` + `mv`, сервис `postgres`, затем `db`).

Переменные: `NEYRA_COMPOSE_FILE`, `NEYRA_BACKUP_DIR`, `NEYRA_BACKUP_APP_DIR`,
`NEYRA_DB_SERVICE`, `NEYRA_DB_USER`, `NEYRA_DB_NAME`, `NEYRA_KEEP_DUMPS`.

`docker-compose.yml` на площадке остаётся `root:root 0644`: `openbot` не должен
менять описание сервисов, которые запускает root.

## Пропуск миграций

`SKIP_DB_MIGRATIONS=1` не отключает проверку схемы: скрипт считает sha256 набора
`web/db/migrations/*.sql` и сверяет с отметкой `/opt/neyra/web/app/web/.schema-migrations.sha`
от прошлой выкладки. Если в ветке появились новые миграции, выкладка останавливается,
пока их не применят обычным запуском. Это защищает от старта сайта на старой схеме.

## Проверка без площадки

`DRY=1 bash devtools/deploy/deploy-web.sh` собирает standalone-бандл и проверяет
путь выкладки, но не пишет в `/opt/neyra`: ни дамп, ни миграции, ни `rsync`.
