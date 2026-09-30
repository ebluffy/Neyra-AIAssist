<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Neyra Plugin SDK — Туториал и справка (Русский)

**English (тот же полный объём, отдельный файл):** [HELP.md](HELP.md)

Это **полный учебник на русском** для авторов плагинов: зачем плагины, что **реально можно** сделать (в том числе международные сервисы), что **нельзя достичь** только плагином (ограничения, а не «запреты»), как подключить **свой конфиг** в папке плагина и **свои ключи из `.env`**, анти-паттерны, Hello World и справка по API.

**Про layout:** после Этапа 1b сервер живёт в `server/`. Пути ниже (`modules/`, `core/`, `main.py`, `scripts/`) — относительно **`server/`** (сначала `cd server`). Секреты: `server/.env`. Продуктовый Control API: `server/core/api/` (не плагин).

---

## Содержание

1. [Философия](#философия)
2. [Что реально можно реализовать](#что-реально-можно-реализовать)
3. [Архитектурные ограничения (чего плагин «сам по себе» не сделает)](#архитектурные-ограничения)
4. [Правила хорошего тона (анти-паттерны)](#правила-хорошего-тона-анти-паттерны)
5. [Свой конфиг внутри плагина](#свой-конфиг-внутри-плагина)
6. [Свои секреты из `.env](#свои-секреты-из-env)`
7. [Туториал: Hello World](#туториал-hello-world)
8. [Справка: структура и манифест](#справка-структура-и-манифест)
9. [Справка: PluginContext и run_plugin](#справка-plugincontext-и-run_plugin)
10. [Модель процесса: ядро и консоль](#модель-процесса-ядро-и-консоль)
11. [API загрузчика](#api-загрузчика)
12. [Эталонные плагины в репозитории](#эталонные-плагины-в-репозитории)
13. [Чеклист перед публикацией](#чеклист-перед-публикацией)
14. [Частые проблемы](#частые-проблемы)

---

## Философия

**Плагин** — отдельная папка `modules/<имя>/`. Ядро находит `modules/*/plugin.yaml` и подгружает код по правилам. **После удаления папки плагина ядро должно работать** — главное правило.

---

## Что реально можно реализовать

Плагин выполняется **в том же процессе Python**, что и Нейра (если сами не поднимаете отдельный процесс). Можно:

- **Новые транспорты чата и событий:** Telegram, Slack, Microsoft Teams, **Meta (Facebook / Instagram)** через официальные API где доступно, **X**, **Reddit**, форумы — всё, что имеет HTTP, webhooks или REST.
- **Поиск и знания:** обёртки над **Google Custom Search**, **Яндекс**, **Bing**, **Brave**, SerpAPI и т.д.; выдачу подмешивать в агент или память (соблюдайте условия провайдера).
- **Медиа:** **YouTube Data API** (метаданные и т.д. в рамках API), Google Drive/Dropbox с OAuth в плагине.
- **Голос / STT / TTS:** вызов облака или локального API; параметры — в **локальном конфиге плагина**, ключи — в `**.env`**.
- **Свои HTTP-сервисы:** FastAPI + uvicorn (продуктовый HTTP — в `core/api`) или лёгкий приём webhooks.
- **Фоновая логика:** периодические задачи (аккуратно с блокировками) — RSS, напоминания.
- **Ядро:** читать `ctx.config`; для ответов ассистента использовать `ctx.agent` или `NeyraAgent(ctx.config)`.

Если задача сводится к «HTTP API + при необходимости OAuth», её обычно можно закрыть плагином **при условии**, что вы сами реализуете авторизацию и лимиты.

---

## Архитектурные ограничения

Это **не моральные запреты**, а границы возможного:

- **Нельзя изменить код ядра из плагина** — плагин не патчит `core/` в рантайме. Нужно править репозиторий или форк. Плагин добавляет только код в `modules/<id>/`.
- **Нельзя «пробить» права ОС** — микрофон, экран, админ-права выдаёт пользователь и ОС; плагин лишь использует то, что есть у процесса.
- **Нельзя нарушить правила сторонних платформ автоматически** — Google, Meta, YouTube и др. задают лимиты API и ToS; ответственность на интеграторе.
- **Нельзя гарантировать наличие GPU** — тот же процесс, что и Нейра; тяжёлый ML лучше выносить в отдельный сервис/процесс.
- **Нельзя без своей логики слить личности пользователя** между платформами — нужны явное согласие и ваша модель данных.
- **Долгая блокирующая работа** в одном процессе тормозит остальные интерфейсы — используйте async, потоки, subprocess или отдельный микросервис.

---

## Правила хорошего тона (анти-паттерны)


| Избегайте                                      | Зачем                                                             |
| ---------------------------------------------- | ----------------------------------------------------------------- |
| Правок `core/` из плагина                      | Плагин должен удаляться без поломки ядра.                         |
| Секретов в `plugin.yaml` и в коммитах          | Только `server/.env` + описание имён в `server/.env.example`.   |
| Блокировки event loop без нужды                | Async / отдельный процесс для тяжёлого.                           |
| Обхода `NeyraAgent` для **ответов ассистента** | Единый роутинг и логи (прямые HTTP к **другим** API — нормально). |
| Дублирующие непустые `cli_modes` у двух плагинов | Держите `cli_modes: []`, если метка не нужна. |


---

## Свой конфиг внутри плагина

Держите **отдельный файл** рядом с кодом — например `config.yaml`, `settings.yaml`, `voice.yaml` — для настроек только плагина (голос, URL кастомного поиска, флаги).

**Паттерн:** путь относительно каталога плагина через `Path(__file__)`, чтобы работало из любой рабочей директории.

```python
from __future__ import annotations

from pathlib import Path

import yaml

from core.plugins.sdk import PluginContext


def _plugin_dir() -> Path:
    return Path(__file__).resolve().parent


def load_plugin_settings() -> dict:
    cfg_path = _plugin_dir() / "config.yaml"
    if not cfg_path.is_file():
        return {}
    with cfg_path.open("r", encoding="utf-8") as f:
        data = yaml.safe_load(f)
    return data if isinstance(data, dict) else {}


def run_plugin(ctx: PluginContext) -> None:
    local = load_plugin_settings()
    voice = ctx.config.get("voice") or {}
    cloud_stt = ((voice.get("cloud") or {}).get("stt") or {})
    endpoint = local.get("custom_stt_url") or (cloud_stt.get("deepgram") or {}).get("base_url")
    ...
```

- Секреты в этот файл **не кладём** — только в `.env`.
- Имеет смысл положить в репозиторий `**config.example.yaml`** без секретов — пользователь копирует в `config.yaml`.

---

## Свои секреты из `.env`

`server/main.py` уже загружает **`server/.env`** **до** конфига, поэтому в момент `run_plugin` переменные доступны через `**os.environ`**.

**Пример — свой ключ для поиска (например Яндекс):**

1. В `**server/.env**`:
  ```env
   YANDEX_SEARCH_API_KEY=ваш_ключ
  ```
2. То же имя **закомментировать** в **`server/.env.example`**, чтобы другие знали о переменной.
3. В плагине:
  ```python
   import os

   def run_plugin(ctx: PluginContext) -> None:
       key = (os.environ.get("YANDEX_SEARCH_API_KEY") or "").strip()
       if not key:
           raise RuntimeError("Задайте YANDEX_SEARCH_API_KEY в .env")
       # httpx/requests к API поиска
  ```

**Замечание:** встроенные ключи вроде `YANDEX_API_KEY` уже используются для голоса в конфиге; для плагина лучше **отдельное имя** (`YANDEX_SEARCH_API_KEY`), чтобы не путать.

**Продвинуто:** автоматическая подстановка в глобальный `config.yaml` — через расширение `core/secrets_loader.py`; для большинства плагинов достаточно `os.environ.get` в коде плагина.

---

## Туториал: Hello World

### Шаг 1 — папка

`modules/my_hello_plugin/`

### Шаг 2 — `plugin.yaml`

```yaml
id: hello_world
name: Hello World Plugin
description: Минимальная демонстрация SDK
version: "1.0.0"
enabled: true
lifecycle: on_demand
cli_modes: []
main_script: main.py
```

### Шаг 3 — `main.py`

```python
from __future__ import annotations

import asyncio

from core.agent import NeyraAgent
from core.plugins.sdk import PluginContext


def run_plugin(ctx: PluginContext) -> None:
    print(f"[hello_world] корень: {ctx.root}")

    async def _run() -> None:
        agent = ctx.agent or NeyraAgent(ctx.config)
        out = await agent.chat(
            "Ответь одним коротким предложением по-русски: привет из туториала плагина.",
            username="hello_world",
        )
        print("[hello_world] ответ:", (out or {}).get("text", out))

    asyncio.run(_run())
```

### Шаг 4 — запуск / проверка

Штатный путь — **ядро** (`python main.py`): плагины с `lifecycle: resident` стартуют вместе с процессом. Отдельного `python main.py --mode …` для каждого плагина больше нет.

Разовая отладка по `id`:

```bash
cd server && python scripts/invoke_plugin.py hello_world
```

Шаблон `**000EXAMPLE**` в репозитории выключен и с **`cli_modes: []`**, чтобы не пересекаться.

---

## Справка: структура и манифест

```text
modules/000EXAMPLE/
  plugin.yaml
  HELP.md
  HELP-RU.md
  core/main.py
```

### Поля `plugin.yaml`


| Поле                             | Описание                                             |
| -------------------------------- | ---------------------------------------------------- |
| `id`                             | Уникальный идентификатор.                            |
| `name`, `description`, `version` | Метаданные.                                          |
| `enabled`                        | `false` — режим CLI для этого плагина не запустится. |
| `lifecycle`                      | `resident` / `on_demand`.                            |
| `cli_modes`                      | Опционально, для будущего invoke; в штатных плагинах — `[]`. |
| `main_script`                    | Путь к `.py` относительно папки плагина.             |


Поля `events`, `commands`, `permissions` зарезервированы под будущий SDK / мини-сайт.

---

## Справка: PluginContext и run_plugin

В модуле `main_script` нужно экспортировать одну функцию:

```python
def run_plugin(ctx: PluginContext) -> None:
    ...
```

Поля `**PluginContext**` (`core/plugins/sdk.py`):

- `**root**` — `Path` корня сервера (`server/`, где лежит `main.py`).
- `**config**` — полный словарь глобального `config.yaml` после подстановки секретов из `.env` (через `apply_env_secrets`).
- `**agent**` — экземпляр `NeyraAgent` или `None`. Для **Discord** при запуске из ядра передаётся один общий агент; иначе создавайте `NeyraAgent(ctx.config)` внутри плагина при необходимости.

Функция может **блокировать** поток (как `discord.py` `run()` или `uvicorn.run`) — это нормально для выделенного CLI-режима.

---

## Модель процесса: ядро и консоль

1. **`python main.py`** (или `--mode core`) запускает **`core.runtime.server.run_neyra_server`**: FastAPI, дашборд, один `NeyraAgent`, рефлексия, health monitor, **resident**-плагины (например Discord) в фоновых потоках.
2. **`python main.py --mode console`** — только интерактивная консоль без HTTP.
3. Глобальные CLI-режимы под отдельные плагины **не регистрируются**; в манифестах держите **`cli_modes: []`**, если не нужна зарезервированная метка. Для ручного запуска: **`cd server && python scripts/invoke_plugin.py <plugin_id>`**.

Цепочка в продакшене: процесс ядра → `PluginLoader` → `run_plugin(ctx)` для resident/on-demand.

---

## API загрузчика

**Файл `core/plugins/loader.py`**, класс `**PluginLoader**` (создаётся с корнем сервера `server/`, как в `main.py`: `PluginLoader(server_root)`):


| Метод / использование             | Назначение                                                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `discover_manifests()`            | Список всех `PluginManifest` по всем `modules/*/plugin.yaml`.                                                  |
| `list_plugins()`                  | Список словарей для UI/API: id, name, version, enabled, lifecycle, cli_modes, main_script, plugin_dir.            |
| `cli_mode_index()`                | Словарь `режим → манифест` (при дубликате режима в лог пишется предупреждение).                                   |
| `manifest_for_cli_mode(mode)`     | Один манифест для строки режима или `None`.                                                                       |
| `import_plugin_module(manifest)`  | Загрузить и выполнить `main_script` (нужен для запуска или отладки).                                              |
| `load_enabled_modules()`          | Загрузить модули всех **включённых** плагинов с учётом `lifecycle` (on_demand не импортируется при этом проходе). |
| `set_enabled(plugin_id, enabled)` | Записать `enabled` обратно в `plugin.yaml` по id.                                                                 |


**Файл `core/plugins/sdk.py`:**


| Имя                                  | Назначение                                              |
| ------------------------------------ | ------------------------------------------------------- |
| `PluginContext`                      | Датакласс: `root`, `config`, `agent`.                   |
| `run_plugin_entrypoint(module, ctx)` | Найти и вызвать `run_plugin(ctx)` в загруженном модуле. |


---

## Эталонные плагины в репозитории


| Путь                   | Роль                                                                           |
| ---------------------- | ------------------------------------------------------------------------------ |
| `modules/discord/`     | Discord (текст + музыка); в `run_plugin` передаётся `ctx.agent` из `main.py`. |
| `core/api/`            | Продуктовый FastAPI; приложение в ядре (`build_app`).                          |
| `modules/local_voice/` | Заглушка под будущую реализацию.                                               |


---

## Чеклист перед публикацией

- Секреты не в git — только переменные в `server/.env`, имена продублированы в `server/.env.example`.
- Уникальный `id`; `cli_modes` пустой или без пересечений с другими плагинами.
- По желанию: `config.example.yaml` в папке плагина для локальных настроек без секретов.
- Ответы ассистента через `NeyraAgent`, если не задокументировано исключение.

---

## Частые проблемы

**Плагин не находится**

- Проверьте, что у плагина `**enabled: true**`, если он должен загружаться.
- Запускайте сервер из **`server/`** (`cd server && python main.py`).

**Ошибки импорта (`ModuleNotFoundError`, `No module named 'core'`)**

- Запускайте `cd server && python main.py`, а не из подпапки `modules/`.
- Структура пакетов должна совпадать с примерами: импорты вида `from core...`, `from modules...`.

`**ctx.agent` равен `None`**

- Нормально, если ядро не передало агента (агент для Discord внедряется только в resident-путь Discord).
- Создайте агент в плагине: `NeyraAgent(ctx.config)` (как в Control API, `core/api/`).

**Предупреждение о дубликате `cli_modes`**

- Два разных `plugin.yaml` объявили одинаковое имя режима. Переименуйте свой режим или отключите лишний плагин.

**Пустая переменная окружения / «ключ не задан»**

- Пользователь не создал `server/.env` или опечатался в имени переменной (например `YANDEX_SEARCH_API_KEY`).
- Убедитесь, что имя в коде совпадает с тем, что в `server/.env` и в `server/.env.example`.

**Плагин не появляется в списке**

- Проверьте путь: должен быть ровно `modules/<папка>/plugin.yaml`, не вложенная глубже без своего манифеста.