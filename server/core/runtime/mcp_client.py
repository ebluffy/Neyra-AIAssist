"""
core.runtime.mcp_client — MCP-клиент для внешних MCP-серверов (stdio / SSE).

Конфигурация: config.yaml → mcp_client.servers — см. config.example.yaml.
"""

from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass, field
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


def _parse_servers_block(cfg: dict[str, Any]) -> dict[str, MCPServerSpec]:
    out: dict[str, MCPServerSpec] = {}
    mc = cfg.get("mcp_client")
    if not isinstance(mc, dict):
        return out
    raw_servers = mc.get("servers")
    if not isinstance(raw_servers, dict):
        return out
    for key, val in raw_servers.items():
        sid = str(key).strip()
        if not sid:
            continue
        if isinstance(val, str):
            u = val.strip()
            if u.lower().startswith("http"):
                out[sid] = MCPServerSpec(name=sid, transport="sse", url=u)
            continue
        if not isinstance(val, dict):
            continue
        transport = str(val.get("transport") or "").strip().lower()
        url = str(val.get("url") or "").strip()
        cmd_raw = val.get("command")
        if url and transport not in ("stdio", "sse"):
            transport = "sse"
        if cmd_raw is not None and transport not in ("stdio", "sse"):
            transport = "stdio"
        env = val.get("env")
        if env is not None and not isinstance(env, dict):
            env = None
        cwd = val.get("cwd")
        cwd_s = str(cwd).strip() if cwd else None

        if transport == "sse" and url:
            out[sid] = MCPServerSpec(name=sid, transport="sse", url=url, env=env, cwd=cwd_s)
            continue
        if transport == "stdio" and cmd_raw is not None:
            if isinstance(cmd_raw, list) and len(cmd_raw) >= 1:
                out[sid] = MCPServerSpec(
                    name=sid,
                    transport="stdio",
                    command=str(cmd_raw[0]),
                    args=[str(x) for x in cmd_raw[1:]],
                    env=env,
                    cwd=cwd_s,
                )
            elif isinstance(cmd_raw, str) and cmd_raw.strip():
                extra = val.get("args")
                args = [str(x) for x in extra] if isinstance(extra, list) else []
                out[sid] = MCPServerSpec(
                    name=sid,
                    transport="stdio",
                    command=cmd_raw.strip(),
                    args=args,
                    env=env,
                    cwd=cwd_s,
                )
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
        self._sessions: dict[str, Any] = {}
        self._tools_by_server: dict[str, list[Any]] = {}
        self._errors: dict[str, str | None] = {}
        self._lc_route: dict[str, tuple[str, str]] = {}
        self._langchain_tools: list[Any] = []
        self._connect_timeout = float(self._mc.get("connect_timeout_seconds", 45.0))

    @property
    def enabled(self) -> bool:
        return bool(self._mc.get("enabled")) and bool(self._specs)

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
            logger.error("mcp_client.enabled, но пакет mcp не установлен. Установите: pip install mcp")
            self._started = True
            return

        self._shutdown.clear()
        self._tasks = []
        for name, spec in self._specs.items():
            t = asyncio.create_task(self._run_server_forever(name, spec), name=f"neyra-mcp-{name}")
            self._tasks.append(t)

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
        self._sessions.clear()
        self._started = False

    async def _wait_for_sessions(self, timeout: float) -> None:
        loop = asyncio.get_event_loop()
        deadline = loop.time() + max(1.0, timeout)
        while loop.time() < deadline:
            if self._specs and all(n in self._sessions for n in self._specs):
                break
            await asyncio.sleep(0.05)
        missing = [n for n in self._specs if n not in self._sessions]
        if missing:
            logger.warning("MCP: не подключились за %ss: %s", timeout, missing)

    async def _run_server_forever(self, name: str, spec: MCPServerSpec) -> None:
        delay = 1.0
        while not self._shutdown.is_set():
            self._errors[name] = None
            try:
                if spec.transport == "stdio":
                    await self._one_stdio_session(name, spec)
                else:
                    await self._one_sse_session(name, spec)
            except asyncio.CancelledError:
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
