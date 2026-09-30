<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Co-authored with [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Security model

## Trust boundary
- Neyra API (`core.api`) binds to `127.0.0.1` by default. Treat anything non-local as hostile unless locked down.
- **Wave 1 auth policy (intentional):** if **none** of `API_TOKEN` / `API_KEY` / `API_VIEWER_TOKEN` / `API_MAINT_TOKEN` are set, role is `anon` and may call any endpoint **only while bind is loopback**. Non-loopback bind without tokens → process refuses to start (`assert_api_bind_safe`). Requiring tokens even on localhost is a later hardening option, not Wave 1.
- When tokens are set: `viewer` reads; `maint+` soft-restart; `admin` chat/mutate. Prefer least privilege.
- **Dashboard UI gate:** separate access key (PBKDF2 hash in `data/dashboard_auth.sqlite`). First-time `POST /v1/dashboard/auth/setup` is open only while the key is unset; if API bind is non-loopback, setup additionally requires a **loopback** client. SPA keeps plaintext in `sessionStorage` until logout.

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
