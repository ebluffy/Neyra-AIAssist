"""System prompt builders for talk (personality) and brain (router) lanes."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from core.text_resources import prompt_text
from .micro_plan import MicroPlanSettings
from .conversation_modes import conversation_mode_hint


def build_talk_system_prompt(
    *,
    base_prompt: str,
    backend: str,
    micro_plan: MicroPlanSettings,
    extra_memories: list[str] | None = None,
    people_context_active: str = "",
    people_context_mentioned: str = "",
    diary_context: str = "",
    username: str | None = None,
    web_context: str = "",
    tool_context: str = "",
    has_vision_images: bool = False,
    last_image_context: Optional[str] = None,
    lyrics_mode: bool = False,
    mcp_tools_catalog: str = "",
    brain_router_context: str = "",
    attached_image_caption: str = "",
    working_memory_context: str = "",
    pre_context: str = "",
    conversation_mode: str = "default",
) -> str:
    """Assemble talk-lane system prompt. Order: role → active → mentioned → rules → RAG → rest."""
    from core.llm.profile import is_local_openai_compatible_provider

    if is_local_openai_compatible_provider(backend):
        hw_note = prompt_text("talk.endpoint_local")
    else:
        hw_note = prompt_text("talk.endpoint_cloud")

    now = datetime.now()
    time_only = prompt_text("talk.environment", timestamp=now.strftime('%Y-%m-%d %H:%M:%S'))

    sections: list[str] = [base_prompt + hw_note + time_only]
    if (pre_context or "").strip():
        sections.append("\n" + pre_context.strip())

    active_lines: list[str] = []
    if username:
        active_lines.append(prompt_text("talk.speaker_label", username=username))
    if people_context_active:
        active_lines.append(people_context_active.strip())
    if active_lines:
        sections.append(prompt_text("talk.active_speaker_header") + "\n\n".join(active_lines))

    if people_context_mentioned:
        sections.append(prompt_text("talk.mentioned_people", people_context_mentioned=people_context_mentioned.strip()))
    if people_context_active and people_context_mentioned:
        sections.append(prompt_text("talk.dossier_priority"))

    rule_chunks: list[str] = [
        prompt_text("talk.private_reasoning_rule"),
        prompt_text("talk.relevance_rule"),
    ]
    if micro_plan.enabled:
        if micro_plan.mode == "anchor":
            rule_chunks.append(prompt_text("talk.micro_plan_anchor", anchor_prefix=micro_plan.anchor_prefix, anchor_reply=micro_plan.anchor_reply))
        else:
            rule_chunks.append(prompt_text("talk.micro_plan_tags", start=micro_plan.start, end=micro_plan.end))
    sections.append(prompt_text("talk.style_header") + "\n\n".join(rule_chunks))

    if (working_memory_context or "").strip():
        sections.append(prompt_text("talk.working_memory", working_memory_context=working_memory_context.strip()))

    if extra_memories:
        memories_text = "\n".join(f"- {m[:300]}" for m in extra_memories)
        sections.append(prompt_text("talk.memories", memories_text=memories_text))

    if brain_router_context:
        sections.append(prompt_text("talk.brain_facts", brain_router_context=brain_router_context.strip()))

    if diary_context:
        sections.append(prompt_text("talk.diary", diary_context=diary_context))

    if web_context:
        sections.append(prompt_text("talk.web_data", web_context=web_context))

    if tool_context:
        sections.append(prompt_text("talk.tool_results", tool_context=tool_context))

    if mcp_tools_catalog:
        sections.append(prompt_text("talk.mcp_catalog", mcp_tools_catalog=mcp_tools_catalog.strip()))

    if (attached_image_caption or "").strip():
        sections.append(prompt_text("talk.image_caption", attached_image_caption=attached_image_caption.strip()))

    if has_vision_images:
        sections.append(prompt_text("talk.vision_priority"))
    elif last_image_context:
        sections.append(prompt_text("talk.previous_image", last_image_context=last_image_context))

    mode_hint = conversation_mode_hint(conversation_mode)
    if mode_hint:
        sections.append("\n" + mode_hint)

    if lyrics_mode:
        sections.append(prompt_text("talk.lyrics"))

    return "\n".join(sections)


def build_brain_system_prompt(
    *,
    identity_snippet: str = "",
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
    """Compact brain-lane system prompt: tools/facts + optional identity snippet."""
    lines: list[str] = [
        prompt_text("brain.role"),
        prompt_text("brain.no_talk_style"),
        prompt_text("brain.tool_policy"),
        prompt_text("brain.output_contract"),
    ]
    # Legacy identity_snippet is accepted for call compatibility, never injected into brain.
    if (pre_context or "").strip():
        lines.append(pre_context.strip())
    if username:
        lines.append(prompt_text("brain.speaker_label", username=username))
    if people_context_active:
        lines.append(prompt_text("brain.active_speaker_header") + people_context_active.strip())
    if people_context_mentioned:
        lines.append(prompt_text("brain.mentioned_people_header") + people_context_mentioned.strip())
    if (working_memory_context or "").strip():
        lines.append(prompt_text("brain.working_memory_header") + working_memory_context.strip())
    if extra_memories:
        mt = "\n".join(f"- {m[:400]}" for m in extra_memories)
        lines.append(prompt_text("brain.memories_header") + mt)
    if diary_context:
        lines.append(prompt_text("brain.diary_header") + diary_context.strip())
    if web_context:
        lines.append(prompt_text("brain.web_header") + web_context.strip())
    if tool_context:
        lines.append(prompt_text("brain.tool_results_header") + tool_context.strip())
    if last_image_context:
        lines.append(prompt_text("brain.previous_image_header") + last_image_context.strip())
    if mcp_tools_catalog:
        lines.append(
            prompt_text("brain.mcp_header")
            + mcp_tools_catalog.strip()
            + prompt_text("brain.mcp_policy")
        )
    return "\n\n".join(lines)
