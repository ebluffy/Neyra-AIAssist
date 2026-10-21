# Debug MCP over SSH

This operator tool runs separately from Neyra. It uses stdio over SSH; it opens no
TCP listener and does not initialize the agent, Discord or LLM clients. Anyone
with this SSH access can inspect private saved dialogue. Do not expose it to the
assistant's runtime MCP catalog or to untrusted users.

For a flat server install at `/opt/neyra`, copy this directory to
`/opt/neyra-devtools/mcp_server` on the target host, create a dedicated venv, and
install `requirements.txt` there. Keep the runtime venv unchanged. The SDK is
pinned below 2 because these tools use its v1 API.

Register the SSH command in a local Codex installation:

```sh
codex mcp add neyra-minipc -- ssh -T -o BatchMode=yes -o ConnectTimeout=10 minipc env NEYRA_MCP_ALLOW_WRITES=0 /opt/neyra-devtools/.venv/bin/python /opt/neyra-devtools/mcp_server/remote.py --server-root /opt/neyra
```

`remote.py` loads `.env` and layered YAML on the remote host. It uses
`API_VIEWER_TOKEN` for read-only access and refuses to start if neither a viewer
token nor an explicit `NEYRA_API_TOKEN` is provided. The primary API token is
selected automatically only with `NEYRA_MCP_ALLOW_WRITES=1`. Keys never
belong in the SSH command or local MCP configuration. `NEYRA_API_TOKEN` can
override authentication in the remote process environment. HTTP follows no
redirects and ignores proxy environment variables for the loopback API.

Tools include health, redacted configuration/logs, aggregate memory audit,
channel history and person fact provenance. `neyra_chat_history` needs an explicit
channel ID; it excludes model traces and supports a timezone-qualified `before`
timestamp and optional owner filter. `neyra_person_facts` needs a known person
UUID. SQLite opens with `mode=ro` and `query_only=ON`; missing databases are not
created. These are operator tools, not the agent's memory authorization rules.

By default all non-GET API requests are blocked, including event injection,
configuration writes and lifecycle actions. Enabling `NEYRA_MCP_ALLOW_WRITES=1`
in the MCP process deliberately permits them; the API still checks its role and
feature gates. The installed MiniPC command explicitly keeps writes disabled.

The tools inspect stored evidence. They do not prove which evidence a past model
request received, recover messages never saved, validate memory extraction
quality or simulate real Discord conversations. Redaction removes common secret
formats and configured environment secrets; returned chat/config/log data is
still private.

Offline checks (in an environment containing the dev requirements and pytest):

```sh
python -m pytest -q devtools/mcp_server/test_server.py
python -m compileall -q devtools/mcp_server
```

The suite uses temporary SQLite and a real stdio MCP handshake. It never calls
production APIs or language models. After registration, start a new Codex
session if its tool list has not refreshed.
