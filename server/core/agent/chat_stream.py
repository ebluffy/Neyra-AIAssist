"""Streaming talk lane: token yield + context-overflow retry."""

from __future__ import annotations

import logging
from contextlib import aclosing
from typing import Any, AsyncIterator, Optional

from core.agent.reply_pipeline import (
    log_micro_plan_metrics,
    polish_clean_reply,
    sanitize_raw_reply,
)
from core.agent.talk_messages import build_talk_messages, build_talk_system_prompt
from core.agent.turn_finalize import finalize_successful_turn
from core.agent.turn_prep import prepare_turn

logger = logging.getLogger("neyra.agent.chat_stream")


async def iter_chat_stream(
    agent: Any,
    *,
    user_message: str,
    username: Optional[str],
    discord_user_id: Optional[str],
    vision_images: Optional[list[tuple[str, str]]],
    channel_id: Optional[str],
    author_display_name: Optional[str],
    lyrics_marker: str,
    avatar_url: Optional[str] = None,
    discord_context=None,
) -> AsyncIterator[dict]:
    """Yield token/error/done chunks for streaming chat."""
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
            source="chat_stream",
        )
        if fp is not None:
            text = str(fp.get("text") or "")
            if text:
                yield {"type": "token", "text": text}
            yield {
                "type": "done",
                "text": text,
                "sounds": list(fp.get("sounds") or []),
                "thoughts": "",
                "raw": str(fp.get("raw") or text),
                "fast_path": True,
            }
            return
    except Exception as fp_e:
        logger.warning("fast_path (stream) failed (soft, continue brain): %s", fp_e)

    prep = await prepare_turn(
        agent,
        user_message=user_message,
        username=username,
        discord_user_id=discord_user_id,
        vision_images=vision_images,
        channel_id=channel_id,
        author_display_name=author_display_name,
        lyrics_marker=lyrics_marker,
        log_lane="stream",
        avatar_url=avatar_url,
        discord_context=discord_context,
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
        try:
            brain_context = await agent._run_brain_tool_phase(
                user_message=user_message,
                speaker_label=prep.speaker_label,
                vision_caption=caption_ok or None,
                vision_images=vision_images if prep.brain_native_vis else None,
                brain_system=prep.brain_sys,
                **({"context_data": prep.brain_data} if getattr(prep, "brain_data", "") else {}),
                **({"discord_context": prep.discord_context} if getattr(prep, "discord_context", None) is not None else {}),
                lyrics_mode=prep.lyrics_mode,
            )
        except Exception as e:
            from core.agent.brain_phase import BRAIN_DOWN_USER_MESSAGE

            err_str = (str(e) or "").strip() or type(e).__name__
            logger.error("Brain phase (stream) failed — abort talk: %s", e)
            agent._publish_chat_turn_failed(
                internal_user_id=prep.internal_uid,
                channel_id=channel_id,
                error=f"brain: {err_str}",
            )
            yield {
                "type": "error",
                "text": BRAIN_DOWN_USER_MESSAGE,
                "sounds": ["bruh"],
            }
            return

        system_prompt = build_talk_system_prompt(agent, prep, brain_context=brain_context)
        stream_llm = agent.llm_talk
        if prep.lyrics_mode:
            stream_llm = agent.llm_talk.bind(
                max_tokens=max(agent.reply_max_tokens, agent.lyrics_reply_max_tokens)
            )
        if vision_images:
            mode = "brain-native" if prep.brain_native_vis else "caption→brain→talk"
            logger.info(
                "Зрение: %s, изображений=%s | talk_model=%s",
                mode,
                len(vision_images),
                getattr(agent, "llm_talk_model", agent.llm_model),
            )

        messages = build_talk_messages(
            agent, prep, system_prompt, user_message=user_message, vision_images=vision_images, brain_context=brain_context
        )
        final_messages_used = messages

        raw_response = ""
        context_exceeded = False
        used_model_name: Optional[str] = None
        plan_state = agent._init_micro_plan_state()
        raw_chunk_count = 0
        yielded_chunk_count = 0

        async def _consume_stream(stream_iter: Any, *, retry: bool = False) -> AsyncIterator[dict]:
            nonlocal raw_response, used_model_name, raw_chunk_count, yielded_chunk_count
            async with aclosing(stream_iter):
                async for chunk in stream_iter:
                    if used_model_name is None:
                        used_model_name = agent._extract_model_name(chunk)
                    token = chunk.content if hasattr(chunk, "content") else str(chunk)
                    if token:
                        raw_chunk_count += 1
                        raw_response += token
                        visible = agent._filter_micro_plan_token(token, plan_state)
                        if visible:
                            yield {"type": "token", "text": visible}
                            yielded_chunk_count += 1
            tail = agent._finalize_micro_plan_state(plan_state)
            if tail:
                yield {"type": "token", "text": tail}
                yielded_chunk_count += 1
            agent._log_model_route(used_model_name, lane="talk")
            logger.debug(
                "LLM stream stats | raw_chunks=%s | yielded_chunks=%s | micro_plan=%s%s",
                raw_chunk_count,
                yielded_chunk_count,
                agent.micro_planning_enabled,
                " | retry=true" if retry else "",
            )

        try:
            async with aclosing(_consume_stream(
                agent._astream_text_with_fallback(messages, llm=stream_llm)
            )) as stream:
                async for item in stream:
                    yield item
        except Exception as e:
            err_str = (str(e) or "").strip() or type(e).__name__
            if isinstance(e, TimeoutError) or type(e).__name__ == "TimeoutError":
                err_str = (
                    "Model response timed out while waiting for the first token. "
                    "Try again later or increase llm.talk_model.primary_first_token_timeout_seconds"
                )
            if (
                "context size has been exceeded" in err_str.lower()
                or "context_length_exceeded" in err_str.lower()
            ):
                context_exceeded = True
                logger.warning(
                    "Context overflow detected. Archive if enabled, trim STM, and retry with reduced context."
                )
                try:
                    from core.agent.session_archive import archive_session

                    arch = await archive_session(
                        agent,
                        reason="overflow",
                        user_id=prep.internal_uid,
                        channel_id=channel_id,
                        apply_stm_policy=True,
                    )
                except Exception as arch_e:
                    logger.warning("session_archive on overflow failed (soft): %s", arch_e)
                    arch = {"stm_cleared": False}
                if not arch.get("stm_cleared"):
                    agent.short_memory.trim_to_half()
                    agent.short_memory.trim_to_half()
                system_prompt = build_talk_system_prompt(
                    agent,
                    prep,
                    brain_context=brain_context,
                    shrink_people=True,
                    drop_extra_context=True,
                )
                messages_retry = build_talk_messages(
                    agent,
                    prep,
                    system_prompt,
                    user_message=user_message,
                    vision_images=vision_images,
                    with_micro_plan_prefill=False,
                    drop_extra_context=True,
                )
                final_messages_used = messages_retry
                try:
                    async with aclosing(_consume_stream(
                        agent._astream_text_with_fallback(messages_retry, llm=stream_llm),
                        retry=True,
                    )) as stream:
                        async for item in stream:
                            yield item
                except Exception as e2:
                    logger.error("Ошибка повторного запроса (даже с урезанным контекстом): %s", e2)
                    agent._publish_chat_turn_failed(
                        internal_user_id=prep.internal_uid,
                        channel_id=channel_id,
                        error=str(e2),
                    )
                    yield {"type": "error", "text": str(e2)}
                    return
            else:
                logger.error("Ошибка стриминга LLM: %s", e)
                agent._publish_chat_turn_failed(
                    internal_user_id=prep.internal_uid,
                    channel_id=channel_id,
                    error=err_str,
                )
                yield {"type": "error", "text": err_str}
                return

        clean_text, thoughts, sounds = sanitize_raw_reply(
            agent, raw_response, lyrics_mode=prep.lyrics_mode, mode_label="stream"
        )
        clean_text = await polish_clean_reply(
            agent,
            user_message=user_message,
            clean_text=clean_text,
            messages=final_messages_used,
            lyrics_mode=prep.lyrics_mode,
        )

        if context_exceeded:
            logger.info("Успешный ответ после переполнения контекста.")

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
            source="chat_stream",
            stm_trimmed=context_exceeded,
        )
        log_micro_plan_metrics(agent)
        logger.debug("Стрим завершён | sounds=%s | len=%s", sounds, len(clean_text))

        yield {
            "type": "done",
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
