"""Non-streaming talk lane (single ainvoke)."""

from __future__ import annotations

import logging
from typing import Any, Optional

from core.agent.reply_pipeline import (
    log_micro_plan_metrics,
    polish_clean_reply,
    sanitize_raw_reply,
)
from core.agent.talk_messages import build_talk_messages, build_talk_system_prompt
from core.agent.turn_finalize import finalize_successful_turn
from core.agent.turn_prep import prepare_turn

logger = logging.getLogger("neyra.agent.chat")


async def run_chat(
    agent: Any,
    *,
    user_message: str,
    username: Optional[str],
    discord_user_id: Optional[str],
    vision_images: Optional[list[tuple[str, str]]],
    channel_id: Optional[str],
    author_display_name: Optional[str],
    lyrics_marker: str,
) -> dict:
    """Run one non-streaming chat turn; return text/sounds/thoughts/raw."""
    try:
        from core.agent.fast_path import try_handle_fast_path

        fp = await try_handle_fast_path(
            agent,
            user_message=user_message,
            username=username,
            discord_user_id=discord_user_id,
            channel_id=channel_id,
            author_display_name=author_display_name,
            vision_images=vision_images,
            lyrics_marker=lyrics_marker,
            source="chat",
        )
        if fp is not None:
            return fp
    except Exception as fp_e:
        logger.warning("fast_path failed (soft, continue brain): %s", fp_e)

    prep = await prepare_turn(
        agent,
        user_message=user_message,
        username=username,
        discord_user_id=discord_user_id,
        vision_images=vision_images,
        channel_id=channel_id,
        author_display_name=author_display_name,
        lyrics_marker=lyrics_marker,
        log_lane="chat",
    )
    try:
        try:
            from core.agent.session_archive import archive_session, should_archive_stm_threshold

            if should_archive_stm_threshold(agent):
                arch = await archive_session(
                    agent,
                    reason="stm_threshold",
                    user_id=prep.internal_uid,
                    channel_id=channel_id,
                    apply_stm_policy=True,
                )
                if not arch.get("stm_cleared"):
                    agent.short_memory.trim_to_half()
        except Exception as thr_e:
            logger.warning("session_archive stm_threshold failed (soft): %s", thr_e)

        caption_ok = (prep.attached_caption or "").strip()
        brain_context = ""
        try:
            brain_context = await agent._run_brain_tool_phase(
                user_message=user_message,
                speaker_label=prep.speaker_label,
                vision_caption=caption_ok or None,
                vision_images=vision_images if prep.brain_native_vis else None,
                brain_system=prep.brain_sys,
                lyrics_mode=prep.lyrics_mode,
            )
        except Exception as e:
            logger.warning("Brain phase: пропуск сводки — %s", e)

        system_prompt = build_talk_system_prompt(agent, prep, brain_context=brain_context)
        messages = build_talk_messages(
            agent, prep, system_prompt, user_message=user_message, vision_images=vision_images
        )
        final_messages_used = messages

        try:
            cap_llm = (
                agent.llm_talk.bind(
                    max_tokens=max(agent.reply_max_tokens, agent.lyrics_reply_max_tokens)
                )
                if prep.lyrics_mode
                else agent.llm_talk
            )
            response = await agent._ainvoke_text_with_fallback(messages, llm=cap_llm)
            agent._log_model_route(agent._extract_model_name(response), lane="talk")
            raw_response = response.content if hasattr(response, "content") else str(response)
        except Exception as e:
            logger.error("Ошибка вызова LLM: %s", e)
            agent._publish_chat_turn_failed(
                internal_user_id=prep.internal_uid,
                channel_id=channel_id,
                error=str(e),
            )
            return {
                "text": f"[SOUND: bruh] Что-то сломалось на моей стороне: {e}",
                "sounds": ["bruh"],
                "thoughts": "",
                "raw": "",
            }

        clean_text, thoughts, sounds = sanitize_raw_reply(
            agent, raw_response, lyrics_mode=prep.lyrics_mode, mode_label="chat"
        )
        clean_text = await polish_clean_reply(
            agent,
            user_message=user_message,
            clean_text=clean_text,
            messages=final_messages_used,
        )

        await finalize_successful_turn(
            agent,
            user_message=user_message,
            clean_text=clean_text,
            thoughts=thoughts,
            sounds=sounds,
            username=username,
            discord_user_id=discord_user_id,
            channel_id=channel_id,
            speaker_label=prep.speaker_label,
            internal_uid=prep.internal_uid,
            vision_images=vision_images,
            saved_facts=prep.saved_facts,
            source="chat",
            stm_trimmed=False,
        )
        log_micro_plan_metrics(agent)
        return {
            "text": clean_text,
            "sounds": sounds,
            "thoughts": thoughts,
            "raw": raw_response,
        }
    finally:
        try:
            from core.tools.builtins import clear_turn_memory_scope

            clear_turn_memory_scope()
        except Exception:
            pass
