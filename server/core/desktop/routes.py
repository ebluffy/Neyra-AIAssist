from __future__ import annotations

import asyncio
import base64
import hashlib
import json
from uuid import UUID

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, ConfigDict, Field

from core.desktop.bridge import ACTIVE_DESKTOP, BridgeRegistry, Manifest
from core.voice.desktop import DesktopVoice


class Packet(BaseModel):
    model_config = ConfigDict(extra='forbid')
    type: str = Field(max_length=32)
    text: str = Field(default='', max_length=6000)
    call_id: str = Field(default='', max_length=36)
    result: dict = Field(default_factory=dict)
    manifest: Manifest | None = None
    target_device_id: UUID | None = None
    request_id: UUID | None = None


def router_for(agent, config, authenticate):
    router = APIRouter()
    registry = BridgeRegistry()
    voice_service = DesktopVoice(config)
    voice_connections = set()

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
        return hashlib.sha256(('desktop-owner:' + authorization[7:]).encode()).hexdigest()

    async def read_manifest(ws):
        message = await asyncio.wait_for(ws.receive_text(), 10)
        if len(message) > 8192:
            raise ValueError('manifest_too_large')
        return Manifest.model_validate_json(message)

    @router.websocket('/v1/desktop/bridge')
    async def bridge(ws: WebSocket):
        owner = await authorize(ws)
        if owner is None:
            return
        await ws.accept()
        connection = None
        task = None
        lock = asyncio.Lock()
        async def send(packet):
            async with lock:
                await ws.send_json(packet)
        try:
            manifest = await read_manifest(ws)
            connection = registry.connect(owner, manifest, send)
            username = 'desktop:' + owner
            channel = 'desktop:' + str(manifest.session_id)
            await send(dict(type='hello', protocol='neyra.desktop.v1', device_id=str(manifest.device_id)))
            async def turn(text, target, request_id):
                async def turn_send(packet):
                    await send({**packet, "request_id": request_id})
                token = ACTIVE_DESKTOP.set((registry, owner, str(target.manifest.session_id), str(target.manifest.device_id)))
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
                raw = await asyncio.wait_for(ws.receive_text(), 300)
                if len(raw) > 32768:
                    raise ValueError('packet_too_large')
                packet = Packet.model_validate_json(raw)
                if packet.type == 'ping':
                    await send(dict(type='pong'))
                elif packet.type == 'capabilities' and packet.manifest:
                    updated = packet.manifest
                    if updated.device_id != manifest.device_id or updated.session_id != manifest.session_id:
                        raise ValueError('identity_changed')
                    registry.disconnect(connection)
                    manifest = updated
                    connection = registry.connect(owner, manifest, send)
                    if task:
                        task.cancel()
                    await send(dict(type='capabilities', tools=manifest.tools))
                elif packet.type == 'client_tool_result':
                    if len(json.dumps(packet.result)) > 16000:
                        raise ValueError('result_too_large')
                    registry.result(owner, connection, packet.call_id, packet.result)
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
                    target = registry.connections.get((owner, str(packet.target_device_id)))
                    if target is not None:
                        registry.disconnect(target)
                        await target.send(dict(type='revoked'))
                    await send(dict(type='devices', devices=registry.devices(owner)))
                elif packet.type == 'devices':
                    await send(dict(type='devices', devices=registry.devices(owner)))
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
                        target = registry.connections.get((owner, str(packet.target_device_id)))
                        if target is None:
                            await send(dict(type='error', code='device_unavailable'))
                            continue
                    task = asyncio.create_task(turn(packet.text, target, str(packet.request_id) if packet.request_id else None))
                else:
                    await send(dict(type='error', code='bad_packet'))
        except (ValueError, TimeoutError):
            await ws.close(code=1008, reason='invalid_or_expired_session')
        except WebSocketDisconnect:
            pass
        finally:
            if task:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            if connection:
                registry.disconnect(connection)

    @router.websocket('/v1/desktop/voice')
    async def voice(ws: WebSocket):
        owner = await authorize(ws)
        if owner is None:
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
            voice_key = (owner, str(manifest.device_id))
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
                    connection = registry.connections.get((owner, str(manifest.device_id)))
                    scope = None
                    if connection and connection.manifest.session_id == manifest.session_id:
                        scope = (registry, owner, str(manifest.session_id), str(manifest.device_id))
                    context_token = ACTIVE_DESKTOP.set(scope)
                    try:
                        async for chunk in agent.chat_stream(text, username='desktop:' + owner, channel_id=channel):
                            if chunk.get('type') == 'token':
                                await turn_send(dict(type='token', text=chunk.get('text', '')))
                            if chunk.get('type') == 'done':
                                response = chunk.get('text', '')
                                await turn_send(dict(type='done', text=response, model_trace=chunk.get('model_trace')))
                            if chunk.get('type') == 'error':
                                await turn_send(dict(type='error', code='chat_failed'))
                                return
                    finally:
                        ACTIVE_DESKTOP.reset(context_token)
                    if response:
                        wav = await asyncio.wait_for(voice_service.synthesize(response), 60)
                        if wav:
                            # V1 is half-duplex PTT: bounded final WAV, live sentence streaming is step 5.
                            for offset in range(0, len(wav), 48000):
                                await turn_send(dict(type='audio.chunk', data=base64.b64encode(wav[offset:offset+48000]).decode()))
                            await turn_send(dict(type='audio.done', mime='audio/wav'))
                        else:
                            await turn_send(dict(type='error', code='tts_unavailable'))
                except asyncio.CancelledError:
                    raise
                except Exception:
                    await turn_send(dict(type='error', code='voice_failed'))
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
                raw = packet.get('text') or ''
                if len(raw) > 1024:
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
                    current_request = str(UUID(message["request_id"])) if message.get("request_id") else None
                    work = asyncio.create_task(process(pcm, current_request))
                elif message.get('type') == 'stop':
                    audio.clear()
                    if work:
                        work.cancel()
                        await asyncio.gather(work, return_exceptions=True)
                    await send(dict(type='cancelled', request_id=current_request))
                elif message.get('type') == 'ping':
                    await send(dict(type='pong'))
                else:
                    raise ValueError('bad_packet')
        except (ValueError, TimeoutError):
            await ws.close(code=1008, reason='invalid_or_expired_session')
        except WebSocketDisconnect:
            pass
        finally:
            if voice_registered:
                voice_connections.discard(voice_key)
            if work:
                work.cancel()
                await asyncio.gather(work, return_exceptions=True)
    return router
