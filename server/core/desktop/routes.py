from __future__ import annotations

import asyncio
import base64
import hashlib
import json
from uuid import UUID

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from core.desktop.bridge import ACTIVE_DESKTOP, SCREENSHOT_LIMIT, BridgeRegistry, Manifest
from core.voice.desktop import DesktopVoice

RESULT_PACKET_LIMIT = SCREENSHOT_LIMIT + 8192


class Packet(BaseModel):
    model_config = ConfigDict(extra='forbid')
    type: str = Field(max_length=32)
    text: str = Field(default='', max_length=6000)
    call_id: str = Field(default='', max_length=36)
    result: dict = Field(default_factory=dict)
    manifest: Manifest | None = None
    target_device_id: UUID | None = None
    request_id: UUID | None = None


def desktop_owner_id(config) -> str:
    """Stable owner namespace: survives API token rotation (AR-10).

    Prefer api.desktop_owner_id; default 'admin' for the personal-assistant deployment.
    Never derive identity from the Bearer token value.
    """
    api = config.get('api') if isinstance(config, dict) and isinstance(config.get('api'), dict) else {}
    owner = str(api.get('desktop_owner_id') or 'admin').strip() or 'admin'
    return hashlib.sha256(('desktop-owner-id:' + owner).encode()).hexdigest()


def _request_id(value) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError('bad_request_id')
    return str(UUID(value))


