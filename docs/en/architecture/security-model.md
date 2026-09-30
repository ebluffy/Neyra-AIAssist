<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Co-authored with [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Security model

## Trust boundary
- Internal API binds to `127.0.0.1` by default. Treat anything non-local as hostile unless locked down.
- If **none** of `API_TOKEN` / `API_VIEWER_TOKEN` / `API_MAINT_TOKEN` are set, the API is **anonymous** (dev convenience). For any shared or remote host, set tokens.
- Role sketch: `viewer` can read memory/search/people; `admin` can chat and mutate. Prefer least privilege.

## Secrets
- Store secrets in `.env` only; `apply_env_secrets` injects them at boot. Do **not** commit `config.yaml`, plugin `config.yaml`, or `.env`.
- MCP `neyra_read_config` redacts secret-looking keys (`api_key`, `*_token`, `*_secret`, `api_hash`, …). Still never put live keys in YAML.
- Do not log `Authorization` headers or raw API keys.

## Memory isolation
- Chronological `recall_chat` / `POST /v1/memory/chat/recall` **require** `user_id` and/or `channel_id`.
- Semantic `search_memory` / `POST /v1/memory/search` **require** `user_id` (dialogs and `session_archive_digest` are owner-only; shared is `type=knowledge` only). Tool `user_id` args are ignored in favor of turn-scope (`ContextVar`).
- `session_archive` LTM digests are built only from **user-scoped `chat_log`**, never from process-global STM (avoids attributing another user's lines to the current uid).
- Prompt RAG in `prepare_turn` uses the same user-scoped search.

## Plugins
- Plugin builder path-jails writes under `server/modules/<plugin_id>/` (no `../` escape).
- MCP servers expand attack surface — allowlist servers and audit tools.

## Backups & ops — do not commit
- `.env`, root/`server/modules/**/config.yaml`
- `memory/*.db*`, Chroma dirs, `memory/working_memory/`, diary/journal artifacts
- `logs/*` (including `webhooks_state.json` — may hold payloads)
- `backups/` — treat as PII; store encrypted / access-controlled

## Free / trial cloud models (`:free`)
- OpenRouter / NVIDIA `:free` endpoints may be logged or reused by the provider.
- Do **not** send PII, voice clips, faces, or private Discord content to `:free` models without informed consent.
- Prefer paid/BYOK or local models for sensitive audio/vision.

## Webhooks
- Outbound routes may carry a `secret`. Delivery logs/DLQ live under `logs/webhooks_state.json` — treat as sensitive.
