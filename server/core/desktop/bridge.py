from __future__ import annotations

import asyncio
import json
import re
from contextvars import ContextVar
from dataclasses import dataclass, field
from time import time
from typing import Awaitable, Callable, Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field

TOOLS = Literal['client.list_apps', 'client.open_url', 'client.open_app', 'client.search_web', 'client.list_windows',
                'client.focus_window', 'client.close_window', 'client.media', 'client.volume',
                'client.shell_exec', 'client.fs_list', 'client.fs_read', 'client.fs_search', 'client.fs_write',
                'client.fs_mkdir', 'client.fs_move', 'client.screenshot', 'client.input']

# Quick commands (and server-side drafts) never expose Contour 3–4 tools.
QUICK_COMMAND_TOOLS = Literal['client.list_apps', 'client.open_url', 'client.open_app', 'client.search_web',
                                'client.list_windows', 'client.focus_window', 'client.close_window', 'client.media',
                                'client.volume']

# Read-only tools may still run after an action with an unknown outcome; everything else may not.
READ_ONLY = frozenset({'client.list_apps', 'client.list_windows', 'client.fs_list', 'client.fs_read',
                       'client.fs_search', 'client.screenshot'})
# Seconds the server waits after the 30 s confirmation window for the action itself.
EXECUTION_SECONDS = {'client.shell_exec': 65, 'client.input': 60, 'client.screenshot': 25, 'client.fs_search': 10}
RESULT_LIMIT = 64 * 1024
SCREENSHOT_LIMIT = 1_500_000


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
    tools: list[TOOLS] = Field(default_factory=list, max_length=24)
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
    pending_tools: dict[str, str] = field(default_factory=dict)
    revoked: bool = False


def checked_result(tool, result):
    """Bounded, typed result: only a screenshot may carry image bytes."""
    if not isinstance(result, dict):
        return {'status': 'error', 'code': 'bad_result'}
    if tool == 'client.screenshot':
        data = result.get('data')
        if result.get('status') == 'ok' and (not isinstance(data, str) or len(data) > SCREENSHOT_LIMIT
                                             or result.get('mime') != 'image/jpeg'):
            return {'status': 'error', 'code': 'bad_screenshot'}
        rest = {k: v for k, v in result.items() if k != 'data'}
        if len(json.dumps(rest)) > 4096:
            return {'status': 'error', 'code': 'result_too_large'}
        return result
    if 'data' in result or len(json.dumps(result)) > RESULT_LIMIT:
        return {'status': 'error', 'code': 'result_too_large'}
    return result


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
        connection.pending_tools.clear()

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
        tool = connection.pending_tools.pop(call_id, None)
        if future is None or future.done():
            return False
        future.set_result(checked_result(tool, result))
        return True

    async def call(self, owner, session_id, device_id, tool, arguments):
        connection = self.connections.get((owner, str(device_id)))
        if connection is None or str(connection.manifest.session_id) != str(session_id):
            raise PermissionError('device_not_in_session')
        # Re-checked on every call: a capability switched off mid-turn is gone immediately.
        if tool not in connection.manifest.tools:
            raise PermissionError('capability_disabled')
        if len(connection.pending) >= 4:
            raise ValueError('too_many_calls')
        call_id = str(uuid4())
        future = asyncio.get_running_loop().create_future()
        connection.pending[call_id] = future
        connection.pending_tools[call_id] = tool
        try:
            await connection.send(dict(type='client_tool_call', protocol='neyra.desktop.v1', call_id=call_id,
                                       device_id=str(device_id), session_id=str(session_id), tool=tool,
                                       arguments=arguments, deadline_ms=int((time() + 30) * 1000)))
            return await asyncio.wait_for(future, 30 + EXECUTION_SECONDS.get(tool, 5))
        except (TimeoutError, asyncio.CancelledError):
            try:
                await connection.send(dict(type='cancel', call_id=call_id))
            except Exception:
                pass
            raise
        finally:
            connection.pending.pop(call_id, None)
            connection.pending_tools.pop(call_id, None)


ACTIVE_DESKTOP: ContextVar[tuple | None] = ContextVar('active_desktop', default=None)


@dataclass
class DesktopTurn:
    """Per-turn agent-loop state for PC actions (§10 limits, §3b.8 no replay)."""
    max_actions: int = 24
    actions: int = 0
    outcome_unknown: bool = False
    images: list = field(default_factory=list)
    images_total: int = 0


