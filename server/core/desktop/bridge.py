from __future__ import annotations

import asyncio
from contextvars import ContextVar
from dataclasses import dataclass, field
from time import time
from typing import Awaitable, Callable, Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field

TOOLS = Literal['client.list_apps', 'client.open_url', 'client.open_app', 'client.search_web', 'client.list_windows',
                'client.focus_window', 'client.close_window', 'client.media', 'client.volume']


class Manifest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    protocol: Literal['neyra.desktop.v1'] = 'neyra.desktop.v1'
    device_id: UUID
    session_id: UUID
    name: str = Field(min_length=1, max_length=90)
    platform: Literal['windows', 'linux-wayland', 'linux-x11']
    tools: list[TOOLS] = Field(default_factory=list, max_length=9)


@dataclass(eq=False)
class Connection:
    owner: str
    manifest: Manifest
    send: Callable[[dict], Awaitable[None]]
    close: Callable[[], Awaitable[None]] | None = None
    pending: dict[str, asyncio.Future] = field(default_factory=dict)
    revoked: bool = False


class BridgeRegistry:
    """No durable client metadata. Connections and pending calls die on disconnect."""

    def __init__(self):
        self.connections: dict[tuple[str, str], Connection] = {}

    def connect(self, owner, manifest, send, close=None):
        key = owner, str(manifest.device_id)
        if key in self.connections:
            raise ValueError('device_already_connected')
        if len(self.connections) >= 64:
            raise ValueError('device_limit')
        connection = Connection(owner, manifest, send, close=close)
        self.connections[key] = connection
        return connection

    def disconnect(self, connection):
        key = connection.owner, str(connection.manifest.device_id)
        if self.connections.get(key) is connection:
            del self.connections[key]
        for future in connection.pending.values():
            if not future.done():
                future.set_exception(ConnectionError('device_disconnected'))
        connection.pending.clear()

    async def revoke(self, connection):
        """Remove from registry, notify, and close the socket so it cannot re-register."""
        connection.revoked = True
        self.disconnect(connection)
        try:
            await connection.send(dict(type='revoked'))
        except Exception:
            pass
        if connection.close is not None:
            try:
                await connection.close()
            except Exception:
                pass

    def devices(self, owner):
        return [c.manifest.model_dump(mode='json') for c in self.connections.values() if c.owner == owner]

    def result(self, owner, connection, call_id, result):
        if owner != connection.owner:
            return False
        future = connection.pending.pop(call_id, None)
        if future is None or future.done():
            return False
        future.set_result(result)
        return True

    async def call(self, owner, session_id, device_id, tool, arguments):
        connection = self.connections.get((owner, str(device_id)))
        if connection is None or str(connection.manifest.session_id) != str(session_id):
            raise PermissionError('device_not_in_session')
        if tool not in connection.manifest.tools:
            raise PermissionError('capability_disabled')
        if len(connection.pending) >= 4:
            raise ValueError('too_many_calls')
        call_id = str(uuid4())
        future = asyncio.get_running_loop().create_future()
        connection.pending[call_id] = future
        try:
            await connection.send(dict(type='client_tool_call', protocol='neyra.desktop.v1', call_id=call_id,
                                       device_id=str(device_id), session_id=str(session_id), tool=tool,
                                       arguments=arguments, deadline_ms=int((time() + 30) * 1000)))
            return await asyncio.wait_for(future, 30)
        except (TimeoutError, asyncio.CancelledError):
            await connection.send(dict(type='cancel', call_id=call_id))
            raise
        finally:
            connection.pending.pop(call_id, None)


ACTIVE_DESKTOP: ContextVar[tuple | None] = ContextVar('active_desktop', default=None)


def brain_tools():
    """Created per turn; never mutate the agent's global tool table."""
    scope = ACTIVE_DESKTOP.get()
    if scope is None:
        return {}
    registry, owner, session, device = scope
    connection = registry.connections.get((owner, device))
    if connection is None or str(connection.manifest.session_id) != session:
        return {}
    from langchain_core.tools import StructuredTool

    class Arguments(BaseModel):
        model_config = ConfigDict(extra='forbid')
        arguments: dict = Field(description='Typed local action parameters; local policy and confirmation are mandatory.')

    descriptions = {
        'client.open_url': 'Open a web URL on this PC. arguments: {"url":"https://..."}.',
        'client.search_web': 'Search in this PC browser. arguments: {"query":"..."}.',
        'client.list_apps': 'List local application executable paths. arguments: {}.',
        'client.open_app': 'Launch a discovered executable, no shell or extra arguments. arguments: {"path":"..."}. Unknown apps require local confirmation.',
        'client.list_windows': 'List windows on this PC. arguments: {}.',
        'client.focus_window': 'Focus a window returned by list_windows. arguments: {"window":"id"}.',
        'client.close_window': 'Request closing a listed window; always requires local confirmation. arguments: {"window":"id"}.',
        'client.media': 'Control media. arguments: {"action":"play_pause|next|previous"}.',
        'client.volume': 'Control volume. arguments: {"action":"up|down|mute"}.',
    }
    result = {}
    for name in connection.manifest.tools:
        async def run(arguments: dict, _tool=name):
            import json
            try:
                out = await registry.call(owner, session, device, _tool, arguments)
                from core.agent.model_trace import ACTIVE_TRACE
                trace = ACTIVE_TRACE.get()
                if trace is not None and len(trace.client_actions) < 8:
                    trace.client_actions.append({'tool': _tool, 'status': str(out.get('status', 'unknown'))[:32]})
                return json.dumps(out, ensure_ascii=False)
            except (PermissionError, ConnectionError, TimeoutError, ValueError):
                return '{"status":"unavailable"}'
        wire_name = name.replace(".", "_")
        result[wire_name] = StructuredTool.from_function(
            name=wire_name, description=descriptions[name],
            coroutine=run, args_schema=Arguments)
    return result
