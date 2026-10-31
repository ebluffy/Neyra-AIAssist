"""Brain lane: routing summary + optional tool-loop before talk."""

from __future__ import annotations

import asyncio
import json
import logging
import time
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
    from core.desktop.bridge import DESKTOP_TURN, DesktopTurn, brain_tools
    server_tools_on = bool(mcp_cfg.get("llm_tool_calls"))

    def current_tools():
        # Desktop may only narrow rights (§3b.9): connecting a PC must not re-enable MCP/server tools
        # when mcp_client.llm_tool_calls is false — bind client_* tools alone in that case.
        desktop = brain_tools()
        return desktop, ({**agent.tools, **desktop} if server_tools_on else dict(desktop))

    desktop_tools, turn_tools = current_tools()
    use_tool_loop = bool(turn_tools)
    max_tool_steps = max(1, int(mcp_cfg.get("llm_tool_max_steps", 4)))
    loop_limits = desktop_loop_limits(agent.config) if desktop_tools else None
    if loop_limits:
        max_tool_steps = loop_limits["max_steps"]
    desktop_turn = DesktopTurn(max_actions=loop_limits["max_actions"]) if loop_limits else None
    turn_token = DESKTOP_TURN.set(desktop_turn)

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

        bound_names = set(turn_tools)
        bound = brain_llm.bind_tools(list(turn_tools.values()))
        step = 0
        response = None
        stop_reason = None
        started = time.monotonic()
        while step < max_tool_steps:
            if loop_limits and time.monotonic() - started > loop_limits["max_seconds"]:
                stop_reason = "wall_clock_budget"
                break
            if desktop_tools or loop_limits:
                # Permissions are re-read every step: a contour switched off or a revoked PC
                # disappears from the bound tools instead of being called from a stale list.
                desktop_tools, turn_tools = current_tools()
                if set(turn_tools) != bound_names:
                    bound_names = set(turn_tools)
                    if not turn_tools:
                        stop_reason = "tools_revoked"
                        break
                    bound = brain_llm.bind_tools(list(turn_tools.values()))
            try:
                if loop_limits:
                    remaining = loop_limits["max_seconds"] - (time.monotonic() - started)
                    response = await asyncio.wait_for(
                        invoke(agent, bound, messages, lane="brain", purpose="tools", images=bool(vision_images), invoker=agent._ainvoke_text_with_fallback),
                        max(1.0, remaining),
                    )
                else:
                    response = await invoke(agent, bound, messages, lane="brain", purpose="tools", images=bool(vision_images), invoker=agent._ainvoke_text_with_fallback)
            except TimeoutError:
                stop_reason = "wall_clock_budget"
                break
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
                if tname in desktop_tools:
                    if loop_limits:
                        remaining = loop_limits["max_seconds"] - (time.monotonic() - started)
                        try:
                            # Expiry cancels the pending call on the PC (registry sends `cancel`).
                            out = await asyncio.wait_for(desktop_tools[tname].ainvoke(args), max(1.0, remaining))
                        except TimeoutError:
                            desktop_turn.outcome_unknown = True
                            out = json.dumps({"status": "unknown", "code": "wall_clock_budget", "retry": False})
                    else:
                        out = await desktop_tools[tname].ainvoke(args)
                elif tname.startswith(("client.", "client_")):
                    out = '{"status":"unavailable"}'
                elif not server_tools_on:
                    out = '{"status":"unavailable"}'
                else:
                    out = await agent._execute_tool(tname, **args)
                messages.append(ToolMessage(content=out, tool_call_id=tid, name=tname))
            if desktop_turn is not None and desktop_turn.images:
                messages.append(await _screenshot_message(agent, desktop_turn))
            step += 1
        if loop_limits:
            _record_loop(step, started, stop_reason or ("step_budget" if step >= max_tool_steps else "done"),
                         desktop_turn)
        if stop_reason or (response is not None and getattr(response, "tool_calls", None) and step >= max_tool_steps):
            observed = [message for message in messages if isinstance(message, ToolMessage)]
            return json.dumps({
                "tool_budget_exhausted": True,
                "stop_reason": stop_reason or "step_budget",
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
    finally:
        DESKTOP_TURN.reset(turn_token)


def desktop_loop_limits(config) -> dict:
    """Bounded PC agent loop (§10): step, wall-clock and action budgets with hard caps."""
    cfg = config.get("desktop_agent") if isinstance(config.get("desktop_agent"), dict) else {}

    def bounded(key, default, low, high):
        try:
            return min(high, max(low, int(cfg.get(key, default))))
        except (TypeError, ValueError):
            return default

    return {
        "max_steps": bounded("max_steps", 8, 1, 16),
        "max_seconds": bounded("max_seconds", 180, 10, 600),
        "max_actions": bounded("max_actions", 24, 1, 64),
    }


async def _screenshot_message(agent, turn):
    """Screenshots reach the brain only as an image message (or a vision caption), never as tool text."""
    from langchain_core.messages import HumanMessage

    images, turn.images = turn.images, []
    label = "[PC SCREENSHOT] Latest screenshot from the user's PC; coordinates for client_input are pixels of this image."
    try:
        if agent._uses_brain_native_vision():
            return agent._make_human_turn(label, images[-1:])
        if getattr(agent, "llm_vision", None) is not None:
            caption = await agent._caption_vision_images(label, images[-1:])
            return HumanMessage(content=label + "\n[VISION SUMMARY]\n" + str(caption or "")[:4000])
    except Exception as exc:
        logger.warning("Desktop screenshot not delivered to brain: %s", type(exc).__name__)
    return HumanMessage(content=label + "\n(The brain model cannot see images in this configuration; "
                                        "do not guess coordinates.)")


def _record_loop(steps, started, reason, turn):
    from core.agent.model_trace import ACTIVE_TRACE

    trace = ACTIVE_TRACE.get()
    if trace is None:
        return
    trace.agent_loop = {
        "steps": steps,
        "elapsed_ms": round((time.monotonic() - started) * 1000),
        "stop_reason": reason,
        "actions": turn.actions if turn else 0,
        "outcome_unknown": bool(turn and turn.outcome_unknown),
    }
