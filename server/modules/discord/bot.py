"""
Discord-интерфейс Нейры: диалог в тексте/картинках (без STT/TTS) и музыка (Lavalink).

Задача:
- принимать сообщения и вложения;
- стримить ответы агента;
- обрабатывать музыкальные интенты и эмбеды очереди.
"""

from __future__ import annotations

import asyncio
import base64
import functools
import logging
import os
import random
from datetime import datetime, timezone
import re
import time
from typing import TYPE_CHECKING, Any, Optional

import discord
import httpx
from discord import app_commands
from discord.ext import tasks
from discord.app_commands import Choice

from core.llm.profile import resolve_openai_compatible_connection

from core.runtime.event_bus import (
    MUSIC_CLEAR,
    MUSIC_PAUSE,
    MUSIC_PLAY,
    MUSIC_QUEUE,
    MUSIC_RESUME,
    MUSIC_RESULT,
    MUSIC_SKIP,
    MUSIC_STOP,
    NOTIFY_DISCORD_MESSAGE_SENT,
    CoreEvent,
)

if TYPE_CHECKING:
    from core.neyra import NeyraAgent
    from core.reflection import ReflectionEngine

logger = logging.getLogger("neyra.discord")

MAX_MSG_LEN = 1900
THINKING_DOT = "▌"
QUEUE_PAGE_SIZE = 10
# Discord embed field value limit; keep headroom for ellipsis
EMBED_FIELD_SAFE = 1000

# Суффикс к запросу в ядро: web_search + полный вывод; ядро дополнительно включает lyrics_mode (см. core/agent.py).
LYRICS_HIDDEN_SUFFIX = (
    "\n\n[SYSTEM HIDDEN INSTRUCTION: User wants lyrics. You MUST use the web_search tool to find the exact lyrics. "
    "Do NOT generate lyrics from internal memory. CRITICAL: Output the FULL lyrics preserving original formatting. "
    "Separate verses and choruses with real line breaks (press Enter / actual newlines), never the two characters backslash-n. "
    "Do NOT squash the text into a single paragraph. "
    "Override any brevity rule: the reply must be the complete song text, not a summary.]"
)

INTENT_LABELS = frozenset({"PLAY_MUSIC", "GET_LYRICS", "CHAT"})


def chunk_message(text: str, limit: int = 1900) -> list[str]:
    """
    Делит текст на части под лимит Discord (~2000); сначала по \\n, иначе по пробелу, иначе по длине.
    Не режет строку посередине, если есть естественная точка разрыва в окне.
    """
    if limit < 1:
        raise ValueError("limit must be >= 1")
    raw = text or ""
    if len(raw) <= limit:
        return [raw]
    out: list[str] = []
    rest = raw
    while rest:
        if len(rest) <= limit:
            out.append(rest)
            break
        window = rest[:limit]
        cut = window.rfind("\n")
        if cut > 0:
            out.append(rest[:cut].rstrip())
            rest = rest[cut + 1 :].lstrip("\n")
            continue
        cut = window.rfind(" ")
        if cut > 0:
            out.append(rest[:cut].rstrip())
            rest = rest[cut + 1 :].lstrip()
            continue
        out.append(rest[:limit])
        rest = rest[limit:]
    return out if out else [""]


def chunk_codeblock_message(text: str, limit: int = 1900, fence: str = "```text\n") -> list[str]:
    """
    Split text into multiple Discord code blocks.
    Each part is wrapped as:
      ```text
      ...
      ```
    """
    closing = "\n```"
    inner_limit = max(1, limit - len(fence) - len(closing))
    chunks = chunk_message(text, limit=inner_limit)
    return [f"{fence}{chunk}{closing}" for chunk in chunks]

COL_BRAND = 0x5865F2
COL_OK = 0x57F287
COL_ERR = 0xED4245
COL_WARN = 0xFEE75C


def _lyrics_request_hint(text: str) -> bool:
    """Грубый признак запроса текста песни — включает LLM-классификатор до маршрутизации."""
    t = (text or "").lower()
    if re.search(
        r"(текст\s+песн\w*|слова\s+песн\w*|lyrics|куплет(а|ы)?\b|реплик(а|и)\s+текст|"
        r"дай\s+текст|найди\s+текст|покажи\s+текст|скинь\s+текст|текст\s+трека|слова\s+трека|"
        r"^(текст|слова)\s*$)",
        t,
    ):
        return True
    return False


def _extract_lyrics_song_query(text: str) -> str:
    """Убирает «текст песни / lyrics» — остаётся название, если пользователь его дописал."""
    q = (text or "").strip()
    q = re.sub(
        r"^(пожалуйста[, ]*)?(дай|найди|покажи|скинь|выдай)?\s*"
        r"(мне\s+)?(полный\s+|весь\s+)?"
        r"(текст|слова|lyrics)(\s+(песн\w*|трека|трек\w*|этой\s+песн\w*|текущ\w*))?\s*"
        r"[:\-–—]?\s*",
        "",
        q,
        flags=re.IGNORECASE,
    ).strip()
    q = re.sub(r"^(песн[ияи]|трек[а]?)[:\s]+", "", q, flags=re.IGNORECASE).strip(" .,!?;:\"'")
    if q.lower() in {"пожалуйста", "пж", "pls", "please", "этой", "текущей", "сейчас", "current"}:
        return ""
    return q


def _soft_music_hint(text: str) -> bool:
    """Слабый признак «про музыку/войс», даже без жёсткого глагола включи/поставь."""
    t = (text or "").lower()
    return bool(
        re.search(
            r"(музык|песн|трек|плейлист|саунд|soundcloud|spotify|youtu\.?be|"
            r"войс|голос(ов|ой)|лавалинк|lavalink|послуш|поставь\s+что|"
            r"давай\s+(что|трек|песн|музык)|заиграй|включи\s+что)",
            t,
        )
    )


def _normalize_intent_label(raw: str) -> str:
    """Достаём одно из PLAY_MUSIC | GET_LYRICS | CHAT из ответа микро-модели."""
    s = (raw or "").strip().upper()
    for label in ("GET_LYRICS", "PLAY_MUSIC", "CHAT"):
        if label in s:
            return label
    m = re.search(r"\b(PLAY_MUSIC|GET_LYRICS|CHAT)\b", s)
    if m:
        return m.group(1)
    if re.search(r"LYRIC", s):
        return "GET_LYRICS"
    if re.search(r"PLAY", s) and "CHAT" not in s:
        return "PLAY_MUSIC"
    return "CHAT"


