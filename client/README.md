# Neyra Client — Windows and Linux

Thin control app for the local (or publicly published) Neyra server. **Tauri 2 + React + TypeScript**.

Does **not** orchestrate the agent, store memory, or hold server secrets.
Talks to the same Control API as the server dashboard (`/v1`, WebSocket chat).

## Status

**Scaffold only.** Implementation follows completion of the agreed server work.
MVP screens (Connect, Chat, Status, Modules), platform-specific secure token
storage, packaging and updater remain planned in [docs/PLAN.md](../docs/PLAN.md)
§3b. Windows uses Credential Manager and NSIS; Linux's secret-store adapter and
distribution formats will be selected and tested separately. Neither platform
is implemented or validated yet.

Default server URL comes from **user settings**, not a hardcoded build-time host. For demos the public origin may be `https://neyra.owyx.site` (frp publish; data stays on the home server).

## Layout (target)

```text
client/
  package.json
  src/                 # React UI
  src-tauri/           # Tauri 2 shell
```

Do not reuse `server/dashboard/` sources for this package.