def router_for(agent, config, authenticate):
    router = APIRouter()
    registry = BridgeRegistry()
    voice_service = DesktopVoice(config)
    voice_connections = set()
    owner = desktop_owner_id(config)

    async def authorize(ws):
        authorization = ws.headers.get('authorization', '')
        try:
            role = authenticate(authorization)
            # Desktop spends LLM/audio and controls PCs: never inherit anonymous loopback rights.
            if role != 'admin' or not authorization.startswith('Bearer '):
                raise PermissionError
        except Exception:
            await ws.close(code=1008, reason='unauthorized')
            return None
        return owner

    async def read_manifest(ws):
        message = await asyncio.wait_for(ws.receive(), 10)
        if message.get('type') == 'websocket.disconnect':
            raise WebSocketDisconnect()
        if message.get('bytes') is not None:
            raise ValueError('bad_packet')
        raw = message.get('text')
        if not isinstance(raw, str):
            raise ValueError('bad_packet')
        if len(raw) > 24576:
            raise ValueError('manifest_too_large')
        return Manifest.model_validate_json(raw)

    @router.websocket('/v1/desktop/bridge')
    async def bridge(ws: WebSocket):
        session_owner = await authorize(ws)
        if session_owner is None:
            return
        await ws.accept()
        connection = None
        task = None
        lock = asyncio.Lock()
        closed = False

        async def send(packet):
            async with lock:
                await ws.send_json(packet)

        async def close_socket():
            nonlocal closed
            if closed:
                return
            closed = True
            try:
                await ws.close(code=1008, reason='revoked')
            except Exception:
                pass

        try:
            manifest = await read_manifest(ws)
            connection = registry.connect(session_owner, manifest, send, close=close_socket)
            username = 'desktop:' + session_owner
            channel = 'desktop:' + str(manifest.session_id)
            await send(dict(type='hello', protocol='neyra.desktop.v1', device_id=str(manifest.device_id)))

            async def turn(text, target, request_id):
                async def turn_send(packet):
                    await send({**packet, "request_id": request_id})
                token = ACTIVE_DESKTOP.set((registry, session_owner, str(target.manifest.session_id), str(target.manifest.device_id)))
                try:
                    async for chunk in agent.chat_stream(text, username=username, channel_id=channel):
                        if chunk.get('type') == 'token':
                            await turn_send(dict(type='token', text=chunk.get('text', '')))
                        elif chunk.get('type') == 'done':
                            await turn_send(dict(type='done', text=chunk.get('text', ''), model_trace=chunk.get('model_trace')))
                        elif chunk.get('type') == 'error':
                            await turn_send(dict(type='error', code='chat_failed'))
                except asyncio.CancelledError:
                    await turn_send(dict(type='cancelled'))
                    raise
                except Exception:
                    await turn_send(dict(type='error', code='chat_failed'))
                finally:
                    ACTIVE_DESKTOP.reset(token)

            while True:
                message = await asyncio.wait_for(ws.receive(), 300)
                if message.get('type') == 'websocket.disconnect':
                    break
                if message.get('bytes') is not None:
                    raise ValueError('bad_packet')
                raw = message.get('text')
                if not isinstance(raw, str):
                    raise ValueError('bad_packet')
                if len(raw) > RESULT_PACKET_LIMIT:
                    raise ValueError('packet_too_large')
                if connection is None or connection.revoked:
                    raise ValueError('revoked')
                packet = Packet.model_validate_json(raw)
                if packet.type != 'client_tool_result' and len(raw) > 32768:
                    raise ValueError('packet_too_large')
                if packet.type == 'ping':
                    await send(dict(type='pong'))
                elif packet.type == 'capabilities' and packet.manifest:
                    updated = packet.manifest
                    if updated.device_id != manifest.device_id or updated.session_id != manifest.session_id:
                        raise ValueError('identity_changed')
                    tools_changed = set(updated.tools) != set(manifest.tools)
                    registry.disconnect(connection)
                    manifest = updated
                    connection = registry.connect(session_owner, manifest, send, close=close_socket)
                    # Editing quick commands must not abort a running turn; only a narrower/wider tool set does.
                    if task and tools_changed:
                        task.cancel()
                    await send(dict(type='capabilities', tools=manifest.tools))
                elif packet.type == 'client_tool_result':
                    # Size and shape per tool are enforced in BridgeRegistry.result.
                    registry.result(session_owner, connection, packet.call_id, packet.result)
                elif packet.type == 'stop':
                    if task:
                        task.cancel()
                        await asyncio.gather(task, return_exceptions=True)
                    for call_id in list(connection.pending):
                        await send(dict(type='cancel', call_id=call_id))
                    for future in connection.pending.values():
                        if not future.done():
                            future.cancel()
                elif packet.type == 'disconnect_device' and packet.target_device_id:
                    target = registry.connections.get((session_owner, str(packet.target_device_id)))
                    if target is not None:
                        await registry.revoke(target)
                    await send(dict(type='devices', devices=registry.devices(session_owner)))
                elif packet.type == 'devices':
                    await send(dict(type='devices', devices=registry.devices(session_owner)))
                elif packet.type == 'history':
                    hub = getattr(agent, 'memory_hub', None)
                    rows = []
                    if hub is not None:
                        uid = agent._resolve_internal_user_id(None, username)
                        rows = await asyncio.to_thread(hub.list_chat, user_id=uid, channel_id=channel, limit=50)
                    await send(dict(type='history', messages=[dict(role=r['role'], content=r.get('content', '')) for r in reversed(rows)]))
                elif packet.type == 'chat' and packet.text.strip():
                    if task and not task.done():
                        await send(dict(type='error', code='turn_busy'))
                        continue
                    target = connection
                    if packet.target_device_id:
                        target = registry.connections.get((session_owner, str(packet.target_device_id)))
                        if target is None:
                            await send(dict(type='error', code='device_unavailable'))
                            continue
                    task = asyncio.create_task(turn(packet.text, target, str(packet.request_id) if packet.request_id else None))
                else:
                    await send(dict(type='error', code='bad_packet'))
        except (ValueError, TimeoutError, TypeError, AttributeError, KeyError, ValidationError, json.JSONDecodeError):
            try:
                await ws.close(code=1008, reason='invalid_or_expired_session')
            except Exception:
                pass
        except WebSocketDisconnect:
            pass
        finally:
            if task:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            if connection and not connection.revoked:
                registry.disconnect(connection)

    @router.websocket('/v1/desktop/voice')
    async def voice(ws: WebSocket):
        session_owner = await authorize(ws)
        if session_owner is None:
            return
        await ws.accept()
        work = None
        voice_key = None
        voice_registered = False
        current_request = None
        audio = bytearray()
        send_lock = asyncio.Lock()

        async def send(packet):
            async with send_lock:
                await ws.send_json(packet)

        try:
            manifest = await read_manifest(ws)
            voice_key = (session_owner, str(manifest.device_id))
            if voice_key in voice_connections or len(voice_connections) >= 32:
                raise ValueError('voice_session_limit')
            voice_connections.add(voice_key)
            voice_registered = True
            await send(dict(type='hello', protocol='neyra.voice.v1', format='pcm_s16le', sample_rate=16000,
                            channels=1, max_seconds=30, partial_transcripts=False))

            async def process(pcm, request_id):
                async def turn_send(packet):
                    await send({**packet, "request_id": request_id})
                try:
                    text = await asyncio.wait_for(voice_service.transcribe(pcm), 60)
                    await turn_send(dict(type='transcript.final', text=text))
                    if not text.strip():
                        await turn_send(dict(type='error', code='no_speech'))
                        return
                    channel = 'desktop:' + str(manifest.session_id)
                    response = ''
                    terminal = False
                    connection = registry.connections.get((session_owner, str(manifest.device_id)))
                    if connection and connection.manifest.session_id == manifest.session_id:
                        matched = connection.manifest.matching_command(text)
                        if matched:
                            # The command list lives only in this session's RAM; the client runs it locally under its own policy.
                            await turn_send(dict(type='command_match', name=matched))
                            return
                    scope = None
                    if connection and connection.manifest.session_id == manifest.session_id:
                        scope = (registry, session_owner, str(manifest.session_id), str(manifest.device_id))
                    context_token = ACTIVE_DESKTOP.set(scope)
                    try:
                        async for chunk in agent.chat_stream(text, username='desktop:' + session_owner, channel_id=channel):
                            if chunk.get('type') == 'token':
                                await turn_send(dict(type='token', text=chunk.get('text', '')))
                            if chunk.get('type') == 'done':
                                response = chunk.get('text', '')
                                await turn_send(dict(type='done', text=response, model_trace=chunk.get('model_trace')))
                            if chunk.get('type') == 'error':
                                await turn_send(dict(type='error', code='chat_failed'))
                                terminal = True
                                return
                    finally:
                        ACTIVE_DESKTOP.reset(context_token)
                    if terminal:
                        return
                    if response:
                        wav = await asyncio.wait_for(voice_service.synthesize(response), 60)
                        if wav:
                            # V1 is half-duplex PTT: bounded final WAV, live sentence streaming is step 5.
                            for offset in range(0, len(wav), 48000):
                                await turn_send(dict(type='audio.chunk', data=base64.b64encode(wav[offset:offset+48000]).decode()))
                            await turn_send(dict(type='audio.done', mime='audio/wav'))
                        else:
                            await turn_send(dict(type='error', code='tts_unavailable'))
                    else:
                        # Explicit terminal so the client clears current_turn (AR-8).
                        await turn_send(dict(type='error', code='empty_response'))
                except asyncio.CancelledError:
                    raise
                except Exception:
                    await turn_send(dict(type='error', code='voice_failed'))

            async def speak(text):
                """Short fixed reply of a quick command; the same server TTS as normal answers."""
                try:
                    wav = await asyncio.wait_for(voice_service.synthesize(text), 60)
                    if not wav:
                        await send(dict(type='error', code='tts_unavailable'))
                        return
                    for offset in range(0, len(wav), 48000):
                        await send(dict(type='audio.chunk', data=base64.b64encode(wav[offset:offset+48000]).decode()))
                    await send(dict(type='audio.done', mime='audio/wav'))
                except asyncio.CancelledError:
                    raise
                except Exception:
                    await send(dict(type='error', code='voice_failed'))

            while True:
                packet = await asyncio.wait_for(ws.receive(), 300)
                if packet['type'] == 'websocket.disconnect':
                    break
                if packet.get('bytes') is not None:
                    data = packet['bytes']
                    if work and not work.done():
                        raise ValueError('turn_busy')
                    if len(data) > 32768 or len(audio) + len(data) > 960000:
                        raise ValueError('audio_too_large')
                    audio.extend(data)
                    continue
                raw = packet.get('text')
                if not isinstance(raw, str):
                    raise ValueError('bad_packet')
                if len(raw) > 4096:
                    raise ValueError('packet_too_large')
                message = json.loads(raw)
                if not isinstance(message, dict):
                    raise ValueError('bad_packet')
                if message.get('type') == 'commit':
                    if work and not work.done():
                        await send(dict(type='error', code='turn_busy'))
                        continue
                    pcm = bytes(audio)
                    audio.clear()
                    current_request = _request_id(message.get('request_id'))
                    work = asyncio.create_task(process(pcm, current_request))
                elif message.get('type') == 'stop':
                    audio.clear()
                    if work:
                        work.cancel()
                        await asyncio.gather(work, return_exceptions=True)
                    await send(dict(type='cancelled', request_id=current_request))
                elif message.get('type') == 'speak':
                    text = message.get('text')
                    if not isinstance(text, str) or not text.strip() or len(text) > 300:
                        raise ValueError('bad_speak')
                    if work and not work.done():
                        await send(dict(type='error', code='turn_busy'))
                        continue
                    work = asyncio.create_task(speak(text.strip()))
                elif message.get('type') == 'ping':
                    await send(dict(type='pong'))
                else:
                    raise ValueError('bad_packet')
        except (ValueError, TimeoutError, TypeError, AttributeError, KeyError, ValidationError, json.JSONDecodeError):
            try:
                await ws.close(code=1008, reason='invalid_or_expired_session')
            except Exception:
                pass
        except WebSocketDisconnect:
            pass
        finally:
            if voice_registered:
                voice_connections.discard(voice_key)
            if work:
                work.cancel()
                await asyncio.gather(work, return_exceptions=True)
    return router
