"""Build talk-lane system prompt + message list from TurnPrep."""

from __future__ import annotations

from typing import Any, Optional

from core.agent.turn_prep import TurnPrep


def build_talk_system_prompt(
    agent: Any,
    prep: TurnPrep,
    *,
    brain_context: str,
    mcp_catalog: Optional[str] = None,
    shrink_people: bool = False,
    drop_extra_context: bool = False,
) -> str:
    caption_ok = (prep.attached_caption or "").strip()
    people_active = prep.people_active
    people_others = prep.people_others
    if shrink_people:
        people_active, people_others = agent._shrink_people_sections(
            people_active, people_others, 500
        )
    return agent._build_system_prompt(
        extra_memories=[] if drop_extra_context else prep.memories,
        people_context_active=people_active,
        people_context_mentioned=people_others,
        diary_context="" if drop_extra_context else prep.diary_ctx,
        username=prep.speaker_label,
        web_context="" if drop_extra_context else prep.web_ctx,
        tool_context="" if drop_extra_context else prep.tool_ctx,
        has_vision_images=prep.has_vis_prompt,
        last_image_context=prep.last_img_ctx,
        lyrics_mode=prep.lyrics_mode,
        mcp_tools_catalog=(
            ""
            if drop_extra_context
            else (mcp_catalog if mcp_catalog is not None else prep.mcp_catalog)
        ),
        brain_router_context=brain_context or "",
        attached_image_caption=caption_ok,
        working_memory_context=prep.wm_snip,
        include_appearance=bool(getattr(prep, "include_appearance", False)),
        pre_context=str(getattr(prep, "pre_context", "") or ""),
    )


def build_talk_messages(
    agent: Any,
    prep: TurnPrep,
    system_prompt: str,
    *,
    user_message: str,
    vision_images: Optional[list],
    with_micro_plan_prefill: bool = True,
) -> list[Any]:
    from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

    messages: list[Any] = [SystemMessage(content=system_prompt)]
    for msg in agent.short_memory.get_history():
        if msg["role"] == "user":
            messages.append(HumanMessage(content=msg["content"]))
        else:
            messages.append(AIMessage(content=msg["content"]))
    messages.append(
        agent._make_human_turn(
            user_message, prep.talk_vm, speaker_label=prep.speaker_label
        )
    )
    if not with_micro_plan_prefill:
        return messages
    return agent._maybe_append_micro_plan_prefill(
        messages,
        has_vision_images=bool(vision_images)
        and not prep.brain_native_vis
        and agent.llm_vision is None,
    )
