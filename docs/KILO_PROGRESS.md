# Финализация PR #27

Дата контроля: 2026-10-16.

## AR-28 после review 2e31e65

- AR-27 подтверждён FIXED; исправлен единственный новый P3: штатный отказ
  builder теперь логирует plugin_id и ограниченную 2000 символами причину.
  Поле raw не логируется и не возвращается инструментом. Tool по-прежнему
  выдаёт только безопасную константу.
- caplog-регрессии проверяют именно warning инструмента для JSON parse,
  write и manifest failures; сырой невалидный provider output отсутствует
  и в ответе, и в логах. Полный pytest: **185 passed**, compileall passed.
  CI нового amend проверяется после push.
- Авторевью ожидает пользователь, циклического опроса AR нет. Merge и deploy
  до выполнения согласованных условий не запускаются.

## AR-27 после review 88d764f

- Grok Bot подтвердил AR-22…26 как FIXED и оставил один P3: штатные
  `ok: false` PluginBuilder сериализовались в tool вместе с raw/error.
- Теперь любой отказ builder, как и исключение, возвращает одну константу
  `create_or_edit_plugin failed; see server log`. Сырой provider output,
  exception text и внутренние пути не уходят в tool-ответ. Write failure
  получает отдельную серверную запись с типом ошибки.
- Четыре регрессии вызывают настоящий tool с изолированным builder: JSON parse,
  write, manifest и exception failure. Внешних вызовов нет. Полный pytest:
  **185 passed**, compileall passed. Dashboard не менялся относительно
  проверенного 88d764f (35 unit / 10 E2E). CI нового amend проверяется после push.
- Автоматическое AR пользователь проверяет сам и сообщает о появлении;
  GitHub не опрашивается циклически ради ожидания AR. Merge до нового LGTM
  не выполняется, деплой не разрешён.

## AR-22…26 после review 808391e

- AR-22: summaries сначала проверяются для всех владельцев; ошибка записи
  откатывает уже добавленные digest. Регрессии: A успешно/B пусто, provider
  error или отказ записи, затем успешный повтор без дубликатов и без потери
  исходников.
- AR-23: debug и dashboard используют одинаковый bounded scoped STM snapshot;
  MCP видит окна вне хода. Старое flat поле сохранено для совместимости.
- AR-24: канонический diary job управляется memory.diary_after_turn. Мёртвые
  async/emotional diary schedulers и настройки клиентов удалены; старые ключи
  явно deprecated/ignored. LTM tone metadata продолжают работать отдельно.
- AR-25: возвращён ввод УДАЛИТЬ перед удалением записи журнала; browser/unit
  tests проверяют заблокированную кнопку и ошибку после подтверждения.
- AR-26: generation по секциям, включая наследование вложенными jobs. Чистка
  соседней секции сохраняет запись, чистка своей запрещает устаревшую запись.
- Локально: **181 pytest passed**, compileall, **14 stage/offline scripts**;
  Node 22: **35 unit**, lint/typecheck/build и **10 browser scenarios passed**.
  CI и новое AR итогового amend проверяются после push; merge до них запрещён.
- Новое решение пользователя: сервер первым, самостоятельный Windows/Linux
  клиент в конце. В PLAN §15 и VKR_READINESS зафиксированы критерии серверного
  рубежа и live-границы; точный процент готовности без них не заявляется.

Следующие записи сохраняют историю предыдущих SHA.

## Завершение оставшейся реализации после Kilo

- Закрыты локальные остатки: coder routing из общей конфигурации, scoped STM/
  diary в pipeline и pre-context, автоматическая запись после успешной пары,
  три слоя памяти и журнал в System, действующий lifecycle фоновых reports.
- Persona напрямую в talk, включая rewrite; brain и character-profile tool
  не получают persona. Служебные инструкции английские, динамические данные
  отдельно human-role. Карта вызовов — `PROMPT_AUDIT.md`.
- Reflection не угадывает владельца по display name; consolidation разделяет
  пользователей и сохраняет owner. Failed/empty summary сохраняет исходники.
  Wipe сериализован с записями и инвалидирует устаревшие jobs.
- Usage/request IDs собираются и из streaming chunks; completion ID отделён
  от request ID. Фоновые jobs имеют собственный отчёт/parent, не изменяют
  закрытый отчёт ответа и не вытесняют историю Discord `/model`.
- Локально: **157 pytest**, **14 stage/offline scripts**, compileall; Node 22:
  **35 unit**, lint/typecheck/build, **10 browser scenarios** с временным
  backend/SQLite и настоящими API-вызовами. Existing lint warning в LogViewer
  и Vite bundle-size warning не являются ошибками проверок.
- Финальный CI и новое AR проверяются после push; старое LGTM для f43beae
  не является ревью нового diff. Merge разрешён пользователем только после
  зелёных проверок; deploy и следующий PR требуют отдельной команды.
