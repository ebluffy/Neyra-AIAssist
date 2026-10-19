"""Brain lane: routing summary + optional tool-loop before talk."""

from __future__ import annotations

import json
import logging
from typing import Any, Optional

from core.agent.model_trace import invoke
from core.agent.reply_postprocess import extract_think_blocks
from core.text_resources import message_text, prompt_text

logger = logging.getLogger("neyra.agent.brain_phase")

# User-facing stub when brain is down. Plain text only (no [SOUND:] tags).
BRAIN_DOWN_USER_MESSAGE = message_text("brain.unavailable")


async def run_brain_tool_phase(
    agent: Any,
    *,
    user_message: str,
    speaker_label: str,
    vision_caption: Optional[str],
    vision_images: Optional[list[tuple[str, str]]] = None,
    brain_system: str,
    lyrics_mode: bool,
    discord_context=None,
    context_data: str = "",
) -> str:
    """Run llm_brain tool-loop; return text for talk «brain» section."""
    from langchain_core.messages import AIMessage as LC_AIMessage
    from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage

    parts: list[str] = []
    um = (user_message or "").strip()
    if um:
        parts.append(agent._format_spoken_user_message(um, speaker_label))
    vc = (vision_caption or "").strip()
    if vc and not vision_images:
        parts.append("[VISION SUMMARY]\n" + vc)
    human_content = "\n\n".join(parts) if parts else "(empty message)"
    if lyrics_mode:
        human_content += prompt_text("brain.lyrics_request")

    if vision_images:
        human_msg = agent._make_human_turn(
            um or prompt_text("brain.vision_question"),
            vision_images,
            speaker_label=speaker_label,
        )
        if vc:
            extra = "\n\n[ADDITIONAL VISION CONTEXT]\n" + vc
            if isinstance(human_msg.content, list):
                human_msg.content[0]["text"] = str(human_msg.content[0].get("text", "")) + extra
            else:
                human_msg = HumanMessage(content=str(human_msg.content) + extra)
    else:
        human_msg = HumanMessage(content=human_content)

    from core.agent.discord_context import context_prompt
    messages: list[Any] = [SystemMessage(content=brain_system + "\n\n" + prompt_text("brain.context_policy"))]
    if discord_context is not None:
        messages.append(HumanMessage(content=context_prompt(discord_context)))
    if context_data:
        messages.append(HumanMessage(content=context_data))
    history = [
        {"role": item["role"], "content": str(item.get("content") or "")[:1600]}
        for item in agent.short_memory.get_history()[-12:]
        if item.get("role") in ("user", "assistant")
    ]
    if history:
        messages.append(HumanMessage(content="[RECENT DIALOGUE DATA]\n" + json.dumps(history, ensure_ascii=False)))
    messages.append(human_msg)

    mcp_cfg = agent.config.get("mcp_client") if isinstance(agent.config.get("mcp_client"), dict) else {}
    use_tool_loop = bool(mcp_cfg.get("llm_tool_calls")) and bool(agent.tools)
    max_tool_steps = max(1, int(mcp_cfg.get("llm_tool_max_steps", 4)))

    brain_llm = agent.llm_brain
    if lyrics_mode:
        cap = agent.lyrics_reply_max_tokens
        if agent.brain_max_tokens is not None:
            cap = max(agent.brain_max_tokens, cap)
        brain_llm = agent.llm_brain.bind(max_tokens=cap)

    try:
        if not use_tool_loop:
            response = await invoke(agent, brain_llm, messages, lane="brain", purpose="routing", images=bool(vision_images), invoker=agent._ainvoke_text_with_fallback)
            agent._log_model_route(agent._extract_model_name(response), lane="brain")
            from core.llm.message_content import message_content_to_text

            text = message_content_to_text(
                response.content if hasattr(response, "content") else response
            )
            return extract_think_blocks(text)[0].strip()

        bound = brain_llm.bind_tools(list(agent.tools.values()))
        step = 0
        response = None
        while step < max_tool_steps:
            response = await invoke(agent, bound, messages, lane="brain", purpose="tools", images=bool(vision_images), invoker=agent._ainvoke_text_with_fallback)
            agent._log_model_route(agent._extract_model_name(response), lane="brain")
            tcalls = getattr(response, "tool_calls", None) if isinstance(response, LC_AIMessage) else None
            if not tcalls:
                break
            messages.append(response)
            for tc in tcalls:
                if isinstance(tc, dict):
                    tid = str(tc.get("id") or "")
                    tname = str(tc.get("name") or "")
                    args = tc.get("args") if isinstance(tc.get("args"), dict) else {}
                else:
                    tid = str(getattr(tc, "id", None) or "")
                    tname = str(getattr(tc, "name", None) or "")
                    args = getattr(tc, "args", None) or {}
                    if not isinstance(args, dict):
                        args = {}
                if not tname:
                    continue
                out = await agent._execute_tool(tname, **args)
                messages.append(ToolMessage(content=out, tool_call_id=tid, name=tname))
            step += 1
        if response is not None and getattr(response, "tool_calls", None) and step >= max_tool_steps:
            observed = [message for message in messages if isinstance(message, ToolMessage)]
            return json.dumps({
                "tool_budget_exhausted": True,
                "omitted_results": max(0, len(observed) - 4),
                "results": [
                    {"tool": str(message.name or "")[:200], "result": str(message.content)[:1200],
                     "truncated": len(str(message.content)) > 1200}
                    for message in observed[-4:]
                ],
            }, ensure_ascii=False)
        if response is None:
            response = await invoke(agent, brain_llm, messages, lane="brain", purpose="summary", images=bool(vision_images), invoker=agent._ainvoke_text_with_fallback)
            agent._log_model_route(agent._extract_model_name(response), lane="brain")
        from core.llm.message_content import message_content_to_text

        text = message_content_to_text(
            response.content if hasattr(response, "content") else response
        )
        return extract_think_blocks(text)[0].strip()
    except Exception as e:
        # Brain is required: do not silently continue with talk-only (GLM without Luna).
        logger.error("Brain phase failed (talk will not run): %s", e)
        raise
