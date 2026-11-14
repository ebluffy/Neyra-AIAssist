"""
core.runtime.mcp_client — MCP-клиент для внешних MCP-серверов (stdio / SSE).

Конфигурация: config.yaml → mcp_client.servers — см. config.example.yaml.
"""

from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, create_model

logger = logging.getLogger("neyra.mcp_client")

# Ленивый импорт типов MCP (пакет mcp обязателен при включённом mcp_client.enabled)
try:
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
    _HAS_MCP = True
except ImportError:
    ClientSession = Any  # type: ignore
    StdioServerParameters = Any  # type: ignore
    stdio_client = Any  # type: ignore
    _HAS_MCP = False

try:
    from mcp.client.sse import sse_client
except ImportError:
    sse_client = None  # type: ignore


def _schema_primitive(spec: dict[str, Any]) -> type:
    t = spec.get("type")
    if isinstance(t, list):
        t = next((x for x in t if x != "null"), t[0] if t else None)
    if t == "string":
        return str
    if t == "integer":
        return int
    if t == "number":
        return float
    if t == "boolean":
        return bool
    if t == "array":
        return list[Any]
    if t == "object":
        return dict[str, Any]
    return str


def json_schema_to_pydantic(schema: dict[str, Any] | None, model_name: str) -> type[BaseModel]:
    """Минимальное преобразование JSON Schema → Pydantic для MCP tool inputSchema."""
    schema = schema or {}
    props = schema.get("properties")
    if not isinstance(props, dict) or not props:
        class EmptyArgs(BaseModel):
            model_config = ConfigDict(extra="forbid")

        return EmptyArgs

    req = set(schema.get("required") or []) if isinstance(schema.get("required"), list) else set()
    fields: dict[str, Any] = {}
    for key, spec in props.items():
        if not isinstance(spec, dict):
            spec = {}
        desc = str(spec.get("description") or "")[:4000]
        py_t = _schema_primitive(spec)
        if key in req:
            fields[key] = (py_t, Field(description=desc))
        else:
            fields[key] = (py_t | None, Field(default=None, description=desc))

    return create_model(model_name, **fields)  # type: ignore[arg-type]


def _sanitize_part(s: str, max_len: int) -> str:
    x = re.sub(r"[^a-zA-Z0-9_]+", "_", (s or "").strip())
    x = re.sub(r"_+", "_", x).strip("_")
    return (x or "x")[:max_len]


def make_lc_tool_name(server_id: str, mcp_tool_name: str) -> str:
    """Имя инструмента для LangChain / OpenAI tool-calls: mcp_<server>_<tool>."""
    return f"mcp_{_sanitize_part(server_id, 32)}_{_sanitize_part(mcp_tool_name, 64)}"


@dataclass
class MCPServerSpec:
    name: str
    transport: Literal["stdio", "sse"]
    command: str | None = None
    args: list[str] = field(default_factory=list)
    url: str | None = None
    env: dict[str, str] | None = None
    cwd: str | None = None
    enabled: bool = True


SERVER_NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
_ENV_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _clean_env(raw: Any) -> dict[str, str]:
    if not isinstance(raw, dict):
        return {}
    out: dict[str, str] = {}
    for key, value in raw.items():
        name = str(key or "").strip()
        if not _ENV_NAME_RE.match(name):
            continue
        out[name] = str(value if value is not None else "")[:4000]
    return out


def _spec_dict(name: str, val: Any) -> dict[str, Any] | None:
    """One server (legacy dict/string or new mapping) → normalized config dict."""
    sid = str(name or "").strip()
    if not sid or not SERVER_NAME_RE.match(sid):
        return None
    if isinstance(val, str):
        url = val.strip()
        if not url.lower().startswith(("http://", "https://")):
            return None
        return {"name": sid, "enabled": True, "transport": "sse", "url": url, "env": {}}
    if not isinstance(val, dict):
        return None
    transport = str(val.get("transport") or "").strip().lower()
    url = str(val.get("url") or "").strip()
    command_raw = val.get("command")
    if transport not in ("stdio", "sse"):
        transport = "sse" if url.lower().startswith(("http://", "https://")) else "stdio"
    args: list[str] = []
    command: str | None = None
    if isinstance(command_raw, list) and command_raw:
        command = str(command_raw[0]).strip()
        args = [str(x) for x in command_raw[1:]]
    elif command_raw is not None:
        command = str(command_raw).strip() or None
    extra_args = val.get("args")
    if not args and isinstance(extra_args, list):
        args = [str(x) for x in extra_args]
    if transport == "stdio" and not command:
        return None
    if transport == "sse" and not url.lower().startswith(("http://", "https://")):
        return None
    out: dict[str, Any] = {
        "name": sid,
        "enabled": bool(val.get("enabled", True)),
        "transport": transport,
    }
    if transport == "stdio":
        out["command"] = command
        out["args"] = args
    else:
        out["url"] = url
    cwd = val.get("cwd")
    if cwd:
        out["cwd"] = str(cwd).strip()
    env = _clean_env(val.get("env"))
    if env:
        out["env"] = env
    return out