- Live-критерии остаются в PLAN: реальные модели/Discord/voice/browsermcp,
  production-copy migration, provider billing и lifecycle стенда. Никакие
  рабочие токены/данные или внешние LLM в локальной приёмке не использовались.

Ниже — история предыдущих состояний, а не перечень текущих недоделок.

## Передача и исправления после остановки Kilo

- Входной SHA `9cb2bed501b36b0525083e6fcb5728e134320f6e`: CI run
  `38789860436`, 6 jobs pass, Pytest 4 failed / 133 passed. Последнее AR
  для этого SHA: AR-14/15/16/18/19/20 открыты, inline-комментариев нет.
- Подтверждённые дефекты: Discord metadata ошибочно вернулись в system-role,
  `drop_extra_context` игнорировался, тесты использовали два разных маркера.
  Исправлено в brain/talk/vision и тестах; отдельно проверены пустая/непустая
  история и обычный/урезанный контекст. Маркер один: `[DISCORD CONTEXT]`.
- Удаление diary/journal в Control API остаётся глобальным действием admin;
  это явно задокументировано в RU/EN API и покрыто проверками отказа
  viewer/maintainer, успешного удаления scoped entry администратором и 404
  при повторном удалении. Внутренние фильтры store не заменяют API auth.
- Убран локальный абсолютный путь из этого файла; очищены trailing spaces
  в auth-тестах, `git diff --check origin/main` проходит.
- В существующем `server/.venv` зависимости доступны: полный pytest
  **142 passed**. Все 4 stage verification и 10 standalone offline scripts
  из CI прошли; compileall прошёл. Реальные провайдеры и Discord не вызывались.
- Быстрая проверка реализации не подтвердила полное выполнение первоначального
  большого задания. BUG-01 по выбору coder-провайдера не закрыт; scoped diary
  ещё не интегрирован во все реальные пути; интерфейс §13 переделан частично;
  background trace helpers не вызываются production jobs. Уточнены PLAN,
  BUGS и MODEL_TRACE, эти остатки не маскируются под live-only проверки.
- Ниже сохранена история предыдущих попыток. Упоминания отсутствующих
  зависимостей/старых красных CI относятся к тем попыткам, не к текущему
  локальному прогону. Итоговые dashboard/CI результаты будут добавлены ниже.

## Исходное состояние

- Репозиторий: Neyra-AIAssist (корень текущей рабочей копии).
- Ветка: `test/dashboard-auth-coverage`.
- Локальный и удалённый head на входе: `73650ef4b0927b74cfd9a91e4a26ac28fe622ed0`.
- `origin/main`: `7173101308463fa2c27807d6359415777e0ef481`.
- До финального amend ветка содержит ровно один коммит сверх `origin/main`.
- `origin/HEAD` и `origin/main`: `7173101308463fa2c27807d6359415777e0ef481`.
- PR head на входе: `73650ef4b0927b74cfd9a91e4a26ac28fe622ed0`; PR base: `main` at `7173101308463fa2c27807d6359415777e0ef481`.
- История: head имеет 1 коммит сверх `origin/main`; merge-base совпадает с `origin/main`.
- PR #27: `OPEN`, не draft, `MERGEABLE`, `CLEAN`; review decision в API не задан.
- CI run `38630622364`: все 7 jobs `pass` (Layout & tree, Config layers, LLM backends & memory, HTTP API & auth, Pytest, Dashboard lint/typecheck/test/build, Secrets scan).
- Последнее найденное авторевью было для старого SHA `7c18e78188adf795afdc9a38711a9a54f4719808`, не для текущего head `a18e8cf...`: итоговый комментарий сообщает `LGTM` и закрытие AR-1...AR-12. GraphQL: inline review threads `totalCount: 0`; REST `pulls/27/comments` также пуст. Нужна новая проверка AR именно текущего head.
- Рабочее дерево до этой записи: изменены пользовательские `docs/PLAN.md` и `docs/BUGS.md`, а также код и offline-регрессии текущей работы; незатреканы пользовательские `AGENTS.md` и `.codegraph/`. Последние два файла не добавлять в работу.

## Проверенные документы

