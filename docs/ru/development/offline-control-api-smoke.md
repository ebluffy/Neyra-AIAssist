# Offline smoke: server → Control API → client

Из корня репозитория после установки зависимостей:

```bash
grep -E '^(fastapi|uvicorn|httpx|pyyaml|python-multipart)([<>=!~]|$)' server/requirements.txt |
  python -m pip install -r /dev/stdin websockets
npm ci --prefix client
python devtools/smoke_control_api.py
```

Smoke поддерживает Linux/macOS; Windows для этого скрипта не поддерживается и
не проверялась. Это ограничение smoke, а не десктоп-клиента: скрипт использует
POSIX-окружение дочерних процессов, сигналы и установленный OpenSSL CLI. На Windows
запускайте smoke в WSL с Linux-версиями Python, Node.js и OpenSSL.

Нужны Python 3.12+, Node.js 22+ и OpenSSL CLI. Команда выше выбирает минимальные
Python-зависимости прямо из `server/requirements.txt`, сохраняя серверные ограничения
версий; `websockets` явно добавлен как backend Uvicorn. Установку пакетов выполняют заранее; сам
smoke не обращается к внешним сервисам или стенду. Дополнительные серверные
зависимости (LLM, Chroma, Discord, MCP) не нужны.

## Что проверяется

- Отдельный дочерний процесс поднимает настоящий `core.api.build_app` в uvicorn
  на `127.0.0.1`, на свободном порту, выбранном ОС без гонки повторного bind.
  `/api` монтируется локально, как публичный префикс reverse proxy.
- Health `/api/v1/health`, отказ HTTP без Bearer-токена (401/403), один REST chat
  `/api/v1/chat` с детерминированным ответом mock-агента.
- Реальное TLS/WSS-соединение `/api/v1/ws/chat`: отказ без токена, затем
  авторизованные `hello`, `ping`/`pong`, `chat`, `token` и `done`.
- Путь десктоп-клиента `/api/v1/desktop/bridge`: отказ WSS без Bearer-токена,
  затем manifest формата `manifest()` из `client/src-tauri/src/lib.rs`, серверный
  `hello` (`neyra.desktop.v1`), обновление `capabilities`, `chat`
  и поток `token`/`done`. Проверяются device ID, совпадение `request_id`, содержимое
  ответа и закрытие WSS.
  `client/scripts/smoke-control-api.mjs` — Node-эквивалент транспорта клиента
  (HTTPS/WSS, Bearer, JSON); графический Tauri-клиент и desktop voice не запускаются.
- Временный self-signed сертификат проверяется через отдельный CA только
  для этих запросов. Глобальное отключение проверки TLS не используется.

## Изоляция, ошибки и очистка

Токен генерируется заново для каждого запуска и передаётся через окружение,
не через аргументы командной строки. Временные TLS-ключи, конфигурация,
runtime data и лог дочернего процесса находятся в `TemporaryDirectory` в системном
tmp, вне рабочего дерева репозитория. Защитный `.gitignore` также исключает
`.control-api-smoke-*/`, оставшиеся от старых запусков в репозитории.
Пользовательские `.env`, `config.yaml`, память и ключи не загружаются.
LLM, memory, monitor и backup заменены offline-реализациями. Защитные заглушки
блокируют исходящие вызовы HTTPX и Python socket в серверном процессе; это не
OS sandbox. HTTP readiness игнорирует настройки proxy, Node-клиент принимает
только loopback URL без credentials/query и не следует редиректам.

При успехе вывод заканчивается `Offline Control API smoke: PASS`, код выхода 0.
Ошибка запуска, HTTP/WSS, TLS или таймаут дают ненулевой код. Таймаут на каждый этап
(OpenSSL, готовность сервера, Node-клиент) можно изменить:
`python devtools/smoke_control_api.py --timeout 30`. Это не общий лимит всего smoke;
у HTTP/WSS-запросов Node-клиента дополнительно есть собственные короткие таймауты.
При успехе, ошибке и SIGINT/SIGTERM сервер завершается (с принудительным
kill после таймаута), временный каталог удаляется. Не следует прерывать
процесс через SIGKILL, который не позволяет выполнить cleanup.

CI: job `offline-control-api-smoke` в `.github/workflows/ci-verify.yml` запускает
ту же команду на PR и push в main, а затем lifecycle-регрессии:

```bash
python -m unittest discover -s devtools -p test_smoke_control_api.py
```

Они проверяют освобождение порта, остановку сервера и удаление временного
каталога при успехе, ошибке Node, таймауте и SIGTERM. Это offline-проверка API/transport, не
подтверждение работоспособности реального LLM, reverse proxy, GPU, GUI или
production-окружения. Их проверяют отдельно на стенде.
