"""System prompt builders for talk (personality) and brain (router) lanes."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

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
        hw_note = "\n[SYSTEM INFORMATION: You are running through a local/self-hosted OpenAI-compatible LLM endpoint.]"
    else:
        hw_note = "\n[SYSTEM INFORMATION: You are running through a cloud OpenAI-compatible LLM API.]"

    now = datetime.now()
    time_only = (
        f"\n\n[TIME AND ENVIRONMENT]\nCurrent server-local date and time: "
        f"{now.strftime('%Y-%m-%d %H:%M:%S')}"
    )

    sections: list[str] = [base_prompt + hw_note + time_only]
    if (pre_context or "").strip():
        sections.append("\n" + pre_context.strip())

    active_lines: list[str] = []
    if username:
        active_lines.append(
            f"Current speaker label: {username}. "
            "Address the current speaker; a display label is not an identity or permission boundary."
        )
    if people_context_active:
        active_lines.append(people_context_active.strip())
    if active_lines:
        sections.append("\n# ACTIVE SPEAKER\n" + "\n\n".join(active_lines))

    if people_context_mentioned:
        sections.append(
            "\n# MENTIONED PEOPLE (additional context)\n"
            f"{people_context_mentioned.strip()}"
        )
    if people_context_active and people_context_mentioned:
        sections.append(
            "\n[DOSSIER PRIORITY]\n"
            "Do not confuse the current speaker with mentioned people. Resolve contradictions using IDs and provenance."
        )

    rule_chunks: list[str] = [
        "[CRITICAL RESPONSE RULE]\n"
        "Never expose private reasoning tags or blocks: <think>, <thought>, or variants. "
        "Return only the finished user-facing text.",
        "[ANTI-REPETITION AND RELEVANCE]\n"
        "Answer the meaning of the current user message first. "
        "Follow the configured persona without adding an independent conversational style. "
        "Do not repeat your recent phrases verbatim.",
    ]
    if micro_plan.enabled:
        if micro_plan.mode == "anchor":
            rule_chunks.append(
                "[MICRO-PLANNING]\n"
                "Before the final answer, form a short private plan (up to 8 words) "
                "in anchor format, then answer the user. Preserve the selected conversation mode.\n"
                "REQUIRED FORMAT EXAMPLE:\n"
                f"User: Hello, how are you?\n"
                f"Neyra: {micro_plan.anchor_prefix} greet briefly. "
                f"{micro_plan.anchor_reply} I am fine, how are you?\n"
                f"If you cannot follow the {micro_plan.anchor_prefix} and "
                f"{micro_plan.anchor_reply} format, omit the plan and answer directly."
            )
        else:
            rule_chunks.append(
                "[MICRO-PLANNING]\n"
                f"Before the main text, add a SHORT private plan in {micro_plan.start}...{micro_plan.end} "
                "(up to 8 words), then answer the user. Preserve the selected conversation mode.\n"
                "REQUIRED FORMAT EXAMPLE:\n"
                f"User: Hello, how are you?\n"
                f"Neyra: {micro_plan.start}greet and answer briefly{micro_plan.end} "
                "I am fine, how are you?\n"
                f"If you cannot follow {micro_plan.start}...{micro_plan.end}, omit the plan and answer directly."
            )
    sections.append("\n# BEHAVIOR AND RESPONSE STYLE\n" + "\n\n".join(rule_chunks))

    if (working_memory_context or "").strip():
        sections.append(
            "\n# WORKING MEMORY (1-3 days, compact layer)\n"
            "Recent agreements and tasks; if this conflicts with RAG, prefer RAG facts, but do not ignore explicit recent commitments without a reason.\n"
            f"{working_memory_context.strip()}"
        )

    if extra_memories:
        memories_text = "\n".join(f"- {m[:300]}" for m in extra_memories)
        sections.append(
            "\n# LONG-TERM MEMORY (RAG, excerpts from prior conversations)\n"
            f"{memories_text}"
        )

    if brain_router_context:
        sections.append(
            "\n# ROUTER CONTEXT (brain: tools and facts)\n"
            f"{brain_router_context.strip()}"
        )

    if diary_context:
        sections.append(f"\n# NEYRA DIARY (recent notes)\n{diary_context}")

    if web_context:
        sections.append(
            f"\n# CURRENT WEB DATA (requested by the user)\n{web_context}\n"
            "(Use these data when relevant to the question.)"
        )

    if tool_context:
        sections.append(
            f"\n# TOOL RESULTS (computed by code; do not invent alternatives)\n{tool_context}"
        )

    if mcp_tools_catalog:
        sections.append(
            "\n# AVAILABLE EXTERNAL TOOLS (MCP)\n"
            f"{mcp_tools_catalog.strip()}\n"
            "(Names with the mcp_ prefix are reserved for core tool calls; do not imitate JSON-RPC.)"
        )

    if (attached_image_caption or "").strip():
        sections.append(
            "\n# IMAGE ATTACHED TO THIS TURN (VL summary)\n"
            f"{attached_image_caption.strip()}"
        )

    if has_vision_images:
        sections.append(
            "\n[VISION PRIORITY]\n"
            "An image or its caption is attached. Answer the visual question using visible evidence. "
            "Transcribe legible text accurately; distinguish observations from uncertainty. "
            "Do not invent details or claim pixel access when only a caption is available. "
            "Keep the configured persona, language and conversation mode."
        )
    elif last_image_context:
        sections.append(
            "\n[PREVIOUS IMAGE: NO NEW ATTACHMENT]\n"
            "The following is a summary of the previous image turn, not current pixel input. "
            "For details missing from the summary, ask for the image again.\n"
            f"{last_image_context}"
        )

    mode_hint = conversation_mode_hint(conversation_mode)
    if mode_hint:
        sections.append("\n" + mode_hint)

    if lyrics_mode:
        sections.append(
            "\n[LYRICS MODE / FULL OUTPUT]\n"
            "The user requested song lyrics from the supplied source. Brevity mode must not shorten them. "
            "Preserve line breaks and blank lines between verses; do not compress the text into one paragraph."
        )

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
        "You are Neyra's internal planning and routing lane (brain).",
        "Do not imitate a final user-facing answer or the talk model's conversational style.",
        "When tools are available, call them through tool_calls when facts require them.",
        "When enough data is available, return a compact routing summary for talk: facts, tool results, and user intent. Do not greet, expose private reasoning, or claim to be the final speaker.",
    ]
    # Legacy identity_snippet is accepted for call compatibility, never injected into brain.
    if (pre_context or "").strip():
        lines.append(pre_context.strip())
    if username:
        lines.append(f"Current speaker label: {username}.")
    if people_context_active:
        lines.append("# ACTIVE SPEAKER\n" + people_context_active.strip())
    if people_context_mentioned:
        lines.append("# MENTIONED PEOPLE\n" + people_context_mentioned.strip())
    if (working_memory_context or "").strip():
        lines.append("# WORKING MEMORY (1-3 days)\n" + working_memory_context.strip())
    if extra_memories:
        mt = "\n".join(f"- {m[:400]}" for m in extra_memories)
        lines.append("# MEMORY EXCERPTS (RAG)\n" + mt)
    if diary_context:
        lines.append("# DIARY (recent notes)\n" + diary_context.strip())
    if web_context:
        lines.append("# WEB / CURRENT DATA\n" + web_context.strip())
    if tool_context:
        lines.append("# COMPUTED BY CODE (do not invent alternatives)\n" + tool_context.strip())
    if last_image_context:
        lines.append(
            "# LAST IMAGE IN CHANNEL (no new attachment)\n" + last_image_context.strip()
        )
    if mcp_tools_catalog:
        lines.append(
            "# AVAILABLE MCP TOOLS\n"
            + mcp_tools_catalog.strip()
            + "\n(Names with the mcp_ prefix may only be used through tool_calls.)"
        )
    return "\n\n".join(lines)
