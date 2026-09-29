"""
core.neyra — главный оркестратор агента Нейры (единственный top-level модуль в core/).

Использует LangChain + OpenAI-compatible LLM.
Подсистемы: STM / Hub memory / PeopleDB / Tools / Event Bus.
Хелперы — пакет ``core.agent`` (фаза 1R).
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Optional

import core.agent.micro_plan as _micro_plan
from core.agent.reply_postprocess import (
    EMPTY_REPLY_PLACEHOLDER,
    ensure_nonempty_reply,
    extract_sound_tags,
    extract_think_blocks,
)
from core.runtime.event_bus import EventBus
from core.runtime.identity import UnifiedIdentityMapper

logger = logging.getLogger("neyra.agent")

from core.agent.llm_setup import DEPRECATED_OPENROUTER_MODELS

# Маркер скрытого суффикса Discord GET_LYRICS — включает сохранение переносов строк и больший max_tokens.
LYRICS_REQUEST_MARKER = "[SYSTEM HIDDEN INSTRUCTION: User wants lyrics"


class NeyraAgent:
    """Основной агент Нейры.

    This class orchestrates LLM calls, memory subsystems, tools, and event
    publishing for all runtime interfaces (console, API, Discord plugin).

    Args:
        config: Merged runtime configuration dictionary.
    """

    def __init__(self, config: dict):
        self.config = config
        # Legacy MODE больше не основной; оставляем для обратной совместимости.
        self.mode = str(config.get("MODE") or config.get("BACKEND", "openrouter")).lower()
        # Ключ: discord channel_id → текст заметки после последнего VL-хода (пока процесс жив)
        self._last_vision_note_by_channel: dict[str, str] = {}

        self.event_bus = EventBus()
        self.identity = UnifiedIdentityMapper()

        self._setup_llm()
        self._setup_memory()
        self._setup_tools()
        self._setup_logs()
        self._project_root = Path(__file__).resolve().parents[1]
        self._wm_turns_since_refresh = 0
        self._wm_last_refresh_mono = 0.0
        self._emotion_last_mono = 0.0
        logger.info(f"NeyraAgent инициализирован | mode={self.mode}")

    # ─── Инициализация ─────────────────────────────────────────────────────

    def _setup_llm(self):
        """OpenAI-compatible LLM (OpenRouter, Ollama, Groq, …) — см. core.llm.profile."""
        from core.agent.llm_setup import setup_llm_connection

        setup_llm_connection(self)

    def _setup_openai_compatible_llm(self):
        """Единый путь: ChatOpenAI к base_url с api_key из профиля провайдера."""
        from core.agent.llm_setup import setup_openai_compatible_llm

        setup_openai_compatible_llm(self)

    def _vision_pipeline_cfg(self) -> dict[str, Any]:
        """Единый контур vision: openrouter.vision_model (см. core.llm.profile.merged_vision_pipeline)."""
        from core.llm.profile import merged_vision_pipeline

        return merged_vision_pipeline(self.config)

    def _uses_brain_native_vision(self) -> bool:
        return bool(self._vision_pipeline_cfg().get("use_brain_model_for_vision"))

    def _setup_memory(self):
        """Инициализирует все модули памяти."""
        from core.agent.bootstrap import setup_memory

        setup_memory(self)


    async def _append_turn_to_chat_log(
        self,
        *,
        user_text: str,
        assistant_text: str,
        internal_user_id: str,
        display_name: Optional[str],
        channel_id: Optional[str],
        source: Optional[str],
        meta: Optional[dict] = None,
        latency_ms: Optional[float] = None,
    ) -> str:
        """Dual-write full turn into SQLite chat_log (Memory Hub). Returns turn_id."""
        from core.agent.chat_log import append_turn_to_chat_log

        asst_cfg = self.config.get("assistant") if isinstance(self.config.get("assistant"), dict) else {}
        assistant_name = str(asst_cfg.get("name") or "").strip() or None
        return await append_turn_to_chat_log(
            self.memory_hub,
            user_text=user_text,
            assistant_text=assistant_text,
            internal_user_id=internal_user_id,
            display_name=display_name,
            channel_id=channel_id,
            source=source,
            assistant_name=assistant_name,
            meta=meta,
            latency_ms=latency_ms,
        )

    def _setup_tools(self):
        """Инициализирует инструменты (вызываются вручную, не через bind_tools)."""
        from core.agent.bootstrap import setup_tools

        setup_tools(self)


    async def start_mcp_clients(self) -> None:
        """Подключить MCP-серверы и добавить динамические tools (идемпотентно)."""
        await self._ensure_mcp()

    async def stop_mcp_clients(self) -> None:
        from core.agent.bootstrap import stop_mcp

        await stop_mcp(self)


    async def _ensure_mcp(self) -> None:
        from core.agent.bootstrap import ensure_mcp

        await ensure_mcp(self)


    def _setup_logs(self):
        """Создаёт директории и файлы для логов."""
        from core.agent.bootstrap import setup_logs

        setup_logs(self)


    def _init_people_db(self):
        """Засеивает базовые досье, только если Hub/PeopleDB ещё пусты (никакого JSON-импорта)."""
        from core.agent.people_seed import seed_default_people

        seed_default_people(self.people_db, getattr(self, "memory_hub", None))

    # ─── Системный промпт ──────────────────────────────────────────────────

    def _build_system_prompt(
        self,
        extra_memories: list[str] = None,
        people_context_active: str = "",
        people_context_mentioned: str = "",
        diary_context: str = "",
        username: str = None,
        web_context: str = "",
        tool_context: str = "",
        has_vision_images: bool = False,
        last_image_context: Optional[str] = None,
        lyrics_mode: bool = False,
        mcp_tools_catalog: str = "",
        brain_router_context: str = "",
        attached_image_caption: str = "",
        working_memory_context: str = "",
        include_appearance: bool = False,
        pre_context: str = "",
    ) -> str:
        """Собирает системный промпт. Порядок (B2): роль → активный → упомянутые → правила → RAG → остальное."""
        from core.agent.persona import build_talk_base_prompt
        from core.agent.prompts import build_talk_system_prompt

        base_prompt = build_talk_base_prompt(
            self.config,
            self._project_root,
            include_appearance=include_appearance,
        )
        return build_talk_system_prompt(
            base_prompt=base_prompt,
            backend=self.backend,
            micro_plan=self._micro_plan_settings(),
            extra_memories=extra_memories,
            people_context_active=people_context_active,
            people_context_mentioned=people_context_mentioned,
            diary_context=diary_context,
            username=username,
            web_context=web_context,
            tool_context=tool_context,
            has_vision_images=has_vision_images,
            last_image_context=last_image_context,
            lyrics_mode=lyrics_mode,
            mcp_tools_catalog=mcp_tools_catalog,
            brain_router_context=brain_router_context,
            attached_image_caption=attached_image_caption,
            working_memory_context=working_memory_context,
            pre_context=pre_context,
        )

    def _build_brain_system_prompt(
        self,
        *,
        extra_memories: Optional[list[str]] = None,
        people_context_active: str = "",
        people_context_mentioned: str = "",
        diary_context: str = "",
        username: Optional[str] = None,
        web_context: str = "",
        tool_context: str = "",
        mcp_tools_catalog: str = "",
        last_image_context: Optional[str] = None,
        working_memory_context: str = "",
        pre_context: str = "",
    ) -> str:
        """Компактный системный промпт для brain: инструменты/факты + короткий identity snippet."""
        from core.agent.persona import persona_brain_snippet
        from core.agent.prompts import build_brain_system_prompt

        return build_brain_system_prompt(
            identity_snippet=persona_brain_snippet(self.config, self._project_root),
            extra_memories=extra_memories,
            people_context_active=people_context_active,
            people_context_mentioned=people_context_mentioned,
            diary_context=diary_context,
            username=username,
            web_context=web_context,
            tool_context=tool_context,
            mcp_tools_catalog=mcp_tools_catalog,
            last_image_context=last_image_context,
            working_memory_context=working_memory_context,
            pre_context=pre_context,
        )

    async def _caption_vision_images(
        self,
        user_message: str,
        vision_images: list[tuple[str, str]],
        *,
        speaker_label: str,
    ) -> str:
        """Краткий текстовый конспект изображений через VL-модель (до brain/talk)."""
        from core.agent.vision_context import caption_vision_images

        return await caption_vision_images(
            self, user_message, vision_images, speaker_label=speaker_label
        )

    async def _run_brain_tool_phase(
        self,
        *,
        user_message: str,
        speaker_label: str,
        vision_caption: Optional[str],
        vision_images: Optional[list[tuple[str, str]]] = None,
        brain_system: str,
        lyrics_mode: bool,
    ) -> str:
        """Маршрутизация и tool-loop на llm_brain; возвращает текст для секции talk «brain»."""
        from core.agent.brain_phase import run_brain_tool_phase

        return await run_brain_tool_phase(
            self,
            user_message=user_message,
            speaker_label=speaker_label,
            vision_caption=vision_caption,
            vision_images=vision_images,
            brain_system=brain_system,
            lyrics_mode=lyrics_mode,
        )

    def _make_vision_memory_note(self, thoughts: str, clean_text: str) -> str:
        """Текст для «памяти последнего скрина»: приоритет — CoT/think из ответа VL."""
        from core.agent.vision_context import make_vision_memory_note

        vis = self._vision_pipeline_cfg()
        return make_vision_memory_note(
            thoughts,
            clean_text,
            max_chars=int(vis.get("last_image_note_max_chars", 1200)),
        )

    def _last_image_context_for_prompt(
        self,
        channel_id: Optional[str],
        vision_images: Optional[list],
    ) -> Optional[str]:
        from core.agent.vision_context import last_image_context_for_prompt

        vis_cfg = self._vision_pipeline_cfg()
        return last_image_context_for_prompt(
            self._last_vision_note_by_channel,
            channel_id,
            vision_images,
            remember_last_image=bool(vis_cfg.get("remember_last_image", True)),
        )

    def _store_vision_note_if_needed(
        self,
        channel_id: Optional[str],
        vision_images: Optional[list],
        thoughts: str,
        clean_text: str,
    ) -> None:
        from core.agent.vision_context import store_vision_note_if_needed

        vis = self._vision_pipeline_cfg()
        store_vision_note_if_needed(
            self._last_vision_note_by_channel,
            channel_id,
            vision_images,
            thoughts,
            clean_text,
            remember_last_image=bool(vis.get("remember_last_image", True)),
            max_chars=int(vis.get("last_image_note_max_chars", 1200)),
        )

    def _resolve_speaker_label(
        self,
        username: Optional[str],
        discord_user_id: Optional[str],
        author_display_name: Optional[str] = None,
    ) -> str:
        """Подпись собеседника для STM, HumanMessage и system prompt (этап B1)."""
        from core.agent.speakers import resolve_speaker_label

        return resolve_speaker_label(
            self.memory_hub, username, discord_user_id, author_display_name
        )

    def _format_spoken_user_message(self, text: str, speaker_label: str) -> str:
        """Префикс авторства реплики в контексте LLM ([Пользователь …]: …)."""
        from core.agent.speakers import format_spoken_user_message

        return format_spoken_user_message(text, speaker_label)

    def _make_human_turn(
        self,
        user_message: str,
        vision_images: Optional[list[tuple[str, str]]] = None,
        *,
        speaker_label: Optional[str] = None,
    ):
        """HumanMessage: текст или мультимодальный контент (mime, base64) для VL."""
        from core.agent.speakers import make_human_turn

        return make_human_turn(
            user_message,
            vision_images,
            speaker_label=speaker_label,
            has_vision_llm=self.llm_vision is not None,
        )

    def _stream_llm(self, vision_images: Optional[list[tuple[str, str]]]):
        """Какой LLM вызывать в этом ходе."""
        if vision_images and self.llm_vision:
            return self.llm_vision
        return self.llm

    def _extract_model_name(self, payload: Any) -> Optional[str]:
        from core.agent.llm_stream import extract_model_name

        return extract_model_name(payload)

    def _log_model_route(self, used_model: Optional[str], *, lane: str = "talk") -> None:
        from core.agent.llm_stream import log_model_route

        log_model_route(self, used_model, lane=lane)


    async def _run_async_reflection(
        self,
        user_message: str,
        assistant_text: str,
        username: Optional[str],
        discord_user_id: Optional[str],
    ) -> None:
        from core.agent.memory_jobs import run_async_reflection

        await run_async_reflection(
            self, user_message, assistant_text, username, discord_user_id
        )

    def _schedule_async_reflection(
        self,
        user_message: str,
        assistant_text: str,
        username: Optional[str],
        discord_user_id: Optional[str],
    ) -> None:
        from core.agent.memory_jobs import schedule_async_reflection

        schedule_async_reflection(
            self, user_message, assistant_text, username, discord_user_id
        )

    def _format_stm_tail(self, max_messages: int = 12) -> str:
        from core.agent.memory_jobs import format_stm_tail

        return format_stm_tail(self.short_memory, max_messages)

    def _read_working_memory_for_prompt(self, internal_user_id: str) -> str:
        return self.memory_hub.working_memory_for_prompt(
            internal_user_id, root=self._project_root
        )

    async def _run_working_memory_refresh(
        self,
        *,
        internal_user_id: str,
        user_message: str,
        assistant_text: str,
        speaker_label: str,
        reason: str,
    ) -> None:
        from core.agent.memory_jobs import run_working_memory_refresh

        await run_working_memory_refresh(
            self,
            internal_user_id=internal_user_id,
            user_message=user_message,
            assistant_text=assistant_text,
            speaker_label=speaker_label,
            reason=reason,
        )

    def _schedule_working_memory_refresh(
        self,
        *,
        internal_user_id: str,
        user_message: str,
        assistant_text: str,
        speaker_label: str,
        stm_trimmed: bool = False,
    ) -> None:
        from core.agent.memory_jobs import schedule_working_memory_refresh

        schedule_working_memory_refresh(
            self,
            internal_user_id=internal_user_id,
            user_message=user_message,
            assistant_text=assistant_text,
            speaker_label=speaker_label,
            stm_trimmed=stm_trimmed,
        )

    async def _save_dialog_to_ltm_with_emotion(
        self,
        user_message: str,
        clean_text: str,
        metadata: dict,
        speaker_label: str,
    ) -> None:
        from core.agent.memory_jobs import save_dialog_to_ltm_with_emotion

        await save_dialog_to_ltm_with_emotion(
            self, user_message, clean_text, metadata, speaker_label
        )

    def _schedule_emotion_diary(
        self,
        *,
        user_message: str,
        assistant_text: str,
        speaker_label: str,
        username: Optional[str],
        discord_user_id: Optional[str],
    ) -> None:
        from core.agent.memory_jobs import schedule_emotion_diary

        schedule_emotion_diary(
            self,
            user_message=user_message,
            assistant_text=assistant_text,
            speaker_label=speaker_label,
            username=username,
            discord_user_id=discord_user_id,
        )

    async def _ainvoke_text_with_fallback(self, messages: list[Any], *, llm=None):
        """Обычный нестриминговый вызов (одна модель)."""
        model = llm or self.llm_talk
        return await model.ainvoke(messages)

    async def _astream_text_with_fallback(self, messages: list[Any], *, llm=None):
        """Стриминговый вызов live-модели с guard по first-token timeout и 1 ретраем."""
        from core.agent.llm_stream import astream_text_with_fallback

        async for chunk in astream_text_with_fallback(self, messages, llm=llm):
            yield chunk


    # ─── Вспомогательные методы ────────────────────────────────────────────

    def _micro_plan_settings(self) -> _micro_plan.MicroPlanSettings:
        return _micro_plan.MicroPlanSettings(
            enabled=bool(self.micro_planning_enabled),
            mode=str(self.micro_plan_mode),
            start=str(self.micro_plan_start),
            end=str(self.micro_plan_end),
            anchor_prefix=str(self.micro_plan_anchor_prefix),
            anchor_reply=str(self.micro_plan_anchor_reply),
            prefill_enabled=bool(self.micro_plan_prefill_enabled),
        )

    def _extract_sound_tags(self, text: str, *, preserve_line_breaks: bool = False) -> tuple[str, list[str]]:
        """Вырезает [SOUND: tag] из текста, возвращает (чистый текст, список тегов)."""
        return extract_sound_tags(text, preserve_line_breaks=preserve_line_breaks)

    def _extract_think_blocks(self, text: str) -> tuple[str, str]:
        """Вырезает <think>/<thought> блоки (модель использует оба варианта)."""
        return extract_think_blocks(text)

    def _ensure_nonempty_reply(
        self,
        text_no_think: str,
        clean_text: str,
        *,
        preserve_line_breaks: bool = False,
    ) -> str:
        """
        Гарантирует, что после пост-очистки ответ не станет пустым.
        Иногда модель уходит в служебные блоки/скобки и после фильтров ничего не остаётся.
        """
        return ensure_nonempty_reply(
            text_no_think,
            clean_text,
            preserve_line_breaks=preserve_line_breaks,
            empty_placeholder=EMPTY_REPLY_PLACEHOLDER,
        )

    async def _retry_short_reply_if_empty(self, messages: list[Any], current_text: str) -> str:
        """Если после очистки ответ пустой, делаем быстрый короткий re-ask одной фразой."""
        from core.agent.reply_pipeline import retry_short_reply_if_empty

        return await retry_short_reply_if_empty(self, messages, current_text)

    def _strip_leading_micro_plan(self, text: str) -> tuple[str, str]:
        """Удаляет ведущий [PLAN]...[/PLAN] (или кастомные теги) из ответа."""
        return _micro_plan.strip_leading(text, self._micro_plan_settings())

    def _init_micro_plan_state(self) -> dict:
        return _micro_plan.init_state()

    def _filter_micro_plan_token(self, token: str, st: dict) -> str:
        """State-machine фильтр: скрывает содержимое между start/end тегами без буферизации всего ответа."""
        return _micro_plan.filter_token(token, st, self._micro_plan_settings())

    def _filter_micro_plan_token_anchor(self, token: str, st: dict) -> str:
        return _micro_plan.filter_token_anchor(token, st, self._micro_plan_settings())

    def _finalize_micro_plan_state(self, st: dict) -> str:
        return _micro_plan.finalize_state(st, self._micro_plan_settings(), self._micro_plan_metrics)

    def _strip_micro_plan_blocks(self, text: str) -> tuple[str, int, bool]:
        """Финальный fail-safe: вырезает все блоки start...end и обрезает незакрытый хвост."""
        return _micro_plan.strip_blocks(text, self._micro_plan_settings())

    def _strip_micro_plan_anchor(self, text: str) -> tuple[str, int, bool]:
        return _micro_plan.strip_anchor(text, self._micro_plan_settings())

    def _maybe_append_micro_plan_prefill(
        self,
        messages: list[Any],
        *,
        has_vision_images: bool,
    ) -> list[Any]:
        return _micro_plan.maybe_append_prefill(
            messages,
            self._micro_plan_settings(),
            has_vision_images=has_vision_images,
        )

    async def _de_repeat_reply(self, user_message: str, clean_text: str) -> str:
        """Если новый ответ почти дублирует предыдущий — быстрый перефраз."""
        from core.agent.de_repeat import de_repeat_reply

        return await de_repeat_reply(
            user_message=user_message,
            clean_text=clean_text,
            short_memory=self.short_memory,
            llm_talk=self.llm_talk,
            lyrics_marker=LYRICS_REQUEST_MARKER,
            extract_think_blocks=self._extract_think_blocks,
            extract_sound_tags=self._extract_sound_tags,
        )

    def _log_thought(self, thought: str, user_msg: str):
        """Пишет внутренний монолог в thoughts.log."""
        from core.agent.file_log import log_thought

        log_thought(self, thought, user_msg)

    def _log_chat(self, user: str, assistant: str, metadata: dict = None):
        """Пишет диалог в chat.log."""
        from core.agent.file_log import log_chat

        log_chat(self, user, assistant, metadata)

    def _detect_mentioned_names(self, text: str) -> list[str]:
        """Определение известных имён/ников с учетом русских окончаний (падежей)."""
        from core.agent.people_context import detect_mentioned_names

        return detect_mentioned_names(text, self.memory_hub.get_all_names_map())

    def _split_people_context_for_prompt(
        self,
        mentioned: list[str],
        username: Optional[str],
        discord_user_id: Optional[str],
    ) -> tuple[str, str]:
        """
        B2: досье текущего пользователя отдельно от прочих упомянутых (без дублирования).
        """
        from core.agent.people_context import split_people_context

        return split_people_context(self.memory_hub, mentioned, username, discord_user_id)

    @staticmethod
    def _shrink_people_sections(active: str, mentioned: str, max_chars: int) -> tuple[str, str]:
        """Ужимает блоки досье при переполнении контекста; приоритет — активный собеседник."""
        from core.agent.people_context import shrink_people_sections

        return shrink_people_sections(active, mentioned, max_chars)

    # ─── Инструменты — ручной вызов ────────────────────────────────────────

    async def _execute_tool(self, tool_name: str, **kwargs) -> str:
        """Выполняет инструмент по имени (встроенный или MCP)."""
        t = self.tools.get(tool_name)
        if not t:
            return f"Инструмент '{tool_name}' не найден"
        try:
            if hasattr(t, "ainvoke"):
                return str(await t.ainvoke(kwargs))
            return str(t.invoke(kwargs))
        except Exception as e:
            logger.error(f"Tool {tool_name} ошибка: {e}")
            return f"Ошибка инструмента: {e}"

    def _collect_tool_context(self, text: str) -> str:
        from core.agent.tool_heuristics import collect_tool_context

        return collect_tool_context(
            self.tools,
            text=text,
            rag_enabled=bool(self.long_memory.rag_enabled),
            detect_mentioned_names=self._detect_mentioned_names,
        )

    def _handle_memory_trigger(self, text: str, mentioned: list[str], username: str) -> list[str]:
        from core.agent.tool_heuristics import handle_memory_trigger

        return handle_memory_trigger(
            people_db=self.people_db,
            memory_hub=self.memory_hub,
            text=text,
            mentioned=mentioned,
            username=username,
        )

    def add_diary_entry(self, text: str, source: str = "manual", meta: Optional[dict] = None) -> bool:
        """Ручная запись в личный дневник Нейры."""
        return self.diary.add_entry(text=text, source=source, meta=meta)

    def get_recent_diary(self, limit: int = 12) -> str:
        return self.memory_hub.diary_recent_text(limit=limit) or "Дневник пока пуст."

    def _handle_websearch_trigger(self, text: str) -> str:
        from core.agent.tool_heuristics import handle_websearch_trigger

        return handle_websearch_trigger(self.tools, text)

    def _resolve_internal_user_id(
        self, discord_user_id: Optional[str], username: Optional[str]
    ) -> str:
        rid = self.identity.resolve_from_discord(discord_user_id)
        if rid:
            return rid
        return self.identity.resolve_console(username)

    def _publish_memory_and_chat_events(
        self,
        *,
        internal_user_id: str,
        channel_id: Optional[str],
        username: Optional[str],
        user_message: str,
        clean_text: str,
        sounds: list,
        metadata: dict,
    ) -> None:
        from core.agent.turn_events import publish_memory_and_chat_events

        publish_memory_and_chat_events(
            self.event_bus,
            internal_user_id=internal_user_id,
            channel_id=channel_id,
            username=username,
            user_message=user_message,
            clean_text=clean_text,
            sounds=sounds,
            metadata=metadata,
            short_memory_len=len(self.short_memory),
            rag_enabled=self.long_memory.rag_enabled,
        )

    def _publish_chat_turn_failed(
        self,
        *,
        internal_user_id: str,
        channel_id: Optional[str],
        error: str,
    ) -> None:
        from core.agent.turn_events import publish_chat_turn_failed

        publish_chat_turn_failed(
            self.event_bus,
            internal_user_id=internal_user_id,
            channel_id=channel_id,
            error=error,
        )

    async def chat(
        self,
        user_message: str,
        username: Optional[str] = None,
        discord_user_id: Optional[str] = None,
        vision_images: Optional[list[tuple[str, str]]] = None,
        channel_id: Optional[str] = None,
        author_display_name: Optional[str] = None,
    ) -> dict:
        """
        Основной метод чата.

        Возвращает:
        {
            "text": str,          — финальный текст ответа (без тегов и think)
            "sounds": list[str],  — список звуковых тегов [SOUND: laugh] → ["laugh"]
            "thoughts": str,      — внутренний монолог (для лога, не показываем)
            "raw": str,           — полный сырой ответ модели
        }
        """
        from core.agent.chat import run_chat

        return await run_chat(
            self,
            user_message=user_message,
            username=username,
            discord_user_id=discord_user_id,
            vision_images=vision_images,
            channel_id=channel_id,
            author_display_name=author_display_name,
            lyrics_marker=LYRICS_REQUEST_MARKER,
        )

    async def chat_stream(
        self,
        user_message: str,
        username: Optional[str] = None,
        discord_user_id: Optional[str] = None,
        vision_images: Optional[list[tuple[str, str]]] = None,
        channel_id: Optional[str] = None,
        author_display_name: Optional[str] = None,
    ):
        """
        Стриминговый чат — yield'ит токены сразу как модель их генерирует.

        Использование:
            async for chunk in agent.chat_stream(msg):
                if chunk["type"] == "token":
                    print(chunk["text"], end="", flush=True)
                elif chunk["type"] == "done":
                    sounds = chunk["sounds"]
        """
        from core.agent.chat_stream import iter_chat_stream

        async for chunk in iter_chat_stream(
            self,
            user_message=user_message,
            username=username,
            discord_user_id=discord_user_id,
            vision_images=vision_images,
            channel_id=channel_id,
            author_display_name=author_display_name,
            lyrics_marker=LYRICS_REQUEST_MARKER,
        ):
            yield chunk

    async def summarize_ltm_corpus(self, combined_dialog_text: str, *, consolidation: bool = False) -> str:
        """
        Сжимает пакет выгружаемых диалогов LTM в короткий digest для последующей записи в RAG.
        Использует reflection-модель с умеренным лимитом токенов (обслуживание памяти, не чат).
        consolidation=True — режим ночной консолидации: слияние дублей, отсечение шума.
        """
        from core.agent.ltm_summarize import summarize_ltm_corpus

        return await summarize_ltm_corpus(
            self, combined_dialog_text, consolidation=consolidation
        )

    def reset_context(self, channel_id: Optional[str] = None):
        """Синхронный сброс STM (без archive). Предпочитай ``reset_context_async``."""
        self.short_memory.clear()
        if channel_id is not None:
            self._last_vision_note_by_channel.pop(str(channel_id), None)
        else:
            self._last_vision_note_by_channel.clear()
        logger.info("Краткосрочная память сброшена")

    async def reset_context_async(
        self,
        channel_id: Optional[str] = None,
        *,
        user_id: str = "",
    ) -> dict:
        """Archive STM (если session_archive.on_manual_reset) затем очистить память.

        Returns the ``archive_session`` result dict (always a dict; soft-fails inside).
        """
        from core.agent.session_archive import archive_session

        arch: dict = {
            "ran": False,
            "reason": "manual_reset",
            "chars": 0,
            "messages": 0,
            "diary_written": False,
            "ltm_digest_written": False,
            "stm_cleared": False,
            "history_source": "",
        }
        try:
            arch = await archive_session(
                self,
                reason="manual_reset",
                user_id=user_id,
                channel_id=channel_id,
                apply_stm_policy=False,
            )
        except Exception as e:
            logger.warning("session_archive on reset failed (soft): %s", e)
        self.reset_context(channel_id)
        return arch if isinstance(arch, dict) else {}

    def get_stats(self) -> dict:
        """Возвращает статистику агента."""
        mcp_info = None
        if self.mcp_manager is not None:
            mcp_info = {
                "configured_servers": len(self.mcp_manager.configured_servers()),
                "connected_servers": self.mcp_manager.connected_servers(),
                "errors": self.mcp_manager.last_errors(),
            }
        from core.memory import emotional_layer as em
        from core.memory import working_memory as wm

        return {
            "mode": self.mode,
            "llm_provider": self.backend,
            "model": self.llm_model,
            "talk_model": getattr(self, "llm_talk_model", self.llm_model),
            "brain_model": getattr(self, "llm_brain_model", None),
            "memory_model": getattr(self, "llm_memory_model", None),
            "short_memory_size": len(self.short_memory),
            "long_memory_records": self.long_memory.count(),
            "people_db_records": len(self.people_db._cache),
            "tools_count": len(self.tools),
            "event_bus": self.event_bus.handler_counts(),
            "mcp": mcp_info,
            "working_memory_enabled": wm.wm_enabled(self.config),
            "emotional_layer_enabled": em.layer_enabled(self.config),
        }
