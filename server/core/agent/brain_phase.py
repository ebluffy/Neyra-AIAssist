"""Brain lane: routing summary + optional tool-loop before talk."""

from __future__ import annotations

import logging
from typing import Any, Optional

logger = logging.getLogger("neyra.agent.brain_phase")


async def run_brain_tool_phase(
    agent: Any,
    *,
    user_message: str,
    speaker_label: str,
    vision_caption: Optional[str],
    vision_images: Optional[list[tuple[str, str]]] = None,
    brain_system: str,
    lyrics_mode: bool,
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
        parts.append("[Конспект изображения VL]\n" + vc)
    human_content = "\n\n".join(parts) if parts else "(пустое сообщение)"
    if lyrics_mode:
        human_content += (
            "\n\n[Оговорка] Пользователь запросил режим текста песни — "
            "учитывай для инструментов/поиска."
        )

    if vision_images:
        human_msg = agent._make_human_turn(
            um or "Что на изображении? Учти контекст для инструментов.",
            vision_images,
            speaker_label=speaker_label,
        )
        if vc:
            extra = "\n\n[Доп. контекст VL]\n" + vc
            if isinstance(human_msg.content, list):
                human_msg.content[0]["text"] = str(human_msg.content[0].get("text", "")) + extra
            else:
                human_msg = HumanMessage(content=str(human_msg.content) + extra)
    else:
        human_msg = HumanMessage(content=human_content)

    messages: list[Any] = [
        SystemMessage(content=brain_system),
        human_msg,
    ]

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
            response = await agent._ainvoke_text_with_fallback(messages, llm=brain_llm)
            agent._log_model_route(agent._extract_model_name(response), lane="brain")
            text = response.content if hasattr(response, "content") else str(response)
            return (text or "").strip()

        bound = brain_llm.bind_tools(list(agent.tools.values()))
        step = 0
        response = None
        while step < max_tool_steps:
            response = await agent._ainvoke_text_with_fallback(messages, llm=bound)
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
                messages.append(ToolMessage(content=out, tool_call_id=tid))
            step += 1
        if response is None:
            response = await agent._ainvoke_text_with_fallback(messages, llm=brain_llm)
            agent._log_model_route(agent._extract_model_name(response), lane="brain")
        text = response.content if hasattr(response, "content") else str(response)
        return (text or "").strip()
    except Exception as e:
        logger.warning("Brain phase: ошибка, talk продолжит без сводки brain: %s", e)
        return ""