def normalize_servers(raw: Any) -> tuple[list[dict[str, Any]], bool]:
    """Any historical shape → list of normalized server dicts.

    Legacy: ``servers`` was a mapping name→spec (dict or URL string), and even
    earlier a flat list of URLs. Migration converts once and reports ``changed``.
    """
    if raw is None:
        return [], False
    if isinstance(raw, dict):
        items: list[dict[str, Any]] = []
        for key, val in raw.items():
            spec = _spec_dict(str(key), val)
            if spec:
                items.append(spec)
        return items, True
    if isinstance(raw, list):
        items = []
        changed = False
        for index, val in enumerate(raw):
            default = f"server_{index + 1}"
            name = ""
            if isinstance(val, dict):
                name = str(val.get("name") or "").strip()
            if not name:
                changed = True
                name = default
            spec = _spec_dict(name, val)
            if spec:
                items.append(spec)
        return items, changed
    return [], True


def migrate_servers_config(cfg: dict[str, Any], root: Any) -> bool:
    """One-time migration of ``mcp_client.servers`` to the list structure.

    Persists to ``config/modules.yaml`` with a .bak next to it. Returns True when
    the file was rewritten. Never raises: a broken config must not stop startup.
    """
    mc = cfg.get("mcp_client") if isinstance(cfg.get("mcp_client"), dict) else None
    if mc is None:
        return False
    servers, changed = normalize_servers(mc.get("servers"))
    mc["servers"] = servers
    if not changed:
        return False
    try:
        from core.runtime.config_loader import persist_allowlisted_updates

        persist_allowlisted_updates(root, {"mcp_client.servers": servers}, keep_backup=True)
        logger.info("mcp_client.servers: legacy shape migrated to list")
        return True
    except Exception:
        logger.exception("mcp_client.servers: migration persist failed (config kept in memory)")
        return False


def _parse_servers_block(cfg: dict[str, Any]) -> dict[str, MCPServerSpec]:
    """Normalized config → specs. Accepts the new list and legacy mapping shapes."""
    mc = cfg.get("mcp_client") if isinstance(cfg.get("mcp_client"), dict) else {}
    servers, _ = normalize_servers(mc.get("servers"))
    out: dict[str, MCPServerSpec] = {}
    for item in servers:
        name = item["name"]
        out[name] = MCPServerSpec(
            name=name,
            transport=item["transport"],
            command=item.get("command"),
            args=list(item.get("args") or []),
            url=item.get("url"),
            env=item.get("env") or None,
            cwd=item.get("cwd"),
            enabled=bool(item.get("enabled", True)),
        )
    return out


class MCPServerConfigError(ValueError):
    """Invalid admin payload for one MCP server."""


MAX_ARGS = 50
MAX_ENV_VALUE = 4000


def mask_env(env: dict[str, str] | None) -> list[dict[str, Any]]:
    """Env for the admin API: names and a "set" flag, never values."""
    pairs = sorted((env or {}).items())
    return [{"name": str(name), "set": bool(str(value).strip())} for name, value in pairs]


def mask_url(url: str | None) -> str | None:
    if not url:
        return None
    return re.sub(r"(https?://)[^/@\s]+@", r"\1***@", url)


