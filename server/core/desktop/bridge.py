from __future__ import annotations

import asyncio
import re
from contextvars import ContextVar
from dataclasses import dataclass, field
from time import time
from typing import Awaitable, Callable, Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field

TOOLS = Literal['client.list_apps', 'client.open_url', 'client.open_app', 'client.search_web', 'client.list_windows',
                'client.focus_window', 'client.close_window', 'client.media', 'client.volume']


FEATURES = Literal['command_drafts']
_PUNCTUATION = re.compile(r'[^\w\s]', re.UNICODE)
_WAKE_PREFIXES = ('нейра ', 'neyra ')


def normalize_phrase(text: str) -> str:
    """Same rules as the desktop client: lowercase, ё→е, no punctuation, single spaces, no leading wake name."""
    value = _PUNCTUATION.sub(' ', text.lower().replace('ё', 'е'))
    value = ' '.join(value.split())
    for prefix in _WAKE_PREFIXES:
        if value.startswith(prefix):
            return value[len(prefix):]
    return value


class CommandTrigger(BaseModel):
    """Runtime-only description of a user's local quick command. Never contains action arguments or secrets."""
    model_config = ConfigDict(extra='forbid')
    kind: Literal['phrase', 'regex', 'hotkey']
    value: str = Field(min_length=1, max_length=120)


class CommandInfo(BaseModel):
    model_config = ConfigDict(extra='forbid')
    name: str = Field(min_length=1, max_length=60)
    triggers: list[CommandTrigger] = Field(default_factory=list, max_length=8)
    actions: list[str] = Field(default_factory=list, max_length=10)


class Manifest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    protocol: Literal['neyra.desktop.v1'] = 'neyra.desktop.v1'
    device_id: UUID
    session_id: UUID
    name: str = Field(min_length=1, max_length=90)
    platform: Literal['windows', 'linux-wayland', 'linux-x11']
    tools: list[TOOLS] = Field(default_factory=list, max_length=9)
    commands: list[CommandInfo] = Field(default_factory=list, max_length=32)
    features: list[FEATURES] = Field(default_factory=list, max_length=2)

    def matching_command(self, text: str) -> str | None:
        """Exact phrase match only; ambiguity returns None so the normal LLM turn runs."""
        wanted = normalize_phrase(text)
        if not wanted:
            return None
        names = {c.name for c in self.commands for t in c.triggers if t.kind == 'phrase' and normalize_phrase(t.value) == wanted}
        return next(iter(names)) if len(names) == 1 else None


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
        # Quick commands belong to the client's own session; other devices never see them.
        return [c.manifest.model_dump(mode='json', exclude={'commands', 'features'}) for c in self.connections.values() if c.owner == owner]

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
    if 'command_drafts' in connection.manifest.features:
        result['desktop_command_draft'] = _draft_tool(connection)
    return result


class DraftAction(BaseModel):
    model_config = ConfigDict(extra='forbid')
    tool: TOOLS
    arguments: dict = Field(default_factory=dict)


class CommandDraft(BaseModel):
    model_config = ConfigDict(extra='forbid')
    name: str = Field(min_length=1, max_length=60, description='Short command name, e.g. "Game mode".')
    phrases: list[str] = Field(min_length=1, max_length=4, description='Exact phrases the user will say or type.')
    actions: list[DraftAction] = Field(min_length=1, max_length=10, description='Fixed local actions run in order.')
    reply: str = Field(default='', max_length=200, description='Optional short confirmation text.')


def _draft_tool(connection):
    """The server only parses a request into a draft. The desktop shows a card and saves it locally after confirmation."""
    from langchain_core.tools import StructuredTool

    async def run(**kwargs):
        import json
        try:
            draft = CommandDraft(**kwargs)
        except ValueError:
            return '{"status":"invalid_draft"}'
        await connection.send(dict(type='command_draft', draft_id=str(uuid4()), draft=draft.model_dump(mode='json')))
        return json.dumps({'status': 'draft_sent', 'note': 'The user must confirm the draft in the desktop app; it is not saved on the server.'})

    return StructuredTool.from_function(
        name='desktop_command_draft',
        description='Use only when the user asks to remember a quick command for this PC ("когда я говорю X, сделай Y"). '
                    'Sends a draft to the desktop app for local confirmation. Never claim the command is saved before the user confirms.',
        coroutine=run, args_schema=CommandDraft)
