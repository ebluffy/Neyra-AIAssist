"""Shared pre-LLM turn context for chat / chat_stream."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Optional

logger = logging.getLogger("neyra.agent.turn_prep")


@dataclass
class TurnPrep:
    internal_uid: str
    memories: list
    mentioned: list[str]
    saved_facts: list[str]
    people_active: str
    people_others: str
    diary_ctx: str
    web_ctx: str
    tool_ctx: str
    speaker_label: str
    wm_snip: str
    has_vis: bool
    last_img_ctx: Optional[str]
    lyrics_mode: bool
    mcp_catalog: str
    brain_native_vis: bool
    attached_caption: str
    talk_vm: Optional[list[tuple[str, str]]]
    has_vis_prompt: bool
    include_appearance: bool
    pre_context: str
    brain_sys: str


async def prepare_turn(
    agent: Any,
    *,
    user_message: str,
    username: Optional[str],
    discord_user_id: Optional[str],
    vision_images: Optional[list[tuple[str, str]]],
    channel_id: Optional[str],
    author_display_name: Optional[str],
    lyrics_marker: str,
    log_lane: str = "chat",
) -> TurnPrep:
    """Gather RAG/people/tools/vision inputs and build brain system prompt."""
    internal_uid = agent._resolve_internal_user_id(discord_user_id, username)
    await agent._ensure_mcp()

    try:
        from core.tools.builtins import set_turn_memory_scope

        set_turn_memory_scope(user_id=internal_uid, channel_id=channel_id or "")
    except Exception:
        pass

    # User-scoped RAG (shared knowledge types still included inside search)
    if getattr(agent, "memory_hub", None) is not None:
        memories = agent.memory_hub.search_semantic(user_message, user_id=internal_uid)
    else:
        memories = agent.long_memory.search(user_message, user_id=internal_uid)
    mentioned = agent._detect_mentioned_names(user_message)
    if username:
        person = agent.memory_hub.find_person(username, discord_id=discord_user_id)
        if person and person["id"] not in mentioned:
            mentioned.append(person["id"])

    saved_facts = agent._handle_memory_trigger(user_message, mentioned, username)
    people_active, people_others = agent._split_people_context_for_prompt(
        mentioned, username, discord_user_id
    )
    diary_ctx = agent.memory_hub.diary_recent_text(limit=6)
    web_ctx = agent._handle_websearch_trigger(user_message)
    tool_ctx = agent._collect_tool_context(user_message)
    speaker_label = agent._resolve_speaker_label(username, discord_user_id, author_display_name)
    wm_snip = agent._read_working_memory_for_prompt(internal_uid)

    has_vis = bool(vision_images)
    last_img_ctx = agent._last_image_context_for_prompt(channel_id, vision_images)
    lyrics_mode = lyrics_marker in (user_message or "")

    mcp_cfg = agent.config.get("mcp_client") if isinstance(agent.config.get("mcp_client"), dict) else {}
    mcp_catalog = ""
    if mcp_cfg.get("inject_tool_catalog") and agent.mcp_manager:
        ml = agent.mcp_manager.catalog_lines()
        if ml:
            mcp_catalog = "\n".join(ml)

    brain_native_vis = bool(vision_images) and agent._uses_brain_native_vision()
    attached_caption = ""
    if vision_images and not brain_native_vis and agent.llm_vision and agent.llm_vision is not agent.llm_brain:
        try:
            attached_caption = await agent._caption_vision_images(
                user_message, vision_images, speaker_label=speaker_label
            )
        except Exception as e:
            logger.warning("VL caption (%s): ошибка — %s", log_lane, e)
    elif vision_images and not brain_native_vis and not agent.llm_vision:
        logger.warning(
            "Изображения в сообщении (%s), но vision/VL не настроено — ответ только по тексту.",
            log_lane,
        )

    caption_ok = (attached_caption or "").strip()
    if brain_native_vis:
        talk_vm = None
        has_vis_prompt = False
    else:
        talk_vm = None if (vision_images and agent.llm_vision) else vision_images
        has_vis_prompt = bool(vision_images) and not caption_ok and agent.llm_vision is None

    from core.agent.persona import should_inject_appearance
    from core.agent.pre_context import build_pre_context, lane_wants_pre_context

    include_appearance = should_inject_appearance(
        agent.config,
        user_message=user_message,
        has_vision_images=bool(vision_images),
    )

    pre_context = build_pre_context(
        agent,
        internal_user_id=internal_uid,
        user_message=user_message,
    )
    if pre_context:
        logger.debug(
            "PRE-CONTEXT собран (%s chars) lane=%s",
            len(pre_context),
            "on",
        )

    brain_sys = agent._build_brain_system_prompt(
        extra_memories=memories,
        people_context_active=people_active,
        people_context_mentioned=people_others,
        diary_context=diary_ctx,
        username=speaker_label,
        web_context=web_ctx,
        tool_context=tool_ctx,
        mcp_tools_catalog=mcp_catalog,
        last_image_context=last_img_ctx,
        working_memory_context=wm_snip,
        pre_context=pre_context if lane_wants_pre_context(agent.config, "brain") else "",
    )

    return TurnPrep(
        internal_uid=internal_uid,
        memories=memories,
        mentioned=mentioned,
        saved_facts=saved_facts,
        people_active=people_active,
        people_others=people_others,
        diary_ctx=diary_ctx,
        web_ctx=web_ctx,
        tool_ctx=tool_ctx,
        speaker_label=speaker_label,
        wm_snip=wm_snip,
        has_vis=has_vis,
        last_img_ctx=last_img_ctx,
        lyrics_mode=lyrics_mode,
        mcp_catalog=mcp_catalog,
        brain_native_vis=brain_native_vis,
        attached_caption=attached_caption,
        talk_vm=talk_vm,
        has_vis_prompt=has_vis_prompt,
        include_appearance=include_appearance,
        pre_context=pre_context if lane_wants_pre_context(agent.config, "talk") else "",
        brain_sys=brain_sys,
    )