def validate_server_payload(payload: dict[str, Any], *, name: str | None = None) -> dict[str, Any]:
    """Normalize one server from the admin API or raise MCPServerConfigError."""
    final_name = str(name if name is not None else payload.get("name") or "").strip()
    if not SERVER_NAME_RE.match(final_name):
        raise MCPServerConfigError(
            "name: 1–64 символа, латиница, цифры, точка, дефис или подчёркивание."
        )
    transport = str(payload.get("transport") or "").strip().lower()
    if transport not in ("stdio", "sse"):
        raise MCPServerConfigError("transport: ожидается stdio или sse.")

    enabled_raw = payload.get("enabled", True)
    if not isinstance(enabled_raw, bool):
        raise MCPServerConfigError("enabled: ожидается true или false.")

    env_raw = payload.get("env")
    if env_raw is not None and not isinstance(env_raw, dict):
        raise MCPServerConfigError("env: ожидается объект имя→значение.")
    env: dict[str, str] = {}
    for key, value in (env_raw or {}).items():
        env_name = str(key or "").strip()
        if not _ENV_NAME_RE.match(env_name):
            raise MCPServerConfigError(f"env: некорректное имя переменной «{env_name}».")
        if not isinstance(value, str):
            raise MCPServerConfigError(f"env.{env_name}: значение должно быть строкой.")
        env[env_name] = value[:MAX_ENV_VALUE]

    cwd_raw = payload.get("cwd")
    cwd = str(cwd_raw).strip() if cwd_raw else ""
    if len(cwd) > 300:
        raise MCPServerConfigError("cwd: не длиннее 300 символов.")

    out: dict[str, Any] = {"name": final_name, "enabled": enabled_raw, "transport": transport}
    if transport == "stdio":
        command = str(payload.get("command") or "").strip()
        if not command:
            raise MCPServerConfigError("command: обязателен для stdio.")
        if len(command) > 500:
            raise MCPServerConfigError("command: не длиннее 500 символов.")
        args_raw = payload.get("args") or []
        if not isinstance(args_raw, list) or not all(isinstance(a, str) for a in args_raw):
            raise MCPServerConfigError("args: ожидается список строк.")
        if len(args_raw) > MAX_ARGS or any(len(a) > 500 for a in args_raw):
            raise MCPServerConfigError(f"args: не больше {MAX_ARGS} аргументов до 500 символов.")
        out["command"] = command
        out["args"] = list(args_raw)
    else:
        url = str(payload.get("url") or "").strip()
        if not url.lower().startswith(("http://", "https://")) or len(url) > 2000:
            raise MCPServerConfigError("url: обязателен HTTP(S)-адрес для sse.")
        out["url"] = url
    if cwd:
        out["cwd"] = cwd
    if env:
        out["env"] = env
    return out


def _format_tool_result(result: Any) -> str:
    if result is None:
        return ""
    parts: list[str] = []
    err = bool(getattr(result, "isError", False))
    for block in getattr(result, "content", None) or []:
        txt = getattr(block, "text", None)
        if txt is not None:
            parts.append(str(txt))
        else:
            parts.append(str(block))
    sc = getattr(result, "structuredContent", None)
    if sc:
        import json

        try:
            parts.append(json.dumps(sc, ensure_ascii=False, indent=2))
        except Exception:
            parts.append(str(sc))
    body = "\n".join(p for p in parts if p)
    if err:
        return f"[MCP ошибка]\n{body}" if body else "[MCP ошибка]"
    return body if body else "(пустой ответ инструмента)"


