<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Co-authored with [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# FAQ

## Is the Control API an external cloud service?

No. It is the local HTTP/WebSocket API of your Neyra process (`server/core/api/`), typically on `127.0.0.1:8787`.

## Where do I enable or disable plugins?

In `server/modules/<id>/plugin.yaml`, field `enabled`.

## Where do I store tokens?

Only in `server/.env` (API tokens) and, for the web dashboard UI, the separate dashboard access key (hashed on the server).

## Why does a plugin not start after a config change?

Check `plugin.yaml` (`enabled` / lifecycle) and restart the process for resident plugins.

## What is the difference between the dashboard access key and `API_TOKEN`?

The **access key** unlocks the React SPA. After login the API issues a short-lived **session token** used as Bearer for `/v1` (admin). **`API_TOKEN`** remains the dedicated credential for Discord, MCP, scripts, and optional Settings override.
