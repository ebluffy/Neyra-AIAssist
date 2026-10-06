"""Shared pre-LLM turn context for chat / chat_stream."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Optional

logger = logging.getLogger("neyra.agent.turn_prep")


@dataclass(frozen=True)
class TalkVisionPlan:
    """How talk lane should receive images this turn."""

    talk_can_vl: bool
    need_talk_caption: bool
    talk_vm: Optional[list[tuple[str, str]]]
    has_vis_prompt: bool


def plan_talk_vision(
    vision_images: Optional[list[tuple[str, str]]],
    *,
    brain_native_vis: bool,
    talk_model: str,
    brain_model: str,
    has_vision_llm: bool,
    talk_is_vision_client: bool,
    vision_is_brain_client: bool,
) -> TalkVisionPlan:
    """Decide talk_vm / caption need without calling LLMs (unit-testable)."""
    imgs = vision_images if vision_images else None
    if not imgs:
        return TalkVisionPlan(False, False, None, False)

    talk_m = (talk_model or "").strip().lower()
    brain_m = (brain_model or "").strip().lower()
    talk_can_vl = bool(has_vision_llm) and (
        (bool(talk_m) and bool(brain_m) and talk_m == brain_m) or talk_is_vision_client
    )
    need_talk_caption = bool(has_vision_llm) and (
        (not brain_native_vis and not vision_is_brain_client)
        or (brain_native_vis and not talk_can_vl)
    )

    if brain_native_vis:
        talk_vm = imgs if talk_can_vl else None
        has_vis_prompt = bool(talk_vm)
    else:
        talk_vm = None if has_vision_llm else imgs
        has_vis_prompt = bool(imgs) and not has_vision_llm

    return TalkVisionPlan(talk_can_vl, need_talk_caption, talk_vm, has_vis_prompt)


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
    avatar_url: Optional[str] = None,
) -> TurnPrep:
    """Gather RAG/people/tools/vision inputs and build brain system prompt."""
    internal_uid = agent._resolve_internal_user_id(discord_user_id, username)
    await agent._ensure_mcp()

    try:
        from core.tools.builtins import set_turn_memory_scope

        set_turn_memory_scope(user_id=internal_uid, channel_id=channel_id or "")
    except Exception:
        pass

    # Account-first person card (create/bind on first contact)
    if getattr(agent, "memory_hub", None) is not None and discord_user_id:
        try:
            agent.memory_hub.ensure_person_for_account(
                platform="discord",
                platform_user_id=str(discord_user_id).strip(),
                handle=(username or "").strip() or None,
                display_name=(author_display_name or "").strip() or None,
                avatar_url=(avatar_url or "").strip() or None,
            )
        except Exception as e:
            logger.debug("ensure_person_for_account: %s", e)

    # User-scoped RAG (shared knowledge types still included inside search)
    if getattr(agent, "memory_hub", None) is not None:
        memories = agent.memory_hub.search_semantic(user_message, user_id=internal_uid)
    else:
        memories = agent.long_memory.search(user_message, user_id=internal_uid)
    mentioned = agent._detect_mentioned_names(user_message)
    if username or discord_user_id:
        person = agent.memory_hub.find_person(username or "", discord_id=discord_user_id)
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
    vplan = plan_talk_vision(
        vision_images,
        brain_native_vis=brain_native_vis,
        talk_model=str(getattr(agent, "llm_talk_model", "") or ""),
        brain_model=str(getattr(agent, "llm_brain_model", "") or ""),
        has_vision_llm=agent.llm_vision is not None,
        talk_is_vision_client=agent.llm_talk is agent.llm_vision,
        vision_is_brain_client=agent.llm_vision is agent.llm_brain,
    )
    if vplan.need_talk_caption:
        try:
            attached_caption = await agent._caption_vision_images(
                user_message, vision_images, speaker_label=speaker_label
            )
        except Exception as e:
            logger.warning("VL caption (%s): ошибка — %s", log_lane, e)
    elif vision_images and not agent.llm_vision:
        logger.warning(
            "Изображения в сообщении (%s), но vision/VL не настроено — ответ только по тексту.",
            log_lane,
        )

    caption_ok = (attached_caption or "").strip()
    talk_vm = vplan.talk_vm
    has_vis_prompt = bool(vplan.has_vis_prompt) and not caption_ok

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