class MCPClientManager:
    """
    Поднимает stdio/SSE MCP-сессии, кеширует list_tools и проксирует call_tool.
    Не роняет ядро при падении внешнего процесса — переподключение в фоне.
    """

    def __init__(self, config: dict[str, Any]) -> None:
        self._cfg_root = config
        self._mc = config.get("mcp_client") if isinstance(config.get("mcp_client"), dict) else {}
        self._specs = _parse_servers_block(config)
        self._shutdown = asyncio.Event()
        self._started = False
        self._tasks: list[asyncio.Task[Any]] = []
        self._server_tasks: dict[str, asyncio.Task[Any]] = {}
        self._sessions: dict[str, Any] = {}
        self._tools_by_server: dict[str, list[Any]] = {}
        self._errors: dict[str, str | None] = {}
        self._checked_at: dict[str, str] = {}
        self._lc_route: dict[str, tuple[str, str]] = {}
        self._langchain_tools: list[Any] = []
        self._connect_timeout = float(self._mc.get("connect_timeout_seconds", 45.0))

    @property
    def enabled(self) -> bool:
        return bool(self._mc.get("enabled")) and any(spec.enabled for spec in self._specs.values())

    def configured_servers(self) -> list[str]:
        return list(self._specs.keys())

    def connected_servers(self) -> list[str]:
        return list(self._sessions.keys())

    def last_errors(self) -> dict[str, str | None]:
        return dict(self._errors)

    async def start(self) -> None:
        if self._started:
            return
        if not self.enabled:
            self._started = True
            return
        if not _HAS_MCP:
            self._errors.update({name: "missing MCP SDK" for name in self._specs})
            logger.error("mcp_client.enabled, но пакет mcp не установлен. Установите: pip install mcp")
            self._started = True
            return

        self._shutdown.clear()
        self._tasks = []
        for name, spec in self._specs.items():
            if not spec.enabled:
                continue
            t = asyncio.create_task(self._run_server_forever(name, spec), name=f"neyra-mcp-{name}")
            self._tasks.append(t)
            self._server_tasks[name] = t

        await self._wait_for_sessions(self._connect_timeout)
        self._rebuild_langchain_tools()
        self._started = True
        logger.info(
            "MCPClientManager стартовал | серверов=%s | инструментов LC=%s",
            list(self._sessions.keys()),
            len(self._langchain_tools),
        )

    async def stop(self) -> None:
        self._shutdown.set()
        for t in self._tasks:
            t.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()
        self._server_tasks.clear()
        self._sessions.clear()
        self._tools_by_server.clear()
        self._lc_route.clear()
        self._langchain_tools = []
        self._started = False

    async def _wait_for_sessions(self, timeout: float) -> None:
        loop = asyncio.get_event_loop()
        deadline = loop.time() + max(1.0, timeout)
        while loop.time() < deadline:
            if self._specs and all(
                (not self._specs[n].enabled)
                or n in self._sessions
                or self._errors.get(n) in {"missing executable", "missing MCP SDK"}
                for n in self._specs
            ):
                break
            await asyncio.sleep(0.05)
        missing = [n for n in self._specs if n not in self._sessions]
        if missing:
            logger.warning("MCP: не подключились за %ss: %s", timeout, missing)

    async def _run_server_forever(self, name: str, spec: MCPServerSpec) -> None:
        delay = 1.0
        while not self._shutdown.is_set():
            self._errors[name] = None
            self._checked_at[name] = _now_iso()
            try:
                if not _HAS_MCP or (spec.transport == "sse" and sse_client is None):
                    self._errors[name] = "missing MCP SDK"
                    logger.warning("MCP server %s unavailable: MCP runtime is missing", name)
                    break
                if spec.transport == "stdio":
                    await self._one_stdio_session(name, spec)
                else:
                    await self._one_sse_session(name, spec)
            except asyncio.CancelledError:
                break
            except FileNotFoundError as e:
                self._errors[name] = "missing executable"
                logger.warning("MCP server %s unavailable: executable is missing", name)
                break
            except Exception as e:
                self._errors[name] = str(e)
                logger.warning("MCP сервер %s: сессия завершилась (%s) — реконнект через %.1fs", name, e, delay)
            self._sessions.pop(name, None)
            if self._shutdown.is_set():
                break
            await asyncio.sleep(delay)
            delay = min(30.0, delay * 1.5)

    async def _one_stdio_session(self, name: str, spec: MCPServerSpec) -> None:
        if not spec.command:
            raise RuntimeError("stdio без command")
        params = StdioServerParameters(
            command=spec.command,
            args=list(spec.args or []),
            env=spec.env,
            cwd=spec.cwd,
        )
        async with stdio_client(params) as streams:
            read, write = streams
            async with ClientSession(read, write) as session:
                await session.initialize()
                lr = await session.list_tools()
                self._tools_by_server[name] = list(lr.tools)
                self._sessions[name] = session
                await self._shutdown.wait()

    async def _one_sse_session(self, name: str, spec: MCPServerSpec) -> None:
        if not spec.url:
            raise RuntimeError("sse без url")
        if sse_client is None:
            raise RuntimeError("mcp.client.sse недоступен")
        async with sse_client(spec.url) as streams:
            read, write = streams
            async with ClientSession(read, write) as session:
                await session.initialize()
                lr = await session.list_tools()
                self._tools_by_server[name] = list(lr.tools)
                self._sessions[name] = session
                await self._shutdown.wait()

    def _rebuild_langchain_tools(self) -> None:
        from langchain_core.tools import StructuredTool

        self._lc_route.clear()
        built: list[Any] = []
        used_names: set[str] = set()

        for server_id, tools in self._tools_by_server.items():
            for mt in tools:
                tn = str(getattr(mt, "name", "") or "")
                if not tn:
                    continue
                base_lc = make_lc_tool_name(server_id, tn)
                lc_name = base_lc
                n = 2
                while lc_name in used_names:
                    lc_name = f"{base_lc}_{n}"
                    n += 1
                used_names.add(lc_name)
                self._lc_route[lc_name] = (server_id, tn)
                desc = str(getattr(mt, "description", "") or "")[:8000]
                schema = getattr(mt, "inputSchema", None) or {}
                if not isinstance(schema, dict):
                    schema = {}
                model_name = f"MCP_{_sanitize_part(server_id, 20)}_{_sanitize_part(tn, 40)}_Args"
                args_model = json_schema_to_pydantic(schema, model_name)

                async def _call(
                    _server: str = server_id,
                    _orig: str = tn,
                    **kwargs: Any,
                ) -> str:
                    return await self.call_tool(_server, _orig, kwargs)

                st = StructuredTool.from_function(
                    coroutine=_call,
                    name=lc_name,
                    description=desc or f"MCP tool {tn} на сервере {server_id}",
                    args_schema=args_model,
                    infer_schema=False,
                )
                built.append(st)

        self._langchain_tools = built

    def get_langchain_tools(self) -> list[Any]:
        return list(self._langchain_tools)

    def lc_route(self, lc_name: str) -> tuple[str, str] | None:
        return self._lc_route.get(lc_name)

    def tool_count(self, server_name: str) -> int:
        return len(self._tools_by_server.get(server_name) or [])

    def last_checked(self) -> dict[str, str]:
        return dict(self._checked_at)

    def status_snapshot(self) -> dict[str, dict[str, Any]]:
        """Runtime state per configured server for the admin API (no secrets)."""
        global_enabled = bool(self._mc.get("enabled"))
        out: dict[str, dict[str, Any]] = {}
        for name, spec in self._specs.items():
            if not global_enabled or not spec.enabled:
                state = "disabled"
            elif name in self._sessions:
                state = "connected"
            elif self._errors.get(name):
                state = "error"
            else:
                state = "disconnected"
            out[name] = {
                "state": state,
                "tools": self.tool_count(name),
                "last_error": self._errors.get(name),
                "checked_at": self._checked_at.get(name),
            }
        return out

    async def restart_server(self, name: str) -> bool:
        """Reconnect one server without touching the others. Idempotent."""
        spec = self._specs.get(name)
        if spec is None or not spec.enabled or not self._started or not self._mc.get("enabled"):
            return False
        task = self._server_tasks.get(name)
        if task is not None:
            # Cancelling the task closes its session context; other servers keep running.
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            if task in self._tasks:
                self._tasks.remove(task)
        self._sessions.pop(name, None)
        self._tools_by_server.pop(name, None)
        self._errors[name] = None
        new_task = asyncio.create_task(self._run_server_forever(name, spec), name=f"neyra-mcp-{name}")
        self._tasks.append(new_task)
        self._server_tasks[name] = new_task
        await self._wait_for_sessions(min(5.0, self._connect_timeout))
        self._rebuild_langchain_tools()
        return True

    async def reload(self) -> None:
        """Re-read mcp_client config, drop sessions/tools and start again."""
        was_started = self._started
        await self.stop()
        mc = self._cfg_root.get("mcp_client") if isinstance(self._cfg_root.get("mcp_client"), dict) else {}
        self._mc = mc
        self._specs = _parse_servers_block(self._cfg_root)
        self._errors.clear()
        self._checked_at.clear()
        if was_started or self.enabled:
            await self.start()

    async def call_tool(self, server_name: str, tool_name: str, arguments: dict[str, Any]) -> str:
        session = self._sessions.get(server_name)
        if session is None:
            return f"[MCP] Сервер «{server_name}» не подключён. Ошибка: {self._errors.get(server_name)}"
        try:
            result = await session.call_tool(tool_name, arguments or {})
            return _format_tool_result(result)
        except Exception as e:
            logger.exception("MCP call_tool %s/%s failed", server_name, tool_name)
            return f"[MCP] Ошибка вызова {tool_name}: {e}"

    def catalog_lines(self) -> list[str]:
        """Строки для опционального добавления в системный промпт."""
        lines: list[str] = []
        for server_id, tools in self._tools_by_server.items():
            for mt in tools:
                tn = str(getattr(mt, "name", "") or "")
                desc = str(getattr(mt, "description", "") or "")[:300]
                lc = make_lc_tool_name(server_id, tn)
                lines.append(f"- {lc}: {desc}")
        return lines