- `AGENTS.md`: server/client/devtools разделены; клиент 3b пока scaffold-only; secrets/runtime data приватны; roadmap каноничен в `docs/PLAN.md`.
- `docs/PLAN.md`: стадии 1, 2 и dashboard D1-D8 отмечены выполненными; локальная 3a #27 отмечена выполненной; настоящие LLM/Discord остаются отдельной live-приёмкой; §12 имеет приоритет над следующими работами; §13 требует переработать memory UI после аудита §12.
- §7: account-first people memory, строгая привязка по platform ID, wipe с `confirm: "WIPE"`, diary/journal и propose-only merge; cutover требует wipe.
- §7.5: mood/relations только план, отдельный PR после стабилизации Memory v2.
- §12: сначала проследить реальные system prompts и lane boundaries; persona только в talk, brain планирует/возвращает факты и инструменты, финальный голос принадлежит talk; добавить offline-проверки сообщений и отдельно оставить live-проверку моделей.
- §13: короткая память = фактический chat context, промежуточная = автоматический diary после успешной пары, долгая = reflection-selected facts с происхождением/актуальностью; убрать ручное добавление, сохранить очистку/wipe/delete/roles/API, не отключить retrieval.
- `docs/BUGS.md`: BUG-2026-10-14-01...07 остаются отложенными, включая plugin create/OpenRouter 404, browsermcp reconnect, WebSearch/fallback, first-token timeout, memory update 502, INFO leakage, GIF/music intent. Приватные стендовые логи в репозитории не хранить.
- `docs/stage3a-validation.md`: локальный изолированный backend, временная SQLite, fake models, без deploy/real LLM/Discord; application-level evidence ограничен тем, что буферизует API, SDK-internal retries/provider routing не наблюдаемы.
- Architecture/ADR docs: core в `server/core`, plugins в `server/modules`, dashboard на FastAPI static serving, secrets только `server/.env`, runtime data в `server/data`/`server/logs`, Control API loopback по умолчанию, конфиги layered с env secret overlay, Memory Hub является источником истины.
- `server/dashboard/DESIGN.md`: dense technical calm ops console; UI work должен сохранять эту направленность.

## AR и live blockers

- Требуют воспроизведения только при отдельном разрешённом live-прогоне: реальные модели должны соблюдать conversation modes и vision instructions; реальный Discord должен подтвердить normalized context, streaming, `/model` и module lifecycle; Discord vision/structured responses остаются открыты.
- Открытые стендовые BUG-01...07 не являются закрытыми только потому, что CI PR зелёный; проверять их отдельными offline fixtures или авторизованным стендом без публикации приватных логов.
- Для текущего head отдельного AR не найдено: старый AR закрыт на `7c18e78`, inline threads сейчас отсутствуют. Это блокер автоматического review, а не доказательство отсутствия регрессий в `a18e8cf`.

## Проверки из актуального CI

- `python -m compileall -q server devtools/mcp_server`
- `python server/scripts/verify_stage_1b.py`
- `python server/scripts/verify_stage_1c.py`
- `python server/scripts/verify_stage_1d.py`
- `python server/scripts/verify_stage_2_api.py`
- `cd server && python scripts/test_memory_hub_smoke.py && python scripts/test_memory_cutover_offline.py && python scripts/test_memory_v2_people_offline.py && python scripts/test_brain_hard_fail_offline.py && python scripts/test_stage2_security_offline.py && python scripts/test_snowflake_offline.py && python scripts/test_discord_music_intent_offline.py && python scripts/test_people_no_seed_offline.py && python scripts/test_backup_restore_offline.py && python scripts/test_lavalink_managed_offline.py`
- `cd server && pytest -q`
- `cd server/dashboard && npm ci && npm run lint && npm run typecheck && npm run test -- --run && npm run build`
- CI E2E дополнительно: `npx playwright install --with-deps chromium`, затем `npm run test:e2e` с временным backend.
- Проверять только после явного решения о локальном прогоне; на момент контроля установки и приложение не запускались.

## Локальная среда

- Найден `server/venv`, Python `3.14.8`, установлен `pytest 9.1.1` и `fastapi 0.143.1`.
- Системные версии: Python `3.14.8`, Node `v26.11.1`, npm `12.2.0`; CI использует Python 3.12 и Node 22.
- В `server/venv` не обнаружен `langchain-core`; `playwright` не обнаружен как Python package.
- `server/dashboard/node_modules`, `dist` и `test-results` уже существуют; наличие не означает проверку на Node 22.

## Следующие независимые волны

- §12 prompts/lanes: `server/core/agent/`, prompt builders, brain/talk/vision/retry/rewrite tests; не смешивать с dashboard.
- Memory data flow: `server/core/memory/`, reflection/background paths и offline tests; отдельно проверить ID isolation, stale/conflicting facts, duplicate writes и provider failure.
- §13 dashboard: memory screens/API/tests только после §12 mapping; сохранить wipe/delete/roles/API и убрать только ручной diary input.
- BUG-01...07: отдельные узкие fixtures/тесты по одному багу, без live provider calls и без runtime data в git.
- Live acceptance: отдельный явно разрешённый стенд для real models/Discord/WSS; не считать локальные fake-model E2E доказательством live-критериев.

## Интеграционная проверка текущей рабочей копии

