# §8.1/§9/§8.2/§8.4/§8.7: серверная приёмка для клиента

Родитель: [PR #36](https://github.com/ebluffy/Neyra-AIAssist/pull/36), база `fec9a2f1476e2a937c09554f6995d1e81048c1ea`.
Источник: [PLAN.md](../PLAN.md), [приёмка владельца](https://github.com/ebluffy/Neyra-AIAssist/pull/36#issuecomment-6619352121).

Приоритет и порядок: Параллельно 01–02; внешние интеграции отдельно.

## Работа

Разделить транспорт, backend и поведение моделей. Подтвердить auth/HTTPS/WSS, backup/restore, память/persona и роль brain→talk, отказ/таймаут на тестовых копиях. Не считать AIHope маршрутом тестирования. Вне объёма этого PR и вынесено в [#68](https://github.com/ebluffy/Neyra-AIAssist/issues/68): живая проверка модулей и интеграций с токенами (Discord GIF/music/history, browsermcp, привязка фактов), боевой TLS/proxy с доменом, качество моделей и persona-поведение, полный dataset, Windows/установщики, а также найденный дефект health при 429 и отсутствие `/chat/completions` fallback для talk.

## Готово, когда

- [x] Зафиксированы версия исходного кода, сценарии, результаты, задержки и фактические маршруты без приватных данных. Миграция и restore выполнялись только на копиях; production-конфиг, исходная БД, модели и прежние backup-файлы не менялись.
- [x] Для пройденных локальных backup/restore и HTTPS/WSS smoke добавлены повторяемые скрипты и команды. CI, локальные/изолированные проверки и аппаратная приёмка разделены.
- [x] PLAN уточнён по выполненным проверкам только в §8.1; §0 и §11.2 не менялись.

Этот PR содержит серверную часть backup/restore и приёмочные проверки. Локальные автоматические тесты используют синтетические данные; отдельно выполнены миграция и backup/restore на закрытой копии SQLite, а также TLS/HTTPS/WSS smoke на временном локальном сервисе. Это не приёмка работающего стенда, внешних интеграций или качества моделей. Merge возможен только в ветку PR #36 после закрытия всех задач и замечаний.

## Сделано в этом PR

- `/v1/backup/run`, `/v1/backup/list` и `/v1/backup/restore` отдают клиенту белый список полей: локальные пути (`archive`, `external_ref`, `aside_path`, `restored_from`, `memory_root`) наружу не уходят, внешняя копия видна как `external_uploaded` + имя файла.
- Архив получает уникальное имя без перезаписи. Если hardlink недоступен, архив копируется в скрытый временный staging-каталог и появляется под финальным именем только после атомарного `os.replace`; незаполненный архив не виден `list`/`restore`. Публикации сериализуются межпроцессной блокировкой.
- `list_backups` сортирует по метке времени и числовому суффиксу, а не по строке: `-10` действительно новее `-2`, базовое имя старше `-1`.
- Staging бэкапа, публикации и распаковка restore живут в каталоге бэкапов, а не в CWD. Длительная операция удерживает sibling lock-файл; очистка из другого процесса пропускает активный staging. При старте `BackupManager` удаляет брошенные staging-каталоги, `.part`-файлы и архивные staging-артефакты старше часа.
- Приёмочные тесты (`tests/test_backup_restore_api.py`) проверяют fallback без hardlink, отсутствие финального имени до атомарной публикации, конкурентную публикацию без перезаписи, отказ `os.replace`, числовой порядок суффиксов и очистку старых артефактов, в том числе из свежего subprocess.

## Приёмка на отдельной копии БД · 2026-11-11

- Проверенный кодовый commit: `71408583bb5fa1ebc9bd534c6005175a9042ad8c` (Linux x86_64, Python 3.12.3, исходный checkout). На этом exact SHA повторены полный pytest suite, copy-only DB smoke и HTTPS/WSS smoke; последующие изменения документации код не меняют.
- Исходный активный SQLite-файл был скопирован через SQLite backup API в закрытый локальный каталог. Проверка выполнялась только на этой копии; работающий сервер, исходная БД, конфиги, модели и старые backup-файлы не менялись. Текущая копия уже имела schema version 7, поэтому миграций для неё не требовалось.
- Для проверки перехода между версиями отдельная копия существующего архивного DB-файла с версиями 1–4 мигрирована кодом `SqliteStore` до версии 7. SQLite integrity до/после — `ok`; количество строк в основных таблицах одинаково; операция заняла 10.11 ms на этой небольшой копии.
- Backup/restore прогнан через локальный `BackupManager` на копии текущей БД: архив 83,482 bytes, создание 28.15 ms, staging + apply restore 6.59 ms. Zip и восстановленная SQLite прошли integrity-check; число строк основных таблиц не изменилось; контрольный маркер, добавленный только в рабочую копию, удалён restore, маркерный файл Chroma вернулся к исходному значению.
- Это локальный файловый маршрут `SQLite backup API → BackupManager.run_backup → prepare_restore → apply_pending_restore` на одном небольшом наборе данных, не публичный HTTP/API или TLS/WSS прогон. Числа не представляют производительность на полной актуальной БД и не подтверждают работу моделей или внешних интеграций.

## Изолированная проверка HTTPS/WSS и авторизации · 2026-11-11

- Кодовый commit, проверенный этим smoke: `71408583bb5fa1ebc9bd534c6005175a9042ad8c`.
- На Linux x86_64, Python 3.12.3, отдельном временном каталоге запущен временный экземпляр `build_app` под Uvicorn 0.54.0 с одноразовым self-signed localhost-сертификатом. Использованы только тестовые токены и stub-объекты; файлы, конфигурация и процесс Neyra не подключались, внешние модели не вызывались.
- HTTPS: `/v1/health/live` без токена — 200; `/v1/health/ready` без токена — 401; тот же ready с viewer bearer — 200.
- WSS: handshake без токена отклонён; admin bearer принят, сервер вернул `hello` с протоколом `neyra.ws.chat.v1`. Проверка ограничена TLS, handshake и политикой доступа; chat/model-запрос не отправлялся.
- Воспроизведение из `server/` при установленных зависимостях Neyra и `openssl`: `python scripts/pr65_https_wss_smoke.py`. Скрипт сам создаёт временный self-signed сертификат с SAN `localhost`/`127.0.0.1`, запускает настоящий `build_app` под Uvicorn TLS только на loopback, проверяет HTTPS и две WSS-попытки; токены одноразовые, chat/model-запрос не отправляется. Для проверки backup/restore передай закрытую копию SQLite: `python scripts/pr65_backup_restore_copy_smoke.py --sqlite-copy /path/to/private-db-copy.sqlite3 --i-confirm-this-is-a-copy`. Скрипт сначала создаёт отдельную временную SQLite-копию через backup API, мигрирует её, выполняет настоящий `BackupManager.run_backup` и `prepare_restore`/`apply_pending_restore`, проверяет integrity и исчезновение временной мутации. Не указывай путь работающей БД.

## Приёмка на копиях рабочего стенда (MiniPC) · 2026-11-11

- Проверенный код: `d20190e0f2fdcd2eb725c1f70cf2310c4e8d5459` (тот же код, что `71408583bb5fa1ebc9bd534c6005175a9042ad8c`; коммит `d20190e` менял только документы). Linux x86_64, Python 3.12.3 из venv рабочей Neyra.
- Данные: копии рабочей Neyra на MiniPC — `neyra_memory.db` через SQLite backup API (schema v7, `integrity_check=ok`), Chroma (11 записей), working memory, people, дневник (47 записей), журнал (9); персона и appearance байт-в-байт. Рабочий сервер, его БД, конфиг, модели и прежние бэкапы не менялись; всё выполнялось в закрытом каталоге `NeyraWork/live65`, сервер — на отдельном loopback-порту.
- Повторяемость: checkout указанного SHA, копия данных в `server/data/memory`, реальные `config/*.yaml` и `prompts/persona.md` в копии, `python main.py --mode core` на loopback. Caddy ставится отдельным бинарником в тот же каталог; ключевые строки Caddyfile: `:9443 { tls <cert> <key>; reverse_proxy 127.0.0.1:8788 }` и `:9444 { tls <cert> <key>; handle_path /api/* { reverse_proxy 127.0.0.1:8788 } }`. Сертификат — отдельный self-signed с SAN `localhost`/`127.0.0.1`.
- TLS/reverse proxy: `GET /v1/health/live` 200; `/v1/health/ready` 401 без токена и 200 с bearer; через `/api/*` те же 200/401, неизвестный путь 404; HTTP/2. WSS через прокси: без токена handshake отклонён (403), с admin bearer `hello` с протоколом `neyra.ws.chat.v1` — и для прямого пути, и для `/api`-префикса.
- backup/restore на копии рабочей БД: `python scripts/pr65_backup_restore_copy_smoke.py --sqlite-copy <copy> --i-confirm-this-is-a-copy` — PASS (schema v7, integrity ok).
- Память и персона: `POST /v1/memory/search` на копии (реальная Chroma и локальные embeddings) вернул 3 релевантные записи за 89 мс. Офлайн-сборка talk-промпта из реального конфига: персона совпадает с файлом байт-в-байт, в промпт попадают персона, extra memory, working memory и имя пользователя; brain-промпт персону не содержит — как и задумано.
- Отказ провайдера: AIHope отдавал `429 Rate limit or quota exceeded` на `/chat/completions` при доступном `/models`; `POST /v1/chat` вернул HTTP 200 с `brain_unavailable`, `error_class=OpenAIRateLimitError`, `sdk_retries=1`, сервер остался работоспособным. Воспроизведение: провайдер, у которого `/models` отвечает 200, а `/chat/completions` — 429.
- Таймаут провайдера: отдельный экземпляр с `llm.providers.*.base_url` на локальный слушатель, который принимает соединение и не отвечает, при `timeout_seconds: 3` и `max_retries: 0` дал `OpenAITimeoutError` через 3010 мс, graceful-ответ и `/v1/health/ready` 200 после.
- Наблюдаемость: в момент 429 `/v1/health` показывал `backend.ok=true`, потому что проверяет только `/v1/models`; упавшие ходы видны в `/v1/llm/activity` с `error_class`. Health не отражает истощение квоты — вынесено в [#68](https://github.com/ebluffy/Neyra-AIAssist/issues/68) вместе с остатком.
- Модули: проверен только failure-mode — без токенов browsermcp MCP-сервер падает и ретраится, discord resident plugin завершается с ошибкой про `DISCORD_TOKEN`; сервер и API при этом живы, `/v1/health` показывает integration issue. Живая проверка модулей и интеграций (Discord GIF/music/history, browsermcp, привязка фактов) — в [#68](https://github.com/ebluffy/Neyra-AIAssist/issues/68).
- Модели: оба реальных провайдера были недоступны (AIHope 429; ключ OpenRouter владелец заменил). С разрешения владельца live-ход выполнен на бесплатных моделях OpenRouter. Talk-лейн ходит в `/v1/responses`, которого у OpenRouter нет, поэтому для прогона поднимался локальный адаптер `responses → chat/completions` (в репозиторий не входит). **Без такого адаптера talk с провайдером без `/v1/responses` не работает** — это отдельный пункт в #68. Полный ход brain→talk завершился: 3 вызова brain, talk 200, HTTP 200, `status=completed`; в talk-запросе присутствовали реальная персона и реальная память (system 6370 символов). На малых free-моделях качество памяти не проверить: на вопрос по записи из промпта модель отвечает «в памяти нет записей».

## Остаётся открытым

Остаток вынесен в [#68](https://github.com/ebluffy/Neyra-AIAssist/issues/68):

- живая проверка модулей и интеграций с реальными токенами: Discord GIF/music/history, browsermcp, привязка фактов;
- боевая конфигурация TLS/reverse-proxy и домен;
- качество моделей и persona-поведение на реальном провайдере;
- полный dataset для замеров backup/restore;
- Windows `msvcrt.locking`, установщики и аппаратная приёмка;
- health при 429 (найденный дефект) и отсутствие `/chat/completions` fallback для talk при провайдере без `/v1/responses`.
