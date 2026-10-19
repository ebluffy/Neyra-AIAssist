# `server/config.yaml` reference

`server/config.yaml` holds only the short root runtime config for the core (assistant, paths, pointers to layers).

## Key sections

- `assistant` — `name`, `persona_path` / `appearance_path` (persona pack), `system_prompt` fallback
- `paths.data_dir` — runtime data root (default `server/data` from repo root; override `NEYRA_DATA_DIR`)
- `agent.fast_path` — regex allowlist for home commands (off by default; publishes `home.*`; multi-client e2e → Stage 3+)
- `agent.conversation_mode` in `server/config/agent.yaml` — global talk style: `default` (unchanged persona), `brief`, `detailed`, `technical`, or `no_jokes`. Missing means `default`; unknown values and incorrect types are rejected.
- Layer files under `server/config/` — defaults: `server/config/*.example.yaml`; full keys: `python server/scripts/regen_config_keys_md.py` from the repo root (prints to stdout):
  - `llm.yaml` — per-role **`talk_model`**, **`brain_model`**, **`memory_model`**, **`vision_model`** with **`provider`**; providers under **`llm.providers.<name>`**. No top-level `BACKEND` / `openrouter:` / `vision:`.
  - `memory.yaml`, `voice.yaml`, `agent.yaml`, `modules.yaml`, `runtime.yaml`

## Moved out of the root file

- `discord` → `server/modules/discord/config.yaml`
- `api`, `dashboard` → `server/config/server.yaml` (sections `api:` and `dashboard:`)
- Other plugin settings → `server/modules/<id>/config.yaml`

## Do not store in YAML

- API keys and tokens. Use `server/.env`.

## Plugin generation and background diary

Optional `llm.coder_model: {provider: aihope, model: your-model}` in
`config/llm.yaml` selects PluginBuilder's model. Omission uses brain_model and
its provider; a coder block without provider inherits brain's provider.
Endpoint, headers and credentials use the common provider resolver, without
an implicit OpenRouter route. File changes require restart.

`memory.diary_after_turn: true` schedules one diary entry per completed exchange,
replacing deprecated, ignored `llm.async_reflection.*` and emotional_layer diary
options. Their duplicate schedulers are removed. emotional_layer.enabled and
ltm_emotion_* still control optional LTM tone metadata. Process history and SQLite
diary context are owner/channel scoped. Legacy persona_in_brain and
persona_brain_max_chars are ignored: persona belongs to talk. Gateways that
support streamed usage can opt in with
`llm.providers.<name>.capabilities.supports_stream_usage: true`.

## Changing the conversation mode

Set `agent.conversation_mode` in `server/config/agent.yaml` and restart, or apply it without restarting using an admin Bearer/dashboard session and `POST /v1/config/update`:

```json
{"updates": {"agent.conversation_mode": "technical"}}
```

The API persists the setting to `config/agent.yaml` and exposes it through `GET /v1/config/runtime`. Each turn snapshots its mode: updates affect subsequent turns, preserving the mode of an in-flight reply and its retries. No LLM rebind is needed. The dashboard selector is under Settings → Speech → Conversation mode → Save (currently Russian labels).

The hint applies to chat, streaming, context-overflow retries, and anti-repeat rewrites. It overrides persona style without changing brain/tools or memory rules. Full-lyrics output overrides brevity. This is model guidance, not a guarantee of wording; `llm.talk_model.reply_max_tokens` still limits output, so increase it explicitly for long detailed replies.
