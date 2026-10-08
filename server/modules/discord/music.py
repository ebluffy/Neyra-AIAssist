"""Discord music module (Lavalink/wavelink): resident subscriber + invoke fallback."""

from __future__ import annotations

import asyncio
import logging
import random
import re
import time
from pathlib import Path
from typing import Any, Optional
from urllib.parse import parse_qs, urlparse

try:
    import discord
except Exception:  # pragma: no cover
    discord = None

from core.runtime.event_bus import (
    MUSIC_CLEAR,
    MUSIC_PAUSE,
    MUSIC_PLAY,
    MUSIC_QUEUE,
    MUSIC_RESUME,
    MUSIC_RESULT,
    MUSIC_SKIP,
    MUSIC_STOP,
    CoreEvent,
)

logger = logging.getLogger("neyra.discord.music")

DEFAULT_NODES = [
    {"identifier": "local-lavalink", "uri": "http://127.0.0.1:2333", "password": "youshallnotpass"},
]


def _format_ms(ms: int) -> str:
    total = max(0, int(ms // 1000))
    h = total // 3600
    m = (total % 3600) // 60
    s = total % 60
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m:02d}:{s:02d}"


def _truncate(s: str, n: int = 60) -> str:
    text = (s or "").strip()
    if len(text) <= n:
        return text
    return text[: n - 1] + "…"


_MEDIA_URL_RE = re.compile(r"https?://[^\s<>\"']+", re.IGNORECASE)

_YOUTUBE_HOSTS = frozenset(
    {
        "youtube.com",
        "m.youtube.com",
        "music.youtube.com",
        "youtu.be",
        "youtube-nocookie.com",
    }
)


def _extract_media_url(text: str) -> str:
    """First http(s) URL in text (Discord may wrap <>)."""
    raw = (text or "").strip()
    if not raw:
        return ""
    m = _MEDIA_URL_RE.search(raw)
    if not m:
        return ""
    return m.group(0).rstrip(").,]>\"'")


def _youtube_hostname(hostname: str) -> str:
    h = (hostname or "").lower().split(":")[0].strip(".")
    if h.startswith("www."):
        return h[4:]
    return h


def _is_youtube_host(hostname: str) -> bool:
    return _youtube_hostname(hostname) in _YOUTUBE_HOSTS


def _youtube_video_id(url: str) -> str:
    try:
        parsed = urlparse(url)
    except Exception:
        return ""
    if not _is_youtube_host(parsed.hostname or ""):
        return ""
    path = parsed.path or ""
    host = _youtube_hostname(parsed.hostname or "")
    if host == "youtu.be":
        return path.lstrip("/").split("/")[0].split("?")[0]
    qs = parse_qs(parsed.query or "")
    if qs.get("v"):
        return str(qs["v"][0] or "")
    parts = [p for p in path.split("/") if p]
    if len(parts) >= 2 and parts[0] in ("shorts", "embed", "live", "v"):
        return parts[1]
    return ""


def _canonical_youtube_url_from_text(text: str) -> str:
    """Only real YouTube hosts; returns watch URL or '' (never LAN/loopback/http abuse)."""
    url = _extract_media_url(text)
    if not url:
        return ""
    vid = _youtube_video_id(url)
    if not vid:
        return ""
    return f"https://www.youtube.com/watch?v={vid}"


def _normalize_play_query(raw: str) -> str:
    q = (raw or "").strip()
    if not q:
        return ""
    yt = _canonical_youtube_url_from_text(q)
    if yt:
        return yt
    # Drop non-YouTube URLs so Lavalink HTTP source never fetches arbitrary hosts.
    q = _MEDIA_URL_RE.sub("", q).strip()
    # Remove command noise so Lavalink search gets a clean artist/title query.
    noise_patterns = (
        r"^(вкл\w*|вруби|поставь|заиграй|play)\s*",
        r"^(любой|какую?[- ]?нибудь|какой[- ]?нибудь)\s+",
        r"^(трек|треков|песню|музыку)\s+",
        r"^(зайди|зайти)\s+в\s+(войс|голос\w*)\s*(и\s+)?",
    )
    for pat in noise_patterns:
        q = re.sub(pat, "", q, flags=re.IGNORECASE).strip()
    # Pure join/voice commands are not searchable track names.
    if re.fullmatch(
        r"(зайди|зайти|join)\s*(в\s+)?(войс|голос\w*|voice|vc)?",
        q,
        flags=re.IGNORECASE,
    ):
        return ""
    q = q.strip(" .,!?:;\"'")
    if q.lower() in {"музыку", "музыка", "песню", "песню", "трек", "track", "music"}:
        return ""
    return q


async def _connect_voice_player(
    *,
    wavelink_mod: Any,
    guild: Any,
    voice_channel: Any,
    timeout_s: float = 20.0,
) -> Any:
    """Connect or reuse a wavelink Player; retry once on Discord voice timeout."""
    player = guild.voice_client
    if isinstance(player, wavelink_mod.Player):
        try:
            cur = getattr(player, "channel", None)
            if cur is not None and getattr(cur, "id", None) != getattr(voice_channel, "id", None):
                await player.move_to(voice_channel)
        except Exception as move_ex:
            logger.warning("discord.music move_to failed | error=%s", move_ex)
        return player

    if player is not None:
        try:
            await player.disconnect(force=True)
        except Exception:
            pass

    last_ex: Exception | None = None
    for attempt in range(2):
        try:
            return await voice_channel.connect(
                cls=wavelink_mod.Player,
                self_deaf=True,
                timeout=timeout_s,
            )
        except Exception as ex:
            last_ex = ex
            logger.warning(
                "discord.music voice connect attempt %s failed | channel=%s error=%s",
                attempt + 1,
                getattr(voice_channel, "name", "?"),
                ex,
            )
            try:
                leftover = guild.voice_client
                if leftover is not None:
                    await leftover.disconnect(force=True)
            except Exception:
                pass
            await asyncio.sleep(0.8)
    assert last_ex is not None
    raise last_ex


async def _search_tracks_youtube(wavelink_mod: Any, query: str, node: Any) -> list[Any]:
    """Resolve playables. YouTube watch URLs load directly; text uses ytsearch fallbacks."""
    q = (query or "").strip()
    if not q:
        return []
    is_yt_url = bool(_youtube_video_id(q))
    timeout = 20.0 if is_yt_url else 12.0

    async def _search(raw: str, *, source: Any = None) -> list[Any]:
        if source is not None:
            tracks = await asyncio.wait_for(
                wavelink_mod.Playable.search(raw, source=source, node=node),
                timeout=timeout,
            )
        else:
            tracks = await asyncio.wait_for(
                wavelink_mod.Playable.search(raw, node=node),
                timeout=timeout,
            )
        return list(tracks or [])

    try:
        if is_yt_url:
            tracks = await _search(q)
            if tracks:
                return tracks
            logger.warning("discord.music url resolve empty | query=%s", q)
            return []

        source = getattr(getattr(wavelink_mod, "TrackSource", None), "YouTube", None)
        if source is not None:
            tracks = await _search(q, source=source)
            if tracks:
                return tracks
        tracks = await _search(q)
        if tracks:
            return tracks
        if not q.lower().startswith("ytsearch:"):
            tracks = await _search(f"ytsearch:{q}")
            if tracks:
                return tracks
        return []
    except Exception as ex:  # pragma: no cover
        logger.warning("discord.music youtube search failed | query=%s error=%s", q, ex)
        return []


class MusicTrack:
    def __init__(
        self,
        title: str,
        query: str,
        url: str = "",
        length_ms: int = 0,
        requested_by: str = "",
        requested_at: float | None = None,
    ) -> None:
        self.title = title
        self.query = query
        self.url = url
        self.length_ms = int(length_ms)
        self.requested_by = requested_by
        self.requested_at = float(requested_at if requested_at is not None else time.time())


class LavalinkPoolAdapter:
    """Thin adapter around wavelink pool with graceful fallback."""

    def __init__(self, nodes: list[dict[str, Any]]) -> None:
        self.nodes = nodes
        self.connected = False
        self.last_error = ""
        self._wavelink = None
        self.ranked_nodes: list[dict[str, Any]] = []
        self._tested = False
        self._connect_lock = asyncio.Lock()
        self._node_by_id: dict[str, dict[str, Any]] = {
            str(n.get("identifier") or ""): n for n in nodes if isinstance(n, dict)
        }
        self._node_backoff_until: dict[str, float] = {}

    @staticmethod
    async def _probe_node_latency_ms(uri: str, timeout: float = 2.5) -> float:
        parsed = urlparse(uri)
        host = parsed.hostname
        port = parsed.port
        if not host or not port:
            return float("inf")
        t0 = time.perf_counter()
        try:
            conn = asyncio.open_connection(host, port)
            reader, writer = await asyncio.wait_for(conn, timeout=timeout)
            writer.close()
            await writer.wait_closed()
            _ = reader
            return (time.perf_counter() - t0) * 1000.0
        except Exception:
            return float("inf")

    async def preflight_nodes(self) -> list[dict[str, Any]]:
        if self._tested:
            return self.ranked_nodes or list(self.nodes)
        scored: list[tuple[float, dict[str, Any]]] = []
        for node in self.nodes:
            uri = str(node.get("uri") or "")
            latency = await self._probe_node_latency_ms(uri)
            if latency == float("inf"):
                logger.warning(
                    "discord.music node unavailable at startup: %s (%s)",
                    node.get("identifier", "node"),
                    uri,
                )
                continue
            scored.append((latency, node))
            logger.info(
                "discord.music node probe | id=%s latency_ms=%.1f uri=%s",
                node.get("identifier", "node"),
                latency,
                uri,
            )
        scored.sort(key=lambda x: x[0])
        self.ranked_nodes = [x[1] for x in scored]
        self._tested = True
        if not self.ranked_nodes:
            self.last_error = "startup node preflight failed for all nodes"
        else:
            logger.info(
                "discord.music ranked nodes: %s",
                [str(n.get("identifier") or "node") for n in self.ranked_nodes],
            )
        return self.ranked_nodes

    async def connect(self, client: Any | None = None) -> int:
        async with self._connect_lock:
            if self._wavelink is not None:
                try:
                    pool_nodes = getattr(self._wavelink.Pool, "nodes", {}) or {}
                    connected_now = sum(
                        1 for n in pool_nodes.values() if str(getattr(getattr(n, "status", None), "name", "")).upper() == "CONNECTED"
                    )
                    if connected_now > 0:
                        self.connected = True
                        return connected_now
                except Exception:
                    pass
        try:
            import wavelink  # type: ignore

            self._wavelink = wavelink
        except Exception as ex:  # pragma: no cover
            self.last_error = f"wavelink unavailable: {ex}"
            logger.warning("discord.music: %s", self.last_error)
            self.connected = False
            return 0

        ranked = await self.preflight_nodes()
        if not ranked:
            self.connected = False
            self.last_error = "no ranked lavalink nodes after preflight"
            return 0
        # Connect only the best node at startup; others connect on failover.
        node = await self.ensure_node_connected(client=client, node_cfg=ranked[0])
        if node is None:
            self.connected = False
            return 0
        try:
            pool_nodes = getattr(self._wavelink.Pool, "nodes", {}) or {}
            connected_now = sum(
                1 for n in pool_nodes.values() if str(getattr(getattr(n, "status", None), "name", "")).upper() == "CONNECTED"
            )
            self.connected = connected_now > 0
            if self.connected:
                logger.info("discord.music: connected to %s lavalink node(s)", connected_now)
                self.last_error = ""
                return connected_now
        except Exception:
            pass
        self.connected = False
        return 0

    @staticmethod
    def _node_is_connected(node: Any) -> bool:
        return str(getattr(getattr(node, "status", None), "name", "")).upper() == "CONNECTED"

    async def ensure_node_connected(self, client: Any | None, node_cfg: dict[str, Any]) -> Any | None:
        if self._wavelink is None:
            try:
                import wavelink  # type: ignore

                self._wavelink = wavelink
            except Exception as ex:  # pragma: no cover
                self.last_error = f"wavelink unavailable: {ex}"
                return None

        identifier = str(node_cfg.get("identifier") or "")
        if not identifier:
            return None
        try:
            pool_nodes = getattr(self._wavelink.Pool, "nodes", {}) or {}
            if identifier in pool_nodes:
                node = pool_nodes[identifier]
                if self._node_is_connected(node):
                    return node
        except Exception:
            pass

        try:
            node_obj = self._wavelink.Node(
                identifier=identifier,
                uri=str(node_cfg.get("uri") or ""),
                password=str(node_cfg.get("password") or ""),
            )
            await self._wavelink.Pool.connect(nodes=[node_obj], client=client)
            node = None
            # Wait briefly for websocket handshake to reach CONNECTED.
            for _ in range(30):
                pool_nodes = getattr(self._wavelink.Pool, "nodes", {}) or {}
                node = pool_nodes.get(identifier)
                if node is not None and self._node_is_connected(node):
                    self.connected = True
                    return node
                await asyncio.sleep(0.1)
            self.last_error = f"node {identifier} is not connected yet"
            return None
        except Exception as ex:  # pragma: no cover
            self.last_error = str(ex)
            logger.warning("discord.music node connect failed | node=%s error=%s", identifier, ex)
            return None

    def preferred_connected_nodes(self) -> list[Any]:
        if self._wavelink is None:
            return []
        pool_nodes = getattr(self._wavelink.Pool, "nodes", {}) or {}
        ordered: list[Any] = []
        for n in (self.ranked_nodes or self.nodes):
            ident = str(n.get("identifier") or "")
            node = pool_nodes.get(ident)
            if node is not None:
                ordered.append(node)
        if ordered:
            return ordered
        return list(pool_nodes.values())

    def ranked_node_configs(self) -> list[dict[str, Any]]:
        ranked = self.ranked_nodes or self.nodes
        return [n for n in ranked if isinstance(n, dict)]

    def mark_node_failed(self, identifier: str, cooldown_s: float = 30.0) -> None:
        if not identifier:
            return
        self._node_backoff_until[identifier] = time.time() + max(1.0, float(cooldown_s))

    def is_node_available(self, identifier: str) -> bool:
        until = float(self._node_backoff_until.get(identifier, 0.0))
        return time.time() >= until


class MusicService:
    """Music orchestration service (queue/state + action handlers)."""

    def __init__(self, adapter: LavalinkPoolAdapter) -> None:
        self.adapter = adapter
        self.queue_by_guild: dict[str, list[MusicTrack]] = {}
        self.current_by_guild: dict[str, Optional[MusicTrack]] = {}
        self.paused_by_guild: dict[str, bool] = {}
        self.recent_requests: dict[str, float] = {}
        self.last_random_pick_by_guild: dict[str, str] = {}
        # YouTube often rejects first hit ("requires login") — keep sibling search results.
        self.play_fallbacks_by_guild: dict[str, list[Any]] = {}

    def _is_duplicate(self, key: str) -> bool:
        now = time.time()
        ts = self.recent_requests.get(key, 0.0)
        self.recent_requests[key] = now
        return now - ts < 5.0

    def _push(self, guild_id: str, track: MusicTrack) -> None:
        self.queue_by_guild.setdefault(guild_id, []).append(track)

    def _pop_next(self, guild_id: str) -> Optional[MusicTrack]:
        q = self.queue_by_guild.get(guild_id) or []
        if not q:
            return None
        return q.pop(0)

    def handle(self, action: str, payload: dict[str, Any]) -> dict[str, Any]:
        guild_id = str(payload.get("guild_id") or "")
        request_id = str(payload.get("request_id") or "")
        idem = str(payload.get("idempotency_key") or "")
        if idem and self._is_duplicate(idem):
            return {"ok": True, "status": "duplicate_ignored", "request_id": request_id}

        if action == MUSIC_PLAY:
            query = str(payload.get("query") or "").strip()
            if not query:
                return {"ok": False, "status": "failed", "error": "empty query", "request_id": request_id}
            t = MusicTrack(
                title=_truncate(query),
                query=query,
                requested_by=str(payload.get("requester_id") or ""),
            )
            if not self.current_by_guild.get(guild_id):
                self.current_by_guild[guild_id] = t
                self.paused_by_guild[guild_id] = False
                return {"ok": True, "status": "started", "request_id": request_id, "track": t.title}
            self._push(guild_id, t)
            return {"ok": True, "status": "queued", "request_id": request_id, "track": t.title}

        if action == MUSIC_PAUSE:
            self.paused_by_guild[guild_id] = True
            return {"ok": True, "status": "paused", "request_id": request_id}
        if action == MUSIC_RESUME:
            self.paused_by_guild[guild_id] = False
            return {"ok": True, "status": "resumed", "request_id": request_id}
        if action == MUSIC_SKIP:
            nxt = self._pop_next(guild_id)
            self.current_by_guild[guild_id] = nxt
            return {"ok": True, "status": "skipped", "next": nxt.title if nxt else "", "request_id": request_id}
        if action == MUSIC_STOP:
            self.current_by_guild[guild_id] = None
            self.queue_by_guild[guild_id] = []
            self.paused_by_guild[guild_id] = False
            return {"ok": True, "status": "stopped", "request_id": request_id}
        if action == MUSIC_CLEAR:
            self.queue_by_guild[guild_id] = []
            return {"ok": True, "status": "cleared", "request_id": request_id}
        if action == MUSIC_QUEUE:
            queue_titles = [x.title for x in self.queue_by_guild.get(guild_id, [])]
            cur = self.current_by_guild.get(guild_id)
            return {
                "ok": True,
                "status": "queue",
                "request_id": request_id,
                "current": cur.title if cur else "",
                "queue": queue_titles,
            }
        return {"ok": False, "status": "failed", "error": f"unknown action {action}", "request_id": request_id}

    def build_embed_payload(self, guild_id: str, result: dict[str, Any]) -> dict[str, Any]:
        # Lightweight payload so producer-side can render message if needed.
        cur = self.current_by_guild.get(guild_id)
        queue = self.queue_by_guild.get(guild_id, [])
        return {
            "title": "Нейра · музыка",
            "state": result.get("status", ""),
            "current": cur.title if cur else "—",
            "queue_size": len(queue),
            "queue_preview": [_truncate(x.title, 40) for x in queue[:5]],
            "duration": _format_ms(cur.length_ms) if cur else "00:00",
        }


async def _enhance_query_with_agent_brain(ctx, query: str) -> str:
    return (query or "").strip()


if discord is not None:

    class MusicControlView(discord.ui.View):
        """Lightweight controls adapted for Neyra service."""

        def __init__(self, service: MusicService, guild_id: str, requester_id: str):
            super().__init__(timeout=180)
            self.service = service
            self.guild_id = guild_id
            self.requester_id = requester_id

        async def _act(self, interaction: discord.Interaction, action: str) -> None:
            payload = {"guild_id": self.guild_id, "requester_id": self.requester_id, "action": action}
            res = self.service.handle(action, payload)
            await interaction.response.send_message(f"Музыка: {res.get('status', 'ok')}", ephemeral=True)

        @discord.ui.button(label="Пауза", style=discord.ButtonStyle.secondary)
        async def pause_btn(self, interaction: discord.Interaction, button: discord.ui.Button) -> None:  # type: ignore[override]
            await self._act(interaction, MUSIC_PAUSE)

        @discord.ui.button(label="Продолжить", style=discord.ButtonStyle.success)
        async def resume_btn(self, interaction: discord.Interaction, button: discord.ui.Button) -> None:  # type: ignore[override]
            await self._act(interaction, MUSIC_RESUME)

        @discord.ui.button(label="Пропустить", style=discord.ButtonStyle.primary)
        async def skip_btn(self, interaction: discord.Interaction, button: discord.ui.Button) -> None:  # type: ignore[override]
            await self._act(interaction, MUSIC_SKIP)

        @discord.ui.button(label="Стоп", style=discord.ButtonStyle.danger)
        async def stop_btn(self, interaction: discord.Interaction, button: discord.ui.Button) -> None:  # type: ignore[override]
            await self._act(interaction, MUSIC_STOP)


def build_music_embed(embed_payload: dict[str, Any]):
    if discord is None:
        return None
    emb = discord.Embed(title=str(embed_payload.get("title") or "Neyra Music"))
    emb.add_field(name="State", value=str(embed_payload.get("state") or "unknown"), inline=True)
    emb.add_field(name="Current", value=str(embed_payload.get("current") or "—"), inline=False)
    emb.add_field(name="Duration", value=str(embed_payload.get("duration") or "00:00"), inline=True)
    preview = embed_payload.get("queue_preview") or []
    emb.add_field(name="Queue", value="\n".join(preview) if preview else "Empty", inline=False)
    return emb


def _nodes_from_ctx(ctx) -> list[dict[str, Any]]:
    d = ctx.config.get("discord")
    if isinstance(d, dict):
        m = d.get("music")
        if isinstance(m, dict):
            nodes = m.get("nodes")
            if isinstance(nodes, list) and nodes:
                return [x for x in nodes if isinstance(x, dict)]
    legacy = ((ctx.config.get("plugins") or {}).get("discord_music") or {})
    nodes = legacy.get("nodes")
    if isinstance(nodes, list) and nodes:
        return [x for x in nodes if isinstance(x, dict)]
    return DEFAULT_NODES


def _ctx_service(ctx) -> MusicService:
    if getattr(ctx, "_discord_plugin_music_service", None):
        return ctx._discord_plugin_music_service
    adapter = LavalinkPoolAdapter(_nodes_from_ctx(ctx))
    service = MusicService(adapter)
    ctx._discord_plugin_music_service = service
    return service


def _resolve_bot(ctx):
    agent = getattr(ctx, "agent", None)
    if agent is None:
        return None
    return getattr(agent, "discord_client", None)


def _track_key(track: Any) -> str:
    return str(getattr(track, "identifier", "") or getattr(track, "title", "") or id(track))


async def _play_next_youtube_fallback(service: MusicService, player: Any, guild_id: str) -> bool:
    """Try next search hit after login/bot/load failure. Returns True if a play was started."""
    leftovers = list(service.play_fallbacks_by_guild.get(guild_id) or [])
    while leftovers:
        nxt = leftovers.pop(0)
        service.play_fallbacks_by_guild[guild_id] = leftovers
        title = str(getattr(nxt, "title", "") or _track_key(nxt))
        try:
            await player.play(nxt, replace=True)
            logger.info("discord.music youtube fallback started | guild=%s track=%r", guild_id, title)
            return True
        except Exception as ex:
            logger.warning(
                "discord.music youtube fallback play failed | guild=%s track=%r error=%s",
                guild_id,
                title,
                ex,
            )
    service.play_fallbacks_by_guild.pop(guild_id, None)
    return False


def _attach_track_end_listener(ctx) -> None:
    bot = _resolve_bot(ctx)
    if bot is None:
        return
    if getattr(ctx, "_discord_plugin_track_end_listener_added", False):
        return

    service = getattr(ctx, "_discord_plugin_music_service", None)

    async def _on_wavelink_track_exception(payload) -> None:
        try:
            player = getattr(payload, "player", None)
            if player is None:
                return
            guild = getattr(player, "guild", None)
            guild_id = str(getattr(guild, "id", "") or "")
            err = getattr(payload, "exception", None) or getattr(payload, "error", None)
            logger.warning(
                "discord.music track_exception | guild=%s error=%s",
                guild_id,
                err,
            )
            if service is None or not guild_id:
                return
            await _play_next_youtube_fallback(service, player, guild_id)
        except Exception as ex:  # pragma: no cover
            logger.warning("discord.music track_exception handler failed: %s", ex)

    async def _on_wavelink_track_end(payload) -> None:
        try:
            player = getattr(payload, "player", None)
            if player is None:
                return
            reason = str(getattr(payload, "reason", "") or "").lower()
            guild = getattr(player, "guild", None)
            guild_id = str(getattr(guild, "id", "") or "")
            # loadfailed after instant rejection — try sibling search hits first
            if service is not None and guild_id and reason in ("loadfailed", "load_failed"):
                if await _play_next_youtube_fallback(service, player, guild_id):
                    return
            if reason and reason not in ("finished", "stopped", "replaced", "loadfailed", "load_failed", "cleanup"):
                return
            if service is not None and guild_id and reason in ("finished", "stopped", "replaced"):
                service.play_fallbacks_by_guild.pop(guild_id, None)
            try:
                if len(player.queue) > 0:
                    nxt = player.queue.get()
                    if nxt is not None:
                        await player.play(nxt)
                        logger.info("discord.music track_end -> next queued track started")
                        return
            except Exception as ex:
                logger.warning("discord.music track_end queue advance failed: %s", ex)
            try:
                await player.stop(force=True)
            except Exception:
                pass
            logger.info("discord.music track_end -> queue empty, playback stopped")
        except Exception as ex:  # pragma: no cover
            logger.warning("discord.music track_end listener failed: %s", ex)

    # discord.Client in this project does not expose add_listener like commands.Bot.
    # Assigning handler to event method name is enough for dispatching.
    setattr(bot, "on_wavelink_track_exception", _on_wavelink_track_exception)
    setattr(bot, "on_wavelink_track_end", _on_wavelink_track_end)
    ctx._discord_plugin_track_end_listener_added = True
    logger.info("discord.music attached on_wavelink_track_end + track_exception listeners")


async def _handle_action_async(ctx, service: MusicService, action: str, payload: dict[str, Any]) -> dict[str, Any]:
    bot = _resolve_bot(ctx)
    if bot is None:
        return {"ok": False, "status": "failed", "error": "discord client is unavailable"}
    if not service.adapter.connected:
        connected = await service.adapter.connect(client=bot)
        if connected <= 0:
            return {
                "ok": False,
                "status": "failed",
                "error": f"lavalink is unavailable ({service.adapter.last_error or 'no nodes connected'})",
            }

    guild_id = int(str(payload.get("guild_id") or "0") or 0)
    if guild_id <= 0:
        return {"ok": False, "status": "failed", "error": "guild_id is required"}

    voice_channel_id = int(str(payload.get("voice_channel_id") or "0") or 0)
    guild = bot.get_guild(guild_id)
    if guild is None:
        return {"ok": False, "status": "failed", "error": f"guild {guild_id} not found"}

    voice_channel = guild.get_channel(voice_channel_id) if voice_channel_id else None
    if voice_channel is None:
        requester_id = int(str(payload.get("requester_id") or "0") or 0)
        member = guild.get_member(requester_id) if requester_id else None
        if member and member.voice and member.voice.channel:
            voice_channel = member.voice.channel
    if voice_channel is None:
        return {"ok": False, "status": "failed", "error": "join a voice channel first"}

    try:
        import wavelink  # type: ignore
    except Exception as ex:  # pragma: no cover
        return {"ok": False, "status": "failed", "error": f"wavelink unavailable: {ex}"}

    logger.info(
        "discord.music request | action=%s guild=%s voice_channel=%s query=%s",
        action,
        guild_id,
        getattr(voice_channel, "id", "unknown"),
        str(payload.get("query") or ""),
    )
    last_error = "unknown"
    for cfg in service.adapter.ranked_node_configs():
        try:
            cfg_id = str(cfg.get("identifier") or "")
            if not service.adapter.is_node_available(cfg_id):
                continue
            player = guild.voice_client
            node = await service.adapter.ensure_node_connected(client=bot, node_cfg=cfg)
            if node is None:
                last_error = service.adapter.last_error or "node connect failed"
                service.adapter.mark_node_failed(cfg_id, cooldown_s=20.0)
                continue
            if isinstance(player, wavelink.Player):
                try:
                    current_node = getattr(player, "node", None)
                    current_id = str(getattr(current_node, "identifier", "") or "")
                    if current_id != cfg_id:
                        await player.switch_node(node)
                except Exception as switch_ex:
                    last_error = str(switch_ex)
                    service.adapter.mark_node_failed(cfg_id, cooldown_s=25.0)
                    logger.warning("discord.music node switch failed | node=%s error=%s", cfg_id, switch_ex)
                    continue
                try:
                    cur = getattr(player, "channel", None)
                    if cur is not None and getattr(cur, "id", None) != getattr(voice_channel, "id", None):
                        await player.move_to(voice_channel)
                except Exception as move_ex:
                    last_error = str(move_ex)
                    logger.warning("discord.music move_to failed | error=%s", move_ex)
            else:
                player = await _connect_voice_player(
                    wavelink_mod=wavelink,
                    guild=guild,
                    voice_channel=voice_channel,
                    timeout_s=20.0,
                )

            if action == MUSIC_PAUSE:
                await player.pause(True)
                return {"ok": True, "status": "paused", "request_id": str(payload.get("request_id") or "")}
            if action == MUSIC_RESUME:
                await player.pause(False)
                return {"ok": True, "status": "resumed", "request_id": str(payload.get("request_id") or "")}
            if action == MUSIC_STOP:
                await player.stop(force=True)
                return {"ok": True, "status": "stopped", "request_id": str(payload.get("request_id") or "")}
            if action == MUSIC_SKIP:
                await player.skip(force=True)
                next_title = ""
                try:
                    if not bool(getattr(player, "playing", False)) and len(player.queue) > 0:
                        nxt = player.queue.get()
                        if nxt is not None:
                            await player.play(nxt)
                            next_title = str(getattr(nxt, "title", "") or "")
                except Exception:
                    pass
                return {
                    "ok": True,
                    "status": "skipped",
                    "next": next_title,
                    "request_id": str(payload.get("request_id") or ""),
                }
            if action == MUSIC_CLEAR:
                try:
                    player.queue.clear()
                except Exception:
                    pass
                return {"ok": True, "status": "cleared", "request_id": str(payload.get("request_id") or "")}
            if action == MUSIC_QUEUE:
                current_title = str(getattr(getattr(player, "current", None), "title", "") or "")
                queue_titles: list[str] = []
                try:
                    queue_titles = [
                        f"{str(getattr(t, 'author', '') or 'Unknown')} - {str(getattr(t, 'title', '') or '')}".strip()
                        for t in list(player.queue)
                    ]
                except Exception:
                    queue_titles = []
                return {
                    "ok": True,
                    "status": "queue",
                    "request_id": str(payload.get("request_id") or ""),
                    "current": current_title,
                    "queue": queue_titles,
                    "queue_total": len(queue_titles),
                }

            # PLAY / join-only
            join_only = bool(payload.get("join_only"))
            query = _normalize_play_query(str(payload.get("query") or "").strip())
            if join_only:
                ch_name = str(getattr(voice_channel, "name", "") or "voice")
                return {
                    "ok": True,
                    "status": "joined",
                    "track": "",
                    "author": "",
                    "channel": ch_name,
                    "request_id": str(payload.get("request_id") or ""),
                }
            if not query:
                # Mood / bare "включи музыку" → searchable default, not YouTube for command text.
                query = "upbeat happy music"
            local_result = service.handle(action, {**payload, "query": query})
            _ = local_result
            tracks = await _search_tracks_youtube(wavelink, query, node)
            if not tracks:
                last_error = f"nothing found for '{query}'"
                continue
            is_random = bool(payload.get("randomize"))
            top_k = int(payload.get("random_top_k") or 5)
            top_k = max(1, min(top_k, 10))
            pool = list(tracks)[:top_k]
            if is_random and pool:
                last_pick = service.last_random_pick_by_guild.get(str(guild_id), "")
                candidates_for_pick = [
                    t for t in pool if str(getattr(t, "identifier", "") or str(getattr(t, "title", ""))) != last_pick
                ]
                pick_source = candidates_for_pick or pool
                track = random.choice(pick_source)
                service.last_random_pick_by_guild[str(guild_id)] = str(
                    getattr(track, "identifier", "") or str(getattr(track, "title", ""))
                )
            else:
                track = tracks[0]
            # Keep other top hits so track_exception can skip "requires login" videos.
            chosen_key = _track_key(track)
            service.play_fallbacks_by_guild[str(guild_id)] = [
                t for t in pool if _track_key(t) != chosen_key
            ]
            candidates = [
                f"{str(getattr(t, 'author', '') or 'Unknown')} - {str(getattr(t, 'title', '') or '')}".strip()
                for t in pool
            ]
            if bool(getattr(player, "playing", False)):
                await player.queue.put_wait(track)
                return {
                    "ok": True,
                    "status": "queued",
                    "track": str(getattr(track, "title", query)),
                    "author": str(getattr(track, "author", "") or "Unknown"),
                    "source": str(getattr(track, "source", "")),
                    "node": str(getattr(node, "identifier", "")),
                    "request_id": str(payload.get("request_id") or ""),
                    "candidates": candidates,
                }
            await player.play(track, replace=False)
            return {
                "ok": True,
                "status": "started",
                "track": str(getattr(track, "title", query)),
                "author": str(getattr(track, "author", "") or "Unknown"),
                "source": str(getattr(track, "source", "")),
                "node": str(getattr(node, "identifier", "")),
                "request_id": str(payload.get("request_id") or ""),
                "candidates": candidates,
            }
        except Exception as ex:  # pragma: no cover
            last_error = str(ex)
            service.adapter.mark_node_failed(str(cfg.get("identifier") or ""), cooldown_s=30.0)
            logger.warning(
                "discord.music node failover | node=%s error=%s",
                str(cfg.get("identifier") or "unknown"),
                ex,
            )
            continue

    return {"ok": False, "status": "failed", "error": last_error}


def _build_result_event(source: str, payload: dict[str, Any], result: dict[str, Any], embed_payload: dict[str, Any]) -> CoreEvent:
    data = {
        "request_id": payload.get("request_id", ""),
        "action": payload.get("action", ""),
        "guild_id": payload.get("guild_id", ""),
        "text_channel_id": payload.get("text_channel_id", ""),
        "requester_id": payload.get("requester_id", ""),
        "result": result,
        "embed": embed_payload,
        "ts": time.time(),
    }
    return CoreEvent(MUSIC_RESULT, source, data)


def invoke_plugin(payload: dict[str, Any], ctx) -> dict[str, Any]:
    """Fallback on-demand entrypoint used by producer and API."""
    service = _ctx_service(ctx)
    action = str(payload.get("action") or MUSIC_PLAY)
    bot = _resolve_bot(ctx)
    if bot is not None and getattr(bot, "loop", None):
        try:
            fut = asyncio.run_coroutine_threadsafe(
                _handle_action_async(ctx, service, action, payload),
                bot.loop,
            )
            result = fut.result(timeout=20)
        except Exception as ex:  # pragma: no cover
            logger.error("discord.music invoke async fallback failed: %s", ex)
            result = {"ok": False, "status": "failed", "error": str(ex)}
    else:
        result = service.handle(action, payload)
    guild_id = str(payload.get("guild_id") or "")
    embed_payload = service.build_embed_payload(guild_id, result)
    if getattr(ctx, "agent", None):
        ctx.agent.event_bus.publish(
            _build_result_event("interfaces.discord.music.invoke", payload, result, embed_payload)
        )
    return {"ok": bool(result.get("ok")), "result": result, "embed": embed_payload}


def _event_handler(ctx, action: str):
    def _handler(event) -> None:
        if event.event_type != action:
            return
        payload = dict(event.payload or {})
        payload.setdefault("action", action)
        service = _ctx_service(ctx)
        bot = _resolve_bot(ctx)
        if bot is None or not getattr(bot, "loop", None):
            result = {"ok": False, "status": "failed", "error": "discord client loop unavailable"}
            guild_id = str(payload.get("guild_id") or "")
            embed_payload = service.build_embed_payload(guild_id, result)
            ctx.agent.event_bus.publish(
                _build_result_event("interfaces.discord.music.event", payload, result, embed_payload)
            )
            return

        async def _run() -> None:
            try:
                result = await _handle_action_async(ctx, service, action, payload)
                guild_id = str(payload.get("guild_id") or "")
                embed_payload = service.build_embed_payload(guild_id, result)
                ctx.agent.event_bus.publish(
                    _build_result_event("interfaces.discord.music.event", payload, result, embed_payload)
                )
                logger.info("discord.music handled %s => %s", action, result.get("status"))
            except Exception as ex:  # pragma: no cover
                logger.exception("discord.music async handler failed for %s: %s", action, ex)

        bot.loop.call_soon_threadsafe(lambda: asyncio.create_task(_run()))

    return _handler


def bootstrap_resident(ctx) -> None:
    """Subscribe to MUSIC_* and start Lavalink + node preflight in a background thread."""
    if not getattr(ctx, "agent", None):
        logger.warning("discord.music resident mode requires agent context")
        return

    _ctx_service(ctx)

    def _boot_lavalink_and_nodes() -> None:
        # Do not block Discord client startup on JVM boot (can be ~30–90s).
        try:
            from modules.discord.lavalink_process import ensure_managed_lavalink

            plugin_dir = Path(__file__).resolve().parent
            ok, detail = ensure_managed_lavalink(getattr(ctx, "config", None) or {}, plugin_dir)
            if ok:
                logger.info("discord.lavalink: %s", detail)
            else:
                logger.error("discord.lavalink: %s", detail)
        except Exception:
            logger.exception("discord.lavalink: ensure_managed_lavalink failed")

        for _ in range(120):
            bot = _resolve_bot(ctx)
            if bot is not None and getattr(bot, "loop", None) and bot.is_ready():
                async def _init_nodes() -> None:
                    service = _ctx_service(ctx)
                    _attach_track_end_listener(ctx)
                    await service.adapter.preflight_nodes()
                    connected = await service.adapter.connect(client=bot)
                    if connected <= 0:
                        logger.error(
                            "discord.music startup connect failed: %s",
                            service.adapter.last_error or "no connected nodes",
                        )
                bot.loop.call_soon_threadsafe(lambda: asyncio.create_task(_init_nodes()))
                return
            time.sleep(0.5)
        logger.warning("discord.music startup node preflight skipped: discord client not ready in time")

    import threading
    threading.Thread(target=_boot_lavalink_and_nodes, name="neyra-music-boot", daemon=True).start()

    for ev in (MUSIC_PLAY, MUSIC_PAUSE, MUSIC_RESUME, MUSIC_SKIP, MUSIC_QUEUE, MUSIC_STOP, MUSIC_CLEAR):
        ctx.agent.event_bus.subscribe(ev, _event_handler(ctx, ev))
    logger.info("discord.music resident subscribed to MUSIC_* events (lazy lavalink connect)")



def run_plugin(ctx) -> None:
    """Alias for legacy callers (e.g. old discord_music manifest)."""
    bootstrap_resident(ctx)
