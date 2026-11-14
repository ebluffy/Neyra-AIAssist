# Выкладка сайта

`deploy-web.sh` собирает standalone-бандл, снимает дамп базы, применяет миграции
`web/db/migrations` и перезапускает `neyra-web.service`.

## Дамп базы

Скрипт сначала вызывает узкий root-хелпер `openbot-admin db-dump` (docker-сокет есть
только у root), затем откатывается на прямой `docker compose exec db pg_dump`.
Хелпер лежит рядом в репозитории:

```bash
sudo install -m 0755 devtools/deploy/openbot-admin /usr/local/sbin/openbot-admin
echo 'openbot ALL=(root) NOPASSWD: /usr/local/sbin/openbot-admin db-dump' \
  | sudo tee /etc/sudoers.d/openbot-admin
sudo visudo -cf /etc/sudoers.d/openbot-admin
```

Переменные: `NEYRA_COMPOSE_FILE`, `NEYRA_BACKUP_DIR`, `NEYRA_DB_SERVICE`,
`NEYRA_DB_USER`, `NEYRA_DB_NAME`, `NEYRA_KEEP_DUMPS`.

## Пропуск миграций

`SKIP_DB_MIGRATIONS=1` не отключает проверку схемы: скрипт считает sha256 набора
`web/db/migrations/*.sql` и сверяет с отметкой `/opt/neyra/web/app/web/.schema-migrations.sha`
от прошлой выкладки. Если в ветке появились новые миграции, выкладка останавливается,
пока их не применят обычным запуском. Это защищает от старта сайта на старой схеме.