- Проверены `git status`, HEAD/base/remote PR state, полный diff/diff-check и codegraph для prompt pipeline, memory/dashboard API, BUG-затронутых модулей и `model_trace`; чужие изменения, `AGENTS.md` и `.codegraph/` не трогались.
- Подтверждённый defect исправлен: добавлен отсутствующий импорт `Plus` в `server/dashboard/src/screens/MemoryScreen.tsx`, ранее ломавший typecheck и build.
- Прошло: `cd server && python -m compileall -q .`; `verify_stage_1b.py`; `verify_stage_1c.py`; `test_memory_hub_smoke.py`; `test_memory_cutover_offline.py`; `test_memory_v2_people_offline.py`; `test_snowflake_offline.py`; `test_people_no_seed_offline.py`; `test_discord_music_intent_offline.py`; `test_backup_restore_offline.py`; `test_lavalink_managed_offline.py`; targeted MCP regression; dashboard `npm run typecheck`; dashboard `npm run build`; dashboard `npm run lint` с 1 warning (`LogViewer.tsx:104`, `react-hooks/incompatible-library`); `git diff --check`.
- Заблокировано окружением: `server/venv` использует Python `3.14.8`, но не содержит `langchain_core`; системный Python не содержит `pytest`; `verify_stage_1d.py` и `verify_stage_2_api.py` не могут импортировать `httpx`/`fastapi`; `test_brain_hard_fail_offline.py` и `test_stage2_security_offline.py` не могут импортировать `langchain_core`; полный pytest прерван collection errors. Зависимости не устанавливались, приложение не запускалось.
- Dashboard unit tests запускались на Node `v26.11.1` вместо CI Node 22: `26 passed, 6 failed` из-за окруженческих `localStorage`/`AbortSignal` особенностей. `npm run test:e2e` не запускался, поскольку workflow требует временный backend/application; live providers, tokens, Discord и deploy не запускались.
- Дополнительный локальный фикс: MCP stdio при отсутствующем MCP runtime или executable теперь помечается как `missing executable` без reconnect; targeted regression проходит. Два новых regression-теста остаются несовместимыми с текущим API/семантикой (keyword-only builder call и first-write diary dedupe) и не маскируются изменением production-кода.
- Нерешённые вопросы: полный pytest и API/brain/security regressions требуют CI-совместимого `server/venv`; Node 22 dashboard unit/E2E требуют CI-совместимого окружения; live models, Discord, WSS и BUG-01...07 остаются отдельной приёмкой.
- Consolidation: PR остаётся открытым и remote head не менялся на момент контроля; итоговый commit может содержать только intended tracked files и согласованные docs, без `AGENTS.md`/`.codegraph/`.

В рамках текущего прогона обновлены только фактические записи `PLAN.md`/`KILO_PROGRESS.md` и подготовлены mode fixes; `AGENTS.md` и `.codegraph/` не изменялись. До итогового commit/push не выполнялись merge, deploy, live application или provider calls.

## Проверка после CI findings

- PR CI run `38763988786` для предыдущего head завершился с тремя failing jobs: `Pytest` (`13 failed, 124 passed`), `LLM backends & memory` (один hard-fail offline memory/security smoke) и dashboard E2E (2 failure: desktop/mobile сценарий сохранения настроек через следующий offline turn; остальные 6 E2E прошли).
- `Config layers`, `HTTP API & auth`, `Layout & tree` и `Secrets scan` в том же run прошли. CI также не сообщил о секретах в diff.
- В рабочую копию внесены только подтверждённые mode fixes: режим теперь сохраняется в общем prompt-контексте brain/talk, а локальный stub не теряет выбранный режим. Live-модели, Discord, WSS и открытые BUG-01...07 остаются отдельной приёмкой.
- Локально `server/compileall` проходит; полный pytest и focused pytest в текущем окружении не запускаются из-за отсутствующих зависимостей/`pytest` (`httpx`, `fastapi`, `langchain_core`). Live application/provider calls не выполнялись.
- Подтверждённые CI fixes: восстановлен позиционный API PluginBuilder и валидный test fixture, сохранён Discord metadata contract для talk messages, исправлены diary dedupe/reopen semantics и совместимость diary prompt с lightweight fakes.
- Доступно локально: `python -m compileall -q .` и `git diff --check` проходят; targeted pytest проходит после fixture fix только при наличии зависимостей. В текущем окружении `pytest` отсутствует в системном Python, а проектный venv не собирает `test_stage3a.py` из-за отсутствующего `pyte`; offline smoke останавливается на отсутствующем `langchain_core`.
- Предыдущий CI head `73650ef` имел 6 pytest failures и 1 offline-smoke TypeError; эти причины исправлены в текущем рабочем diff и требуют нового remote CI прогона.
- Не выполнены и не объявляются закрытыми live acceptance: реальные LLM/provider calls, Discord, WebSearch, webhook SSRF policy, dashboard/container smoke и full client flow. PR остаётся открытым до нового CI прогона.