DESKTOP_TURN: ContextVar[DesktopTurn | None] = ContextVar('desktop_turn', default=None)
MAX_IMAGES_PER_TURN = 4


async def _desktop_action(registry, owner, session, device, tool, arguments):
    turn = DESKTOP_TURN.get()
    if turn is not None:
        if turn.outcome_unknown and tool not in READ_ONLY:
            # A previous action may or may not have happened; never repeat blindly.
            return {'status': 'blocked', 'code': 'previous_outcome_unknown',
                    'note': 'Ask the user to check the PC before any further changes.'}
        if turn.actions >= turn.max_actions:
            return {'status': 'blocked', 'code': 'action_budget_exhausted'}
        turn.actions += 1
    try:
        return await registry.call(owner, session, device, tool, arguments)
    except (ConnectionError, TimeoutError):
        if turn is not None:
            turn.outcome_unknown = True
        return {'status': 'unknown', 'code': 'device_disconnected_or_timeout', 'retry': False,
                'note': 'The action may or may not have run. Do not repeat it.'}
    except (PermissionError, ValueError):
        return {'status': 'unavailable'}


def brain_tools():
    """Created per turn (and re-read every loop step); never mutate the agent's global tool table."""
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
        'client.shell_exec': 'Run one program on this PC without a shell string unless you name the shell. '
                             'arguments: {"program":"git","args":["status"],"cwd":"<allowed folder>","timeout_ms":30000}. '
                             'Always shown to the user for approval; no sudo/elevation; output is truncated and redacted.',
        'client.fs_list': 'List a folder inside the allowed folders. arguments: {"path":"<absolute path>"}.',
        'client.fs_read': 'Read a text file inside the allowed folders (max 48 KB per call, secrets redacted). '
                          'arguments: {"path":"...","offset":0,"max_bytes":49152}.',
        'client.fs_search': 'Search by file name and/or text inside an allowed folder. '
                            'arguments: {"path":"...","name":"report","content":"TODO"}.',
        'client.fs_write': 'Write a text file inside the allowed folders; needs user approval. '
                           'arguments: {"path":"...","content":"...","mode":"create|overwrite|append"}.',
        'client.fs_mkdir': 'Create one folder inside the allowed folders; needs approval. arguments: {"path":"..."}.',
        'client.fs_move': 'Move or rename inside the allowed folders, never overwriting; needs approval. '
                          'arguments: {"from":"...","to":"..."}.',
        'client.screenshot': 'Take a screenshot of this PC (Neyra windows hidden). The image is attached to the next '
                             'message; use its screenshot_id and pixel coordinates for client_input. '
                             'arguments: {} or {"window":"<id from list_windows>"}.',
        'client.input': 'Mouse/keyboard sequence (max 20 steps) on this PC; needs approval. Coordinates are pixels '
                        'of the screenshot given by screenshot_id. Steps: {"op":"move|click|drag|scroll|type|key|wait",...} '
                        'e.g. {"screenshot_id":"...","steps":[{"op":"click","x":100,"y":200},{"op":"type","text":"hi"},'
                        '{"op":"key","keys":"ctrl+s"}]}. Never submit payments or forms the user did not ask for.',
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
            out = await _desktop_action(registry, owner, session, device, _tool, arguments)
            if not isinstance(out, dict):
                out = {'status': 'error', 'code': 'bad_result'}
            if _tool == 'client.screenshot' and 'data' in out:
                out = dict(out)
                data = out.pop('data')
                turn = DESKTOP_TURN.get()
                if turn is not None and turn.images_total < MAX_IMAGES_PER_TURN:
                    turn.images.append(('image/jpeg', data))
                    turn.images_total += 1
                    out['image'] = 'attached_to_next_message'
                else:
                    out['image'] = 'not_attached_limit_reached'
            from core.agent.model_trace import ACTIVE_TRACE
            trace = ACTIVE_TRACE.get()
            if trace is not None and len(trace.client_actions) < 32:
                trace.client_actions.append({'tool': _tool, 'status': str(out.get('status', 'unknown'))[:32]})
            return json.dumps(out, ensure_ascii=False)
        wire_name = name.replace(".", "_")
        result[wire_name] = StructuredTool.from_function(
            name=wire_name, description=descriptions[name],
            coroutine=run, args_schema=Arguments)
    if 'command_drafts' in connection.manifest.features:
        result['desktop_command_draft'] = _draft_tool(connection)
    return result


class DraftAction(BaseModel):
    model_config = ConfigDict(extra='forbid')
    tool: QUICK_COMMAND_TOOLS
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