def _intent_classifier_model(cfg: dict) -> str:
    from core.llm.profile import resolve_role_provider, resolved_memory_model

    prov = resolve_role_provider(cfg, "memory_model")
    return resolved_memory_model(cfg, prov)


def _clip_field(text: str, limit: int = EMBED_FIELD_SAFE) -> str:
    t = (text or "").strip()
    if len(t) <= limit:
        return t or "—"
    return t[: max(0, limit - 1)] + "…"


def _normalize_music_handler_result(result: dict[str, Any]) -> dict[str, Any]:
    """Event path uses payload.result; invoke_plugin returns top-level result."""
    pl = result.get("payload")
    if isinstance(pl, dict):
        inner = pl.get("result")
        if isinstance(inner, dict):
            return inner
    r = result.get("result")
    if isinstance(r, dict):
        return r
    return {}


def _queue_page_embed(current: str, items: list[str], page: int, page_size: int = QUEUE_PAGE_SIZE) -> discord.Embed:
    total = len(items)
    pages = max(1, (total + page_size - 1) // page_size)
    page = max(0, min(page, pages - 1))
    start = page * page_size
    end = min(start + page_size, total)
    page_items = items[start:end]
    embed = discord.Embed(
        title="Очередь воспроизведения",
        description="Нейра · музыкальный плеер",
        color=COL_BRAND,
        timestamp=datetime.now(timezone.utc),
    )
    embed.add_field(
        name="▶ Сейчас",
        value=_clip_field(current or "ничего не играет", EMBED_FIELD_SAFE),
        inline=False,
    )
    if page_items:
        lines = [f"`{start + idx + 1}.` {_clip_field(str(title), 180)}" for idx, title in enumerate(page_items)]
        q_body = _clip_field("\n".join(lines), EMBED_FIELD_SAFE)
        embed.add_field(name="В очереди", value=q_body, inline=False)
    else:
        embed.add_field(name="В очереди", value="Пусто.", inline=False)
    embed.add_field(name="Всего в очереди", value=str(total), inline=True)
    embed.set_footer(text=f"Страница {page + 1} из {pages} · листайте кнопками ниже")
    return embed


class QueuePagerView(discord.ui.View):
    def __init__(self, current: str, items: list[str], author_id: int, page_size: int = QUEUE_PAGE_SIZE):
        super().__init__(timeout=180)
        self.current = current
        self.items = items
        self.page_size = page_size
        self.page = 0
        self.author_id = author_id

    def _pages(self) -> int:
        total = len(self.items)
        return max(1, (total + self.page_size - 1) // self.page_size)

    async def _redraw(self, interaction: discord.Interaction) -> None:
        emb = _queue_page_embed(self.current, self.items, self.page, self.page_size)
        try:
            await interaction.response.edit_message(embed=emb, view=self)
        except discord.HTTPException:
            try:
                await interaction.response.send_message("Не удалось обновить сообщение.", ephemeral=True)
            except Exception:
                pass

    @discord.ui.button(label="◀", style=discord.ButtonStyle.secondary)
    async def prev_page(self, interaction: discord.Interaction, button: discord.ui.Button) -> None:  # type: ignore[override]
        if interaction.user.id != self.author_id:
            await interaction.response.send_message("Только автор запроса может листать очередь.", ephemeral=True)
            return
        self.page = (self.page - 1) % self._pages()
        await self._redraw(interaction)

    @discord.ui.button(label="▶", style=discord.ButtonStyle.secondary)
    async def next_page(self, interaction: discord.Interaction, button: discord.ui.Button) -> None:  # type: ignore[override]
        if interaction.user.id != self.author_id:
            await interaction.response.send_message("Только автор запроса может листать очередь.", ephemeral=True)
            return
        self.page = (self.page + 1) % self._pages()
        await self._redraw(interaction)


def _music_status_embed(
    title: str,
    description: str,
    *,
    color: int = COL_BRAND,
    footer: str = "Нейра · Discord",
) -> discord.Embed:
    emb = discord.Embed(
        title=title,
        description=_clip_field(description, 3800),
        color=color,
        timestamp=datetime.now(timezone.utc),
    )
    emb.set_footer(text=footer)
    return emb


class NeyraDiscordBot(discord.Client):
    def __init__(
        self,
        agent: "NeyraAgent",
        config: dict,
        reflection: Optional["ReflectionEngine"] = None,
    ):
        intents = discord.Intents.default()
        intents.message_content = True
        intents.members = True
        super().__init__(intents=intents)
        self.tree = app_commands.CommandTree(self)

        self.agent = agent
        self.config = config
        self.reflection = reflection
        disc_cfg = config.get("discord", {}) or {}

        self.active_channel_ids: set[int] = {int(c) for c in disc_cfg.get("channel_ids", [])}
        self.mention_only: bool = bool(disc_cfg.get("mention_only", False))
        self.stream_edit_interval: float = float(disc_cfg.get("stream_edit_interval", 0.8))
        self.stream_output_mode: str = str(disc_cfg.get("stream_output_mode", "stream")).strip().lower()
        self._cooldown: float = float(disc_cfg.get("cooldown_seconds", 3.0))
        self._last_response: dict[int, float] = {}
        self._music_waiters: dict[str, asyncio.Future] = {}
        self._music_timeout_s: float = float(disc_cfg.get("music_result_timeout_seconds", 25.0))

        self.agent.event_bus.subscribe(MUSIC_RESULT, self._on_music_result)

    def _internal_api_base_url(self) -> str:
        ia = self.config.get("internal_api") or {}
        host = str(ia.get("host") or "127.0.0.1")
        port = int(ia.get("port") or 8787)
        return f"http://{host}:{port}".rstrip("/")

    def _resolve_proactive_text_channel(self) -> Optional[discord.TextChannel]:
        disc = self.config.get("discord") or {}
        proactive = disc.get("proactive") if isinstance(disc.get("proactive"), dict) else {}
        raw_c = proactive.get("channel_id")
        if raw_c is not None and str(raw_c).strip().lower() not in ("", "null", "none"):
            ch = self.get_channel(int(raw_c))
            if isinstance(ch, discord.TextChannel):
                return ch
        for cid in sorted(self.active_channel_ids):
            ch = self.get_channel(int(cid))
            if isinstance(ch, discord.TextChannel):
                return ch
        return None

    async def _internal_api_chat(
        self,
        *,
        text: str,
        channel_id: int,
        username: str,
        platform_user_id: str,
        author_display_name: str,
    ) -> Optional[str]:
        """Этап B5: спонтанное сообщение только через Internal API (`POST /v1/chat`), без прямого вызова ядра."""
        ia = self.config.get("internal_api") or {}
        token = str(ia.get("token") or "").strip()
        headers: dict[str, str] = {"Content-Type": "application/json", "Accept": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        body = {
            "text": text,
            "username": username,
            "platform_user_id": platform_user_id,
            "channel_id": str(channel_id),
            "author_display_name": author_display_name,
        }
        disc = self.config.get("discord") or {}
        proactive = disc.get("proactive") if isinstance(disc.get("proactive"), dict) else {}
        timeout = float(proactive.get("request_timeout_seconds") or ia.get("proactive_chat_timeout_seconds") or 180.0)
        url = f"{self._internal_api_base_url()}/v1/chat"
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                r = await client.post(url, headers=headers, json=body)
            r.raise_for_status()
            payload = r.json()
            if not payload.get("ok"):
                logger.warning("proactive /v1/chat: ответ ok=false | %s", payload)
                return None
            data = payload.get("data")
            if isinstance(data, dict):
                return str(data.get("text") or "").strip()
            return None
        except Exception as e:
            logger.warning("proactive /v1/chat не удался: %s", e)
            return None

    @tasks.loop(seconds=1)
    async def proactive_spark(self):
        """Периодическое сообщение в канал: интервал задаётся паузой внутри итерации (рандом 10–30 мин и др.)."""
        disc = self.config.get("discord") or {}
        proactive = disc.get("proactive") if isinstance(disc.get("proactive"), dict) else {}
        if not bool(proactive.get("enabled", False)):
            return
        lo_m = float(proactive.get("min_interval_minutes", 10))
        hi_m = float(proactive.get("max_interval_minutes", 30))
        lo_s = max(60.0, lo_m * 60.0)
        hi_s = max(lo_s, hi_m * 60.0)
        await asyncio.sleep(random.uniform(lo_s, hi_s))

        channel = self._resolve_proactive_text_channel()
        if channel is None:
            logger.warning("proactive: нет текстового канала — задайте discord.channel_ids или discord.proactive.channel_id")
            return

        default_prompt = (
            "[System]: Придумай спонтанное сообщение для чата, используй актуальные мемы или коротко прокомментируй тишину. "
            "Не пиши, что это команда или задание. Одна или две короткие реплики, как живая участница чата."
        )
        prompt = str(proactive.get("prompt") or "").strip() or default_prompt
        uname = str(proactive.get("username") or "neyra_proactive").strip() or "neyra_proactive"
        pid = str(proactive.get("platform_user_id") or "discord_proactive").strip() or "discord_proactive"
        adisp = str(proactive.get("author_display_name") or "Нейра").strip() or "Нейра"

        reply = await self._internal_api_chat(
            text=prompt,
            channel_id=int(channel.id),
            username=uname,
            platform_user_id=pid,
            author_display_name=adisp,
        )
        if not reply:
            return
        preview = self._make_preview(reply, lyrics_mode=False)
        if not preview:
            return
        parts = chunk_message(preview, limit=MAX_MSG_LEN)
        await channel.send(parts[0])
        for chunk in parts[1:]:
            await channel.send(chunk)
        logger.info("Proactive Discord: отправлено в #%s, частей=%s", channel.name, len(parts))

    @proactive_spark.before_loop
    async def proactive_spark_before(self):
        await self.wait_until_ready()

    def _current_playing_label(self, guild: Optional[discord.Guild]) -> str:
        """Title/author of the track currently playing in this guild (wavelink Player)."""
        if guild is None:
            return ""
        try:
            vc = guild.voice_client
            cur = getattr(vc, "current", None) if vc is not None else None
            if cur is None:
                return ""
            title = str(getattr(cur, "title", "") or "").strip()
            author = str(getattr(cur, "author", "") or "").strip()
            # Drop common YouTube noise for lyrics search.
            title = re.sub(
                r"\s*[\(\[]?(official\s+audio|official\s+video|lyrics?|prod\.\s*[^)\]]+)[\)\]]?\s*",
                " ",
                title,
                flags=re.IGNORECASE,
            )
            title = re.sub(r"\s+", " ", title).strip(" -–—")
            if author and title:
                if author.lower() in title.lower():
                    return title
                return f"{author} — {title}"
            return title or author
        except Exception as ex:
            logger.debug("current playing label failed: %s", ex)
            return ""

    def _build_lyrics_chat_content(self, user_text: str, guild: Optional[discord.Guild]) -> str:
        """
        Build lyrics request for the agent.
        Bare «текст песни» → use currently playing track; otherwise use the named song.
        """
        named = _extract_lyrics_song_query(user_text)
        current = self._current_playing_label(guild)
        if named:
            song = named
            src = "user"
        elif current:
            song = current
            src = "now_playing"
        else:
            return (
                "Пользователь просит текст песни, но сейчас ничего не играет и название не указано. "
                "Коротко скажи: включи трек или напиши «текст песни <название>»."
                + LYRICS_HIDDEN_SUFFIX
            )
        logger.info("Discord lyrics | src=%s song=%r", src, song)
        # Keep song in «quotes» first so auto-websearch can extract a clean query.
        return (
            f"Текст песни «{song}». "
            f"Найди полный текст через web_search (запрос вроде «{song} lyrics») "
            f"и выдай его целиком с переносами строк. Не включай музыку и не заменяй текст ссылкой."
            + LYRICS_HIDDEN_SUFFIX
        )

    def _candidate_music_intent(self, text: str) -> Optional[dict[str, str]]:
        raw = (text or "").strip()
        if not raw:
            return None
        lowered = raw.lower()
        if re.search(r"\b(читы|чит|hack|hax|aimbot)\b", lowered):
            return None
        # Lyrics-only requests must not become PLAY via regex.
        if _lyrics_request_hint(raw) and not re.search(
            r"\b(включи|вруби|поставь|play|заиграй|в\s+войс|в\s+голос)\b",
            lowered,
        ):
            return None
        direct = [
            (MUSIC_PAUSE, r"\b(пауза|pause|приостанови)\b"),
            (MUSIC_RESUME, r"\b(продолжи|resume|возобнови)\b"),
            (MUSIC_SKIP, r"\b(скип|skip|следующ|пропусти)\b"),
            (MUSIC_STOP, r"\b(стоп|stop|выключи музыку|останови музыку)\b"),
            (MUSIC_CLEAR, r"\b(очисти очередь|clear queue|clear)\b"),
            (MUSIC_QUEUE, r"\b(очередь|queue|что играет|что в очереди)\b"),
        ]
        for action, pattern in direct:
            if re.search(pattern, lowered):
                return {"intent": "music_control", "action": action, "query": ""}

        # Pure "join voice" — connect only, do NOT search YouTube for that phrase.
        if re.fullmatch(
            r"(пожалуйста[, ]*)?(зайди|зайти|зайди\s+пожалуйста|join)\s+"
            r"(в\s+)?(войс|голос(овой)?(\s+канал)?|voice(\s+channel)?|vc)\s*[.!]?",
            lowered,
        ):
            return {
                "intent": "music_control",
                "action": MUSIC_PLAY,
                "query": "",
                "join_only": "1",
            }

        has_music_verb = bool(
            re.search(
                r"\b(вкл\w*|вруби|поставь|заиграй|play|music|музык[ауеи]|песн[яюи]|трек|"
                r"track|плейлист|playlist)\b",
                lowered,
            )
        )
        wants_voice_play = bool(
            re.search(
                r"(в\s+войс|в\s+голос(овой)?|зайди\s+в\s+войс|зайти\s+в\s+войс|"
                r"join\s+voice|play\s+in\s+vc)",
                lowered,
            )
        )
        has_url = bool(re.search(r"https?://\S+", raw))
        if not has_music_verb and not has_url and not wants_voice_play:
            return None
        q = re.sub(r"^(эй\s+нейра|нейра|please|пожалуйста)[,:\s-]*", "", raw, flags=re.IGNORECASE).strip()
        q = re.sub(
            r"^(вкл\w*|вруби|поставь|заиграй|play|music|музыка)\s+",
            "",
            q,
            flags=re.IGNORECASE,
        ).strip()
        q = re.sub(
            r"(зайди|зайти)\s+в\s+(войс|голос\w*)\s*(и\s+)?|"
            r"\b(в\s+войс[еу]?|в\s+голос(овой)?\s*канал[еу]?)\b",
            " ",
            q,
            flags=re.IGNORECASE,
        )
        q = re.sub(r"\s+", " ", q).strip(" .,!?;:-")
        # Never search YouTube for leftover command crumbs / raw join text.
        if not q or q.lower() in {
            "музыку",
            "музыка",
            "песню",
            "трек",
            "что-нибудь",
            "что нибудь",
            "какую-нибудь",
            "какой-нибудь",
        }:
            q = "upbeat happy music"
        return {"intent": "music_control", "action": MUSIC_PLAY, "query": q}

    async def _classify_intent(self, user_text: str) -> str:
        """
        Микро-классификатор для маршрутизации Discord: музыка vs текст песни vs обычный чат.
        Модель — llm.memory_model (provider + id из той же роли).
        """
        prompt = (
            "You are an intent classifier for a Discord bot that CAN join a voice channel "
            "and play audio via Lavalink. Reply with EXACTLY ONE label:\n"
            "PLAY_MUSIC — user wants audio played in Discord voice (include mood requests like "
            "'включи весёлую музыку', 'зайди в войс и включи', song/artist names to play).\n"
            "GET_LYRICS — user wants song lyrics/text only, not playback.\n"
            "CHAT — everything else (questions, banter, links without play intent).\n"
            "When unsure between PLAY_MUSIC and CHAT but the message mentions music/song/track/voice, "
            "prefer PLAY_MUSIC.\n"
            "User text: "
            + (user_text or "")
        )
        try:
            conn = resolve_openai_compatible_connection(self.config, role="memory_model")
            model = _intent_classifier_model(self.config)
            url = f"{conn.base_url}/chat/completions"
            headers: dict[str, str] = {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {conn.api_key}",
            }
            headers.update({str(k): str(v) for k, v in dict(conn.default_headers).items()})
            body: dict[str, Any] = {
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": 16,
                "temperature": 0.0,
            }
            async with httpx.AsyncClient(timeout=20.0) as client:
                r = await client.post(url, headers=headers, json=body)
            r.raise_for_status()
            data = r.json()
            choice = (data.get("choices") or [{}])[0]
            msg = choice.get("message") or {}
            content = str(msg.get("content") or "").strip()
            label = _normalize_intent_label(content)
            if label in INTENT_LABELS:
                return label
            return "CHAT"
        except Exception as ex:
            logger.warning("Discord intent classifier failed: %s", ex)
            return "CHAT"

    def _on_music_result(self, event: CoreEvent) -> None:
        payload = event.payload or {}
        request_id = str(payload.get("request_id") or "")
        if not request_id:
            return
        fut = self._music_waiters.get(request_id)
        if fut and not fut.done():
            fut.set_result(payload)

    async def _publish_music_with_fallback(self, payload: dict[str, Any]) -> dict:
        request_id = str(payload.get("request_id") or "")
        loop = asyncio.get_running_loop()
        waiter = loop.create_future()
        if request_id:
            self._music_waiters[request_id] = waiter
        self.agent.event_bus.publish(CoreEvent(str(payload.get("action") or MUSIC_PLAY), "interfaces.discord", payload))
        try:
            result_payload = await asyncio.wait_for(waiter, timeout=self._music_timeout_s)
            return {"ok": True, "mode": "event", "payload": result_payload}
        except asyncio.TimeoutError:
            # Stage A contract: discord text/music interact via Event Bus only.
            action = str(payload.get("action") or MUSIC_PLAY)
            counts = self.agent.event_bus.handler_counts()
            by_type = counts.get("by_type") if isinstance(counts, dict) else {}
            subscribed = int((by_type or {}).get(action, 0)) > 0
            if subscribed:
                # Consumer can still be processing (node failover / track search).
                return {"ok": True, "mode": "pending", "payload": {"action": action, "status": "pending"}}
            return {
                "ok": False,
                "mode": "event_timeout",
                "error": f"music consumer is not subscribed for action={action}",
            }
        finally:
            if request_id:
                self._music_waiters.pop(request_id, None)

    async def on_ready(self):
        # Shared runtime handle for in-process music + other Discord-adjacent plugins.
        self.agent.discord_client = self
        await self.change_presence(
            activity=discord.Activity(type=discord.ActivityType.listening, name="текст и музыка · Нейра")
        )
        logger.info("Discord online: %s (ID: %s)", self.user, self.user.id if self.user else "?")
        if self.active_channel_ids:
            logger.info("Активные каналы: %s", self.active_channel_ids)
        else:
            logger.info("Активных каналов нет — отвечаю только на @mention")

        disc_cfg = self.config.get("discord") or {}
        proactive = disc_cfg.get("proactive") if isinstance(disc_cfg.get("proactive"), dict) else {}
        if proactive.get("enabled", False):
            if not self.proactive_spark.is_running():
                self.proactive_spark.start()
                logger.info(
                    "Спонтанные сообщения (B5): вкл · пауза %s–%s мин между сообщениями · ответ через POST /v1/chat",
                    proactive.get("min_interval_minutes", 10),
                    proactive.get("max_interval_minutes", 30),
                )

    async def setup_hook(self) -> None:
        @self.tree.command(name="reset", description="Сбросить краткую память диалога")
        async def slash_reset(interaction: discord.Interaction):
            uid = ""
            try:
                uid = self.agent._resolve_internal_user_id(
                    str(interaction.user.id),
                    getattr(interaction.user, "display_name", None)
                    or getattr(interaction.user, "name", None),
                )
            except Exception:
                uid = str(interaction.user.id)
            await self.agent.reset_context_async(
                str(interaction.channel_id),
                user_id=uid,
            )
            await interaction.response.send_message("Память сброшена.", ephemeral=True)

        @self.tree.command(name="time", description="Текущие дата и время")
        async def slash_time(interaction: discord.Interaction):
            out = self.agent.tools["get_current_time"].invoke({})
            await interaction.response.send_message(str(out), ephemeral=True)

        @self.tree.command(name="sys", description="Система: CPU, RAM, диск, аптайм")
        @app_commands.describe(metric="Что показать")
        @app_commands.choices(
            metric=[
                Choice(name="uptime", value="uptime"),
                Choice(name="disk", value="disk"),
                Choice(name="memory", value="memory"),
                Choice(name="cpu", value="cpu"),
                Choice(name="python", value="python"),
            ]
        )
        async def slash_sys(interaction: discord.Interaction, metric: str):
            raw = self.agent.tools["check_system"].invoke({"command": metric})
            await interaction.response.send_message(f"```\n{str(raw)[:1900]}\n```", ephemeral=True)

        @self.tree.command(name="web", description="Поиск в интернете")
        @app_commands.describe(query="Запрос")
        async def slash_web(interaction: discord.Interaction, query: str):
            q = (query or "").strip()
            if not q:
                await interaction.response.send_message("Укажи запрос.", ephemeral=True)
                return
            await interaction.response.defer(ephemeral=True)
            raw = self.agent.tools["web_search"].invoke({"query": q[:500]})
            await interaction.followup.send(f"```\n{str(raw)[:1900]}\n```", ephemeral=True)

        @self.tree.command(name="person", description="Досье из PeopleDB")
        @app_commands.describe(name_or_id="Имя или id")
        async def slash_person(interaction: discord.Interaction, name_or_id: str):
            key = (name_or_id or "").strip()
            if not key:
                await interaction.response.send_message("Укажи имя или id.", ephemeral=True)
                return
            raw = self.agent.tools["get_person_info"].invoke({"name_or_id": key[:120]})
            await interaction.response.send_message(f"```\n{str(raw)[:1900]}\n```", ephemeral=True)

        @self.tree.command(name="stats", description="Статистика агента и системы")
        async def slash_stats(interaction: discord.Interaction):
            import psutil

            s = self.agent.get_stats()
            cpu = psutil.cpu_percent(interval=None)
            mem = psutil.virtual_memory()
            tm = s.get("talk_model") or s.get("model")
            bm = s.get("brain_model")
            mm = s.get("memory_model")
            model_lines = [f"Talk: {tm}"]
            if bm:
                model_lines.append(f"Brain: {bm}")
            if mm:
                model_lines.append(f"Memory: {mm}")
            lines = [
                "**Статистика**",
                f"Режим: {s['mode'].upper()}",
                *model_lines,
                f"Память диалога: {s['short_memory_size']} сообщений",
                f"RAG: {s['long_memory_records']} записей",
                f"Людей в БД: {s.get('people_db_records', 0)}",
                "",
                f"CPU: {cpu}%",
                f"ОЗУ: {mem.percent}% ({mem.used // 1024**2} МБ / {mem.total // 1024**2} МБ)",
            ]
            await interaction.response.send_message("\n".join(lines), ephemeral=True)

        @self.tree.command(name="journal", description="Дневник рефлексии за 7 дней")
        async def slash_journal(interaction: discord.Interaction):
            if not self.reflection:
                await interaction.response.send_message("Рефлексия отключена.", ephemeral=True)
                return
            journal = self.reflection.get_recent_journal(7) or "*Пусто*"
            await interaction.response.send_message(
                f"**Дневник (7 дней)**\n```\n{str(journal)[:1800]}\n```", ephemeral=True
            )

        @self.tree.command(name="diary", description="Личный дневник Нейры")
        @app_commands.describe(limit="Сколько записей показать (1-30)")
        async def slash_diary(interaction: discord.Interaction, limit: app_commands.Range[int, 1, 30] = 12):
            body = self.agent.get_recent_diary(int(limit))
            await interaction.response.send_message(
                f"**Личный дневник Нейры**\n```\n{str(body)[:1800]}\n```",
                ephemeral=True,
            )

        @self.tree.command(name="diary_add", description="Добавить запись в личный дневник Нейры")
        @app_commands.describe(text="Текст заметки")
        async def slash_diary_add(interaction: discord.Interaction, text: str):
            note = (text or "").strip()
            if not note:
                await interaction.response.send_message("Пустая запись.", ephemeral=True)
                return
            ok = self.agent.add_diary_entry(
                note,
                source="manual_discord",
                meta={"author": interaction.user.name, "channel_id": int(interaction.channel_id)},
            )
            await interaction.response.send_message(
                "Записала в личный дневник." if ok else "Не смогла записать в дневник.",
                ephemeral=True,
            )

        @self.tree.command(name="reflect", description="Запустить рефлексию вручную")
        async def slash_reflect(interaction: discord.Interaction):
            if not self.reflection:
                await interaction.response.send_message("Рефлексия отключена.", ephemeral=True)
                return
            await interaction.response.defer(ephemeral=True)
            summary = await self.reflection.reflect(force=True)
            await interaction.followup.send(
                f"**Рефлексия**\n```\n{str(summary)[:1900]}\n```" if summary else "Нечего рефлексировать."
            )

        @self.tree.command(name="search", description="Поиск по долгосрочной памяти (RAG)")
        @app_commands.describe(query="Текст поиска")
        async def slash_search(interaction: discord.Interaction, query: str):
            q = (query or "").strip()
            if not q:
                await interaction.response.send_message("Введи запрос.", ephemeral=True)
                return
            results = self.agent.long_memory.search(q)
            if not results:
                await interaction.response.send_message("Ничего не нашла.", ephemeral=True)
                return
            text_out = "\n\n".join(r[:300] for r in results)[:1900]
            await interaction.response.send_message(f"**Поиск**\n```\n{text_out}\n```", ephemeral=True)

        @self.tree.error
        async def on_tree_error(interaction: discord.Interaction, error: app_commands.AppCommandError):
            logger.exception("Slash: %s", error)
            try:
                msg = f"Ошибка команды: {error}"
                if interaction.response.is_done():
                    await interaction.followup.send(msg[:2000], ephemeral=True)
                else:
                    await interaction.response.send_message(msg[:2000], ephemeral=True)
            except Exception:
                pass

        disc = self.config.get("discord", {}) or {}
        raw_gid = disc.get("slash_sync_guild_id")
        if raw_gid is not None and str(raw_gid).strip().lower() not in ("", "null", "none"):
            guild = discord.Object(id=int(raw_gid))
            self.tree.copy_global_to(guild=guild)
            await self.tree.sync(guild=guild)
            logger.info("Slash-команды синхронизированы для гильдии %s", raw_gid)
        else:
            await self.tree.sync()
            logger.info("Slash-команды синхронизированы глобально")

    async def on_message(self, message: discord.Message):
        if message.author.bot:
            return

        mentioned = self.user in message.mentions
        in_active = message.channel.id in self.active_channel_ids
        if self.mention_only:
            if not mentioned:
                return
        else:
            if not mentioned and not in_active:
                return

        user_id = message.author.id
        now = time.monotonic()
        if now - self._last_response.get(user_id, 0.0) < self._cooldown:
            return
        self._last_response[user_id] = now

        vision_imgs = await self._collect_image_attachments(message)
        content = message.content
        for mention in message.mentions:
            content = content.replace(f"<@{mention.id}>", "").replace(f"<@!{mention.id}>", "")
        content = content.strip() or "*молчишь*"
        if vision_imgs and content == "*молчишь*":
            content = "Что на изображении? Коротко по-русски."

        music_candidate = self._candidate_music_intent(content)
        lyrics_hint = _lyrics_request_hint(content)
        soft_music = _soft_music_hint(content)
        play_verb = bool(
            re.search(r"\b(включи|вруби|поставь|заиграй|play)\b", content, flags=re.IGNORECASE)
        )

        # Lyrics first: «текст песни» must not fall into play/search.
        if lyrics_hint and not play_verb:
            route = "GET_LYRICS"
        # Pause/stop/queue/skip — deterministic, no classifier.
        elif music_candidate and str(music_candidate.get("action") or "") != MUSIC_PLAY:
            route = "PLAY_MUSIC"
        elif music_candidate and not lyrics_hint:
            # Hard play triggers ("включи музыку", URL, "в войс") — trust regex.
            route = "PLAY_MUSIC"
        elif music_candidate or lyrics_hint or soft_music:
            route = await self._classify_intent(content)
            if route == "CHAT" and music_candidate and not lyrics_hint:
                route = "PLAY_MUSIC"
            if lyrics_hint and route == "PLAY_MUSIC" and not play_verb:
                route = "GET_LYRICS"
        else:
            route = "CHAT"

        use_music = route == "PLAY_MUSIC" and not lyrics_hint and (
            bool(music_candidate)
            or soft_music
        )

        if use_music:
            if music_candidate and str(music_candidate.get("action") or "") != MUSIC_PLAY:
                resolved = music_candidate
            elif music_candidate:
                resolved = music_candidate
            else:
                # Soft path: classifier said PLAY_MUSIC without hard regex — synthesize play.
                resolved = {
                    "intent": "music_control",
                    "action": MUSIC_PLAY,
                    "query": content.strip()[:180] or "music",
                }
        else:
            resolved = None

        logger.info(
            "Discord route | route=%s use_music=%s soft=%s lyrics=%s candidate=%s query=%r",
            route,
            use_music,
            soft_music,
            lyrics_hint,
            (music_candidate or {}).get("action") if music_candidate else None,
            (resolved or {}).get("query") if resolved else "",
        )

        if resolved:
            request_id = f"{message.id}:{int(time.time() * 1000)}"
            guild_id = str(message.guild.id) if message.guild else ""
            action = str(resolved.get("action") or MUSIC_PLAY)
            query = str(resolved.get("query") or "").strip()
            randomize = action == MUSIC_PLAY and bool(
                re.search(r"\b(любой|рандом|случайн)\b", content, flags=re.IGNORECASE)
            )
            voice_channel_id = ""
            try:
                if message.author.voice and message.author.voice.channel:
                    voice_channel_id = str(message.author.voice.channel.id)
            except Exception:
                voice_channel_id = ""
            payload = {
                "action": action,
                "query": query,
                "requester_id": str(message.author.id),
                "text_channel_id": str(message.channel.id),
                "voice_channel_id": voice_channel_id,
                "guild_id": guild_id,
                "request_id": request_id,
                "idempotency_key": f"{message.id}:{guild_id}:{message.author.id}:{action}",
                "source_message_id": str(message.id),
                "ts": time.time(),
                "randomize": randomize,
                "random_top_k": 5,
                "use_brain": False,
                "join_only": str(resolved.get("join_only") or "") in ("1", "true", "True", "yes"),
            }
            result = await self._publish_music_with_fallback(payload)
            if result.get("ok"):
                mode = str(result.get("mode") or "")
                res_inner = _normalize_music_handler_result(result)
                status = str(res_inner.get("status") or "")
                if status == "failed":
                    err = str(res_inner.get("error") or "unknown error")
                    if "exceeded the timeout" in err.lower() or "unable to connect" in err.lower():
                        err = (
                            f"{err}\n\n"
                            "Не успела зайти в голосовой канал. Проверь: "
                            "права бота Connect/Speak на канал, регион войса, "
                            "что ты уже в войсе — и повтори через пару секунд."
                        )
                    await message.reply(
                        embed=_music_status_embed(
                            "Не получилось",
                            f"Команда не выполнена.\n```{_clip_field(err, 900)}```",
                            color=COL_ERR,
                        ),
                        mention_author=False,
                    )
                    return
                if action == MUSIC_QUEUE:
                    current = str(res_inner.get("current") or "").strip()
                    queue_items = res_inner.get("queue") if isinstance(res_inner.get("queue"), list) else []
                    queue_items = [str(x) for x in queue_items]
                    emb = _queue_page_embed(current, queue_items, 0, QUEUE_PAGE_SIZE)
                    view = QueuePagerView(current, queue_items, author_id=message.author.id, page_size=QUEUE_PAGE_SIZE)
                    await message.reply(embed=emb, view=view, mention_author=False)
                    return
                if mode == "pending":
                    await message.reply(
                        embed=_music_status_embed(
                            "Долго думаю",
                            "Поиск трека или подключение к Lavalink заняли больше обычного. "
                            "Пока обработка идёт в фоне — если ответа не будет, повтори команду через несколько секунд.",
                            color=COL_WARN,
                        ),
                        mention_author=False,
                    )
                    return
                elif action == MUSIC_PLAY:
                    track = str(res_inner.get("track") or "").strip()
                    author = str(res_inner.get("author") or "").strip()
                    candidates = res_inner.get("candidates") if isinstance(res_inner.get("candidates"), list) else []
                    if status == "joined":
                        ch = str(res_inner.get("channel") or "voice").strip()
                        await message.reply(
                            embed=_music_status_embed(
                                "В войсе",
                                f"Зашла в **{ _clip_field(ch, 80) }**. Напиши, что включить.",
                                color=COL_OK,
                            ),
                            mention_author=False,
                        )
                        return
                    if track and author:
                        base = f"**{author}** — **{track}**"
                    else:
                        base = f"**{_clip_field(track or 'неизвестный трек', 500)}**"
                    if status == "queued":
                        title = "В очереди"
                        desc = base
                        col = COL_BRAND
                    elif status in ("started",):
                        title = "Играет"
                        desc = base
                        col = COL_OK
                    else:
                        title = "Музыка"
                        desc = base or "Готово."
                        col = COL_BRAND
                    if candidates:
                        found = "\n".join([f"・ {_clip_field(str(x), 120)}" for x in candidates[:5]])
                        desc += f"\n\n**Варианты поиска:**\n{found}"
                    await message.reply(
                        embed=_music_status_embed(title, _clip_field(desc, 3800), color=col),
                        mention_author=False,
                    )
                    return
                elif action == MUSIC_SKIP:
                    next_title = str(res_inner.get("next") or "").strip()
                    desc = "Текущий трек пропущен."
                    if next_title:
                        desc += f"\n\nДальше: **{_clip_field(next_title, 400)}**"
                    await message.reply(
                        embed=_music_status_embed("Пропуск", desc, color=COL_OK),
                        mention_author=False,
                    )
                    return
                elif action == MUSIC_STOP:
                    await message.reply(
                        embed=_music_status_embed("Стоп", "Воспроизведение остановлено.", color=COL_BRAND),
                        mention_author=False,
                    )
                    return
                elif action == MUSIC_PAUSE:
                    await message.reply(
                        embed=_music_status_embed("Пауза", "Плеер на паузе.", color=COL_WARN),
                        mention_author=False,
                    )
                    return
                elif action == MUSIC_RESUME:
                    await message.reply(
                        embed=_music_status_embed("Продолжить", "Сняла с паузы.", color=COL_OK),
                        mention_author=False,
                    )
                    return
                elif action == MUSIC_CLEAR:
                    await message.reply(
                        embed=_music_status_embed("Очередь", "Очередь очищена.", color=COL_BRAND),
                        mention_author=False,
                    )
                    return
                else:
                    await message.reply(
                        embed=_music_status_embed("Музыка", "Команда выполнена.", color=COL_OK),
                        mention_author=False,
                    )
                    return
            else:
                fail = str(result.get("error") or "").strip()
                if not fail:
                    inner = _normalize_music_handler_result(result)
                    fail = str(inner.get("error") or inner.get("status") or "unknown error")
                await message.reply(
                    embed=_music_status_embed(
                        "Музыка недоступна",
                        f"```{_clip_field(fail, 900)}```",
                        color=COL_ERR,
                    ),
                    mention_author=False,
                )
            return

        chat_content = content
        if route == "GET_LYRICS":
            chat_content = self._build_lyrics_chat_content(content, message.guild)

        author_display = (
            getattr(message.author, "display_name", None)
            or getattr(message.author, "global_name", None)
            or message.author.name
        )
        asyncio.create_task(
            self._run_chat_stream(
                text_channel=message.channel,
                starter_message=message,
                content=chat_content,
                username=message.author.name,
                author_display_name=str(author_display).strip() or message.author.name,
                discord_user_id=str(message.author.id),
                channel_id_str=str(message.channel.id),
                vision_images=vision_imgs if vision_imgs else None,
                lyrics_mode=(route == "GET_LYRICS"),
            )
        )

    async def _collect_image_attachments(self, message: discord.Message) -> list[tuple[str, str]]:
        from core.voice.vision_util import prepare_image_for_vision, resolve_discord_image_mime

        from core.llm.profile import merged_vision_pipeline

        vis = merged_vision_pipeline(self.config)
        if not vis.get("enabled"):
            return []
        max_n = int(vis.get("max_images_per_message", 4))
        max_b = int(vis.get("max_image_bytes", 5_242_880))
        max_w = int(vis.get("max_image_width", 1280))
        max_h = int(vis.get("max_image_height", 720))
        loop = asyncio.get_running_loop()
        out: list[tuple[str, str]] = []
        for att in message.attachments:
            if len(out) >= max_n:
                break
            ct = resolve_discord_image_mime(att.content_type, att.filename or "")
            if not ct:
                continue
            if att.size and att.size > max_b:
                continue
            try:
                data = await att.read()
            except Exception:
                continue
            if len(data) > max_b:
                continue
            data, ct = await loop.run_in_executor(
                None,
                functools.partial(prepare_image_for_vision, data, ct, max_w, max_h),
            )
            b64 = base64.standard_b64encode(data).decode("ascii")
            out.append((ct, b64))
        return out

    async def _run_chat_stream(
        self,
        *,
        text_channel: discord.TextChannel,
        starter_message: Optional[discord.Message],
        content: str,
        username: str,
        author_display_name: str,
        discord_user_id: str,
        channel_id_str: str,
        vision_images: Optional[list[tuple[str, str]]],
        lyrics_mode: bool = False,
    ) -> None:
        async with text_channel.typing():
            response_msg = (
                await starter_message.reply(THINKING_DOT, mention_author=False)
                if starter_message
                else await text_channel.send(THINKING_DOT)
            )
            full_raw = ""
            last_edit = asyncio.get_event_loop().time()
            done_data: dict = {}
            output_mode = self._resolve_stream_output_mode()

            try:
                async for chunk in self.agent.chat_stream(
                    content,
                    username=username,
                    discord_user_id=discord_user_id,
                    vision_images=vision_images,
                    channel_id=channel_id_str,
                    author_display_name=author_display_name,
                ):
                    if chunk["type"] == "token":
                        full_raw += chunk["text"]
                        if output_mode == "final_only":
                            continue
                        now = asyncio.get_event_loop().time()
                        if now - last_edit >= self.stream_edit_interval:
                            preview = self._make_preview(full_raw, lyrics_mode=lyrics_mode)
                            try:
                                await response_msg.edit(content=preview + THINKING_DOT)
                                last_edit = now
                            except discord.HTTPException:
                                pass
                    elif chunk["type"] == "done":
                        done_data = chunk
                    elif chunk["type"] == "error":
                        err = chunk.get("text", "")
                        await response_msg.edit(content=f"⚠️ {err or 'ошибка генерации'}")
                        return

                final_text = done_data.get("text", full_raw).strip() or "*(пустой ответ)*"
                if lyrics_mode:
                    final_text = (
                        final_text.replace("\\r\\n", "\n").replace("\\n", "\n").replace("\\r", "\n")
                    )
                if lyrics_mode:
                    parts = chunk_codeblock_message(final_text, limit=1900)
                else:
                    parts = chunk_message(final_text, limit=1900)
                await response_msg.edit(content=parts[0])
                sent_ids: list[int] = [response_msg.id]
                for chunk in parts[1:]:
                    sent = await text_channel.send(chunk)
                    sent_ids.append(sent.id)
                internal_uid = (
                    self.agent.identity.resolve_from_discord(discord_user_id)
                    or self.agent.identity.resolve_console(username)
                )
                self.agent.event_bus.publish(
                    CoreEvent(
                        NOTIFY_DISCORD_MESSAGE_SENT,
                        "interfaces.discord",
                        {
                            "user_id": internal_uid,
                            "channel_id": channel_id_str,
                            "message_ids": sent_ids,
                            "parts": len(parts),
                        },
                    )
                )
            except Exception as e:
                logger.exception("Ошибка в _run_chat_stream: %s", e)
                try:
                    await response_msg.edit(content=f"⚠️ Что-то сломалось: {e}")
                except Exception:
                    pass

    def _make_preview(self, raw: str, *, lyrics_mode: bool = False) -> str:
        text = re.sub(
            r"<(?:redacted_thinking|think|thought)>.*?</(?:redacted_thinking|think|thought)>",
            "",
            raw,
            flags=re.DOTALL | re.IGNORECASE,
        )
        text = re.sub(r"<(?:redacted_thinking|think|thought)>.*", "", text, flags=re.DOTALL | re.IGNORECASE)
        text = re.sub(r"</?(?:redacted_thinking|think|thought)>", "", text, flags=re.IGNORECASE)
        if lyrics_mode:
            # Models sometimes emit the two-char sequence \n instead of real newlines.
            text = text.replace("\\r\\n", "\n").replace("\\n", "\n").replace("\\r", "\n")
        if not lyrics_mode:
            text = re.sub(r"\[[^\]]*\]", "", text).strip()
        else:
            text = text.strip()
        if len(text) > MAX_MSG_LEN - 10:
            text = text[: MAX_MSG_LEN - 10]
        return text

    def _resolve_stream_output_mode(self) -> str:
        return "final_only" if self.stream_output_mode == "final_only" else "stream"


def run_discord_bot(agent: "NeyraAgent", config: dict) -> None:
    disc_cfg = config.get("discord", {})
    token = (os.environ.get("DISCORD_TOKEN") or "").strip() or (disc_cfg.get("token") or "").strip()
    if not token:
        raise ValueError("Задайте DISCORD_TOKEN в .env (или legacy discord.token в конфиге)")

    from core.reflection import ReflectionEngine

    bot = NeyraDiscordBot(agent, config, reflection=ReflectionEngine(config, agent))
    logger.info("Запускаю Discord-бот (текст + музыка)...")
    bot.run(token, log_handler=None)
