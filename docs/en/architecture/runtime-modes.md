<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Co-authored with [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Runtime modes

## `python server/main.py` (core)

- Starts the Control API in `server/core/api/` (`/v1`), WebSocket endpoints, and the web dashboard static files.
- Creates one `NeyraAgent`.
- Starts resident plugins in a daemon thread.

## `python server/main.py --mode console`

- Terminal chat for prompt debugging.
- No HTTP stack and no web dashboard.

## Resident vs on_demand

- `resident`: plugin starts when the core starts.
- `on_demand`: plugin is invoked via API/tools on demand.
