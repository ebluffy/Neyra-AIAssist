# Neyra Plugin SDK — Tutorial & Reference (English)

**Russian (same full scope, separate file):** [HELP-RU.md](HELP-RU.md)

This document is the **full English tutorial** for plugin authors: what plugins are, what you can realistically build (including international integrations), what is **not realistically achievable** inside a plugin alone (limits, not “rules”), how to load **your own config files** and **your own `.env` keys**, anti-patterns, Hello World, and API reference.

**Layout note:** after Stage 1b the server lives under `server/`. Paths below like `modules/`, `core/`, `main.py`, and `scripts/` are relative to **`server/`** (run `cd server` first). Secrets: `server/.env`. Product Control API: `server/core/api/` (not a plugin).

---

## Table of contents

1. [Philosophy](#philosophy)
2. [What you can realistically build](#what-you-can-realistically-build)
3. [Architectural limits (what a plugin alone cannot do)](#architectural-limits-what-a-plugin-alone-cannot-do)
4. [Rules of thumb (anti-patterns)](#rules-of-thumb-anti-patterns)
5. [Your own config file inside the plugin](#your-own-config-file-inside-the-plugin)
6. [Your own secrets from `.env](#your-own-secrets-from-env)`
7. [Tutorial: Hello World plugin](#tutorial-hello-world-plugin)
8. [Reference: layout & manifest](#reference-layout--manifest)
9. [Reference: `PluginContext` & `run_plugin](#reference-plugincontext--run_plugin)`
10. [Process model: core vs console](#process-model-core-vs-console)
11. [Loader API](#loader-api)
12. [Reference implementations](#reference-implementations)
13. [Checklist before sharing your plugin](#checklist-before-sharing-your-plugin)
14. [Troubleshooting](#troubleshooting)

---

## Philosophy

A **plugin** is an isolated folder under `modules/<name>/`. The core discovers `modules/*/plugin.yaml` and loads your entry module when needed. **Deleting the plugin folder must not break the core** — that is the main design rule.

---

## What you can realistically build

Plugins run **in the same Python process** as Neyra (unless you spawn a subprocess yourself). You can:

- **New chat / event transports:** bridges to other networks — e.g. Telegram, Slack, Microsoft Teams, **Meta (Facebook) Messenger / Instagram** via their official APIs where available, **X (Twitter)**, **Reddit**, forums — anything with HTTP webhooks or REST.
- **Search & knowledge:** wrap **Google Custom Search**, **Bing Web Search**, **Yandex Search**, **Brave Search**, SerpAPI, etc., and feed snippets into the agent or memory (respect each provider’s Terms of Service).
- **Media:** **YouTube Data API** (metadata, captions where allowed), Google Drive / Dropbox for user-authorized file access (OAuth in the plugin).
- **Voice / STT / TTS:** call cloud or local APIs from your plugin; keep keys in `.env` and tuning in a **plugin-local config** (see below).
- **Embedded HTTP servers:** FastAPI/uvicorn (product HTTP lives in `core/api`), or a minimal webhook receiver.
- **Background logic:** periodic tasks (with care not to block the whole process) — RSS, calendars, custom “if this then notify”.
- **Core integration:** read `ctx.config` (global Neyra config); use `ctx.agent` when provided, or `NeyraAgent(ctx.config)` for assistant replies so routing and logging stay consistent.

Anything that is “call an HTTP API + optional OAuth” is usually fair game **if** you implement auth and rate limits yourself.

---

## Architectural limits (what a plugin alone cannot do)

These are **limitations of reality and architecture**, not “forbidden by policy”:

- **You cannot change the shipped core’s code** from a plugin — plugins do not patch `core/` at runtime. To change kernel behavior you edit the repo or fork. A plugin only adds code under `modules/<id>/`.
- **You cannot grant OS permissions** (microphone, screen recording, admin) — the OS still asks the user; the plugin only uses what the process already has.
- **You cannot bypass third-party platform rules** — Meta, Google, YouTube, etc. each have API and ToS constraints; compliance is the integrator’s responsibility.
- **You cannot assume a GPU** — the plugin runs in Neyra’s process; heavy ML may need a separate service or subprocess you manage.
- **You cannot magically merge two unrelated identities** — linking accounts across platforms still needs your own mapping logic and user consent.
- **Long blocking work** in the same process can stall other interfaces — very heavy jobs should be **async**, **offloaded to a thread/process**, or a separate microservice.

---

## Rules of thumb (anti-patterns)


| Avoid                                                               | Why                                                                                                         |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Editing files under `core/` from plugin code                        | Keeps plugins removable.                                                                                    |
| Committing secrets in `plugin.yaml` or in tracked source            | Use `server/.env` and document variable names in `server/.env.example`.                                     |
| Blocking the asyncio thread without reason                          | Prefer async I/O or a dedicated subprocess for heavy work.                                                  |
| Bypassing `NeyraAgent` for **assistant** replies                    | Use `NeyraAgent` so models and logs stay centralized (raw HTTP to **other** APIs for search/music is fine). |
| Duplicate non-empty `cli_modes` entries vs another plugin (invoke labels) | Keep `cli_modes: []` unless you reserve a unique invoke name. |


---

## Your own config file inside the plugin

Use a **second file** next to your code — e.g. `config.yaml`, `settings.yaml`, or `voice.yaml` — for options that belong to the plugin only (voice profile, API base URL for a custom search, feature flags).

**Pattern:** resolve paths relative to the plugin directory (not the cwd), so it works from any launch directory.

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
    # Example: plugin override for a custom STT endpoint
    endpoint = local.get("custom_stt_url") or (cloud_stt.get("deepgram") or {}).get("base_url")
    ...
```

- You may **merge** plugin config with `ctx.config` in code (your naming — e.g. `local.get("timeout", 30)`).
- **Do not** put secrets in this file; put placeholders and read secrets from `.env` (next section).
- Optionally add `modules/<your_plugin>/config.example.yaml` in the repo (no secrets) so users can copy to `config.yaml`.

---

## Your own secrets from `.env`

The project already calls `load_dotenv` from `**main.py`** (under `server/`) before config load, so **at `run_plugin` time** `os.environ` contains variables from **`server/.env`**.

**Example — custom Yandex Search (or any) API key:**

1. User adds to **`server/.env`** (next to `server/main.py`):
  ```env
   YANDEX_SEARCH_API_KEY=your_key_here
  ```
2. Document the same name in **`server/.env.example`** (commented) so others know the variable exists.
3. In the plugin:
  ```python
   import os

   def run_plugin(ctx: PluginContext) -> None:
       key = (os.environ.get("YANDEX_SEARCH_API_KEY") or "").strip()
       if not key:
           raise RuntimeError("Set YANDEX_SEARCH_API_KEY in .env")
       # use key in httpx/requests to Yandex Cloud Search or your chosen API
  ```

**Note:** Built-in keys like `YANDEX_API_KEY` are already used for voice in `config`; pick **distinct names** for plugin-specific keys (e.g. `YANDEX_SEARCH_API_KEY`) to avoid confusion.

**Advanced:** To inject into the global YAML tree automatically, you would extend `core/secrets_loader.py` — only needed if you want `ctx.config["my_plugin"]["api_key"]` filled from env without manual `os.environ` in the plugin. Most authors use `os.environ.get(...)` in the plugin only.

---

## Tutorial: Hello World plugin

### Step 1 — Create a folder

```text
modules/my_hello_plugin/
```

Use a unique folder name.

### Step 2 — Add `plugin.yaml`

```yaml
id: hello_world
name: Hello World Plugin
description: Minimal SDK demo
version: "1.0.0"
enabled: true
lifecycle: on_demand
cli_modes: []
main_script: main.py
```

### Step 3 — Add `main.py` at the plugin root

`NeyraAgent.chat` is **async**. Use `asyncio.run`. For non-Discord modes, `ctx.agent` is usually `None` — use `NeyraAgent(ctx.config)`.

```python
from __future__ import annotations

import asyncio

from core.agent import NeyraAgent
from core.plugins.sdk import PluginContext


def run_plugin(ctx: PluginContext) -> None:
    print(f"[hello_world] project root = {ctx.root}")

    async def _run() -> None:
        agent = ctx.agent or NeyraAgent(ctx.config)
        out = await agent.chat(
            "Reply with one short English sentence: Hello from the plugin tutorial.",
            username="hello_world",
        )
        print("[hello_world] model reply:", (out or {}).get("text", out))

    asyncio.run(_run())
```

### Step 4 — Run / smoke test

Shipped plugins attach to the **core** process (`python main.py`, default). There is no per-plugin `python main.py --mode …` anymore.

For a quick **manual** run of your plugin id (development):

```bash
cd server && python scripts/invoke_plugin.py hello_world
```

The **000EXAMPLE** template stays **enabled: false** and uses **`cli_modes: []`** so it never collides with optional invoke labels.

---

## Reference: layout & manifest

```text
modules/000EXAMPLE/
  plugin.yaml
  HELP.md
  HELP-RU.md
  core/
    main.py
```

Shipped: `discord/` (unified text + music), `local_voice/`. Product HTTP API: `core/api/`.

### `plugin.yaml` fields


| Field                            | Meaning                                                |
| -------------------------------- | ------------------------------------------------------ |
| `id`                             | Unique string id.                                      |
| `name`, `description`, `version` | Metadata.                                              |
| `enabled`                        | If `false`, CLI mode for this plugin fails at startup. |
| `lifecycle`                      | `resident` / `on_demand`.                              |
| `cli_modes`                      | Optional labels for future invoke / tools; use `[]` in shipped plugins. |
| `main_script`                    | Path to entry `.py` relative to the plugin folder.     |


---

## Reference: `PluginContext` & `run_plugin`

Export:

```python
def run_plugin(ctx: PluginContext) -> None:
    ...
```

- `ctx.root` — server root (`server/`, where `main.py` lives).
- `ctx.config` — full YAML after `.env` merge for **global** config.
- `ctx.agent` — set for **Discord** when the plugin is started by the core server; else build `NeyraAgent(ctx.config)` if needed.

---

## Process model: core vs console

1. **`python main.py`** (or `--mode core`) starts **`core.runtime.server.run_neyra_server`**: one FastAPI app, dashboard static files, one `NeyraAgent`, reflection scheduler, health monitor, and **resident** plugins (e.g. Discord) in background threads.
2. **`python main.py --mode console`** runs the **terminal chat** only — no HTTP stack; use it to iterate on prompts.
3. Plugins do **not** register separate global CLI modes. Keep **`cli_modes: []`** unless you need a reserved string for a future invoke API. For ad-hoc runs, use **`cd server && python scripts/invoke_plugin.py <plugin_id>`**.

Chain for production: core process → `PluginLoader` → `run_plugin(ctx)` for resident/on-demand hooks.

---

## Loader API

`**core/plugins/loader.py`** — class `**PluginLoader`** (construct with the server root, same as `main.py`: `PluginLoader(server_root)`).


| Method                            | Purpose                                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `discover_manifests()`            | All `PluginManifest` objects from `modules/*/plugin.yaml`.                                        |
| `list_plugins()`                  | List of dicts for UI/API: id, name, version, enabled, lifecycle, cli_modes, main_script, plugin_dir. |
| `cli_mode_index()`                | Map `mode string → manifest` (duplicate modes log a warning).                                        |
| `manifest_for_cli_mode(mode)`     | Single manifest or `None`.                                                                           |
| `import_plugin_module(manifest)`  | Load `main_script` (for running or debugging).                                                       |
| `load_enabled_modules()`          | Load enabled plugins respecting `lifecycle` (`on_demand` is skipped on this preload pass).           |
| `set_enabled(plugin_id, enabled)` | Persist `enabled` in the matching `plugin.yaml`.                                                     |


`**core/plugins/sdk.py`:**


| Name                                 | Purpose                                               |
| ------------------------------------ | ----------------------------------------------------- |
| `PluginContext`                      | Dataclass: `root`, `config`, `agent`.                 |
| `run_plugin_entrypoint(module, ctx)` | Find and call `run_plugin(ctx)` on the loaded module. |


---

## Reference implementations


| Path                   | Role                                                          |
| ---------------------- | ------------------------------------------------------------- |
| `modules/discord/`     | Discord (text + music); uses injected `ctx.agent`.            |
| `core/api/`            | Product FastAPI routes; app built in core (`build_app`).      |
| `modules/local_voice/` | Stub.                                                         |


---

## Checklist before sharing your plugin

- No secrets in git — document env var names in `server/.env.example`.
- Unique `id`; keep `cli_modes` empty or unique per plugin.
- Optional `config.example.yaml` for plugin-local settings.
- Assistant replies via `NeyraAgent` unless you document an exception.

---

## Troubleshooting

**Plugin not discovered**

- Check that the plugin has `**enabled: true**` when you expect it.
- Run the server from **`server/`** (`cd server && python main.py`).

**Import errors (`ModuleNotFoundError`, `No module named 'core'`)**

- Start with `cd server && python main.py`, not from inside `modules/`.
- Imports expect the usual layout: `from core...`, `from modules...`.

`**ctx.agent` is `None`**

- Expected when the core did not inject an agent (only Discord resident path injects `ctx.agent`).
- Create one in the plugin: `NeyraAgent(ctx.config)` (same idea as `core/api`).

**Duplicate `cli_modes` warning**

- Two manifests registered the same mode string; rename your mode or disable the other plugin.

**Env var empty / “key not set”**

- `server/.env` missing, wrong variable name, or typo — align code, `server/.env`, and `server/.env.example`.

**Plugin does not show up in discovery**

- Path must be exactly `modules/<folder>/plugin.yaml` (one level under `modules/`).