"""Build talk-lane system prompt + message list from TurnPrep."""

from __future__ import annotations

import json
from typing import Any, Optional

from core.agent.turn_prep import TurnPrep
from core.text_resources import prompt_text


def build_talk_system_prompt(
    agent: Any,
    prep: TurnPrep,
    *,
    brain_context: str,
    mcp_catalog: Optional[str] = None,
    shrink_people: bool = False,
    drop_extra_context: bool = False,
) -> str:
    prompt = agent._build_system_prompt(
        extra_memories=[],
        people_context_active="",
        people_context_mentioned="",
        diary_context="",
        username=None,
        web_context="",
        tool_context="",
        has_vision_images=prep.has_vis_prompt,
        last_image_context=None,
        lyrics_mode=prep.lyrics_mode,
        mcp_tools_catalog="",
        brain_router_context="",
        attached_image_caption="",
        working_memory_context="",
        include_appearance=bool(getattr(prep, "include_appearance", False)),
        pre_context="",
    )
    return prompt + prompt_text("talk.context_policy")


def turn_context_data(prep, *, drop_extra_context=False):
    if drop_extra_context:
        return ""
    fields = ("people_active", "people_others", "diary_ctx", "speaker_label", "web_ctx",
              "tool_ctx", "wm_snip", "last_img_ctx", "attached_caption", "pre_context", "mcp_catalog")
    data = {key: str(getattr(prep, key, "") or "")[:3000] for key in fields}
    data["memories"] = [str(item)[:500] for item in getattr(prep, "memories", [])[:8]]
    return "[TURN CONTEXT DATA]\n" + json.dumps(data, ensure_ascii=False)


def build_talk_messages(
    agent: Any,
    prep: TurnPrep,
    system_prompt: str,
    *,
    user_message: str,
    vision_images: Optional[list],
    with_micro_plan_prefill: bool = True,
    drop_extra_context: bool = False,
    brain_context: str = "",
) -> list[Any]:
    from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

    messages: list[Any] = [SystemMessage(content=system_prompt)]
    from core.agent.discord_context import context_prompt
    metadata = "" if drop_extra_context else context_prompt(getattr(prep, "discord_context", None))
    history = agent.short_memory.get_history()
    if metadata:
        messages.append(HumanMessage(content=metadata))
    context = turn_context_data(prep, drop_extra_context=drop_extra_context)
    if context:
        messages.append(HumanMessage(content=context))
    brain = brain_context
    if brain and not drop_extra_context:
        messages.append(HumanMessage(content="[BRAIN FACTS / TOOL RESULTS]\n" + brain[:8000]))
    for msg in history:
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
