# Neyra Windows Client

Thin control app for the local Neyra server. **Tauri 2 + React + TypeScript**.

This package does **not** orchestrate the agent, store memory, or hold server secrets.
It talks to the server Control / Internal API with an address + token (Windows Credential Manager).

## Status (Stage 1b)

Scaffold only. MVP screens (Connect, Chat, Status, Modules) land in Stage 3 of `docs/PLAN.md`.

## Layout (target)

```text
client/
  package.json
  src/                 # React UI
  src-tauri/           # Tauri 2 shell
```

Bootstrap the full Tauri app in Stage 3; keep this folder as the product client root (do not reuse `server/dashboard/`).
