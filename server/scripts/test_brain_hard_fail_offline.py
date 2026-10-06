"""Brain (Luna) must hard-fail the turn — talk (GLM) must not answer alone."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any, AsyncIterator
from unittest.mock import AsyncMock, MagicMock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _prep() -> SimpleNamespace:
    return SimpleNamespace(
        speaker_label="User",
        attached_caption="",
        brain_native_vis=False,
        brain_sys="brain sys",
        lyrics_mode=False,
        internal_uid="u1",
        memories=[],
        people_active="",
        people_others="",
        diary_ctx="",
        web_ctx="",
        tool_ctx="",
        has_vis_prompt=False,
        last_img_ctx="",
        mcp_catalog="",
        wm_snip="",
        include_appearance=False,
        pre_context="",
        talk_vm=None,
        saved_facts=[],
    )


def _assert_safe_user_text(text: str) -> None:
    from core.agent.brain_phase import BRAIN_DOWN_USER_MESSAGE

    assert text == BRAIN_DOWN_USER_MESSAGE
    assert "[SOUND" not in text
    assert "luna_down" not in text
    assert "luna_http" not in text
    assert "Traceback" not in text
    assert "умерла" in text.lower() or "мозг" in text.lower()


async def _run_chat_brain_fail() -> None:
    from core.agent.chat import run_chat

    talk_called = {"n": 0}

    async def _brain(**_kwargs: Any) -> str:
        raise RuntimeError("luna_down secret_host:8443")

    async def _talk(*_a: Any, **_k: Any) -> Any:
        talk_called["n"] += 1
        raise AssertionError("talk must not run when brain fails")

    prep = _prep()
    agent = SimpleNamespace(
        config={},
        _run_brain_tool_phase=AsyncMock(side_effect=_brain),
        _ainvoke_text_with_fallback=AsyncMock(side_effect=_talk),
        _publish_chat_turn_failed=MagicMock(),
        llm_talk=MagicMock(),
        reply_max_tokens=256,
        lyrics_reply_max_tokens=512,
        short_memory=SimpleNamespace(get_history=lambda: []),
        _make_human_turn=MagicMock(return_value=MagicMock()),
        _maybe_append_micro_plan_prefill=lambda messages, **_k: messages,
        _build_system_prompt=MagicMock(return_value="sys"),
        _shrink_people_sections=lambda a, b, _n: (a, b),
    )

    import core.agent.chat as chat_mod

    orig_prep = chat_mod.prepare_turn

    async def fake_prepare(*_a: Any, **_k: Any) -> Any:
        return prep

    chat_mod.prepare_turn = fake_prepare  # type: ignore[assignment]
    try:
        out = await run_chat(
            agent,
            user_message="привет",
            username="u",
            discord_user_id=None,
            vision_images=None,
            channel_id=None,
            author_display_name=None,
            lyrics_marker="[SYSTEM HIDDEN INSTRUCTION: User wants lyrics",
        )
    finally:
        chat_mod.prepare_turn = orig_prep  # type: ignore[assignment]

    assert talk_called["n"] == 0
    _assert_safe_user_text(str(out.get("text") or ""))
    assert out.get("sounds") == ["bruh"]
    agent._publish_chat_turn_failed.assert_called_once()
    fail_kwargs = agent._publish_chat_turn_failed.call_args.kwargs
    assert "luna_down" in str(fail_kwargs.get("error") or "")


async def _run_stream_brain_fail() -> None:
    from core.agent.chat_stream import iter_chat_stream

    talk_called = {"n": 0}

    async def _brain(**_kwargs: Any) -> str:
        raise RuntimeError("luna_down secret_host:8443")

    async def _astream(*_a: Any, **_k: Any) -> AsyncIterator[Any]:
        talk_called["n"] += 1
        raise AssertionError("talk stream must not run when brain fails")
        if False:  # pragma: no cover — make this an async generator
            yield None

    prep = _prep()
    agent = SimpleNamespace(
        config={},
        _run_brain_tool_phase=AsyncMock(side_effect=_brain),
        _astream_text_with_fallback=_astream,
        _publish_chat_turn_failed=MagicMock(),
        llm_talk=MagicMock(),
        reply_max_tokens=256,
        lyrics_reply_max_tokens=512,
        short_memory=SimpleNamespace(get_history=lambda: [], trim_to_half=lambda: None),
        llm_talk_model="talk",
        llm_model="talk",
        _make_human_turn=MagicMock(return_value=MagicMock()),
        _maybe_append_micro_plan_prefill=lambda messages, **_k: messages,
        _build_system_prompt=MagicMock(return_value="sys"),
        _shrink_people_sections=lambda a, b, _n: (a, b),
        _init_micro_plan_state=lambda: {},
        micro_planning_enabled=False,
    )

    import core.agent.chat_stream as stream_mod

    orig_prep = stream_mod.prepare_turn

    async def fake_prepare(*_a: Any, **_k: Any) -> Any:
        return prep

    stream_mod.prepare_turn = fake_prepare  # type: ignore[assignment]
    chunks: list[dict] = []
    try:
        async for chunk in iter_chat_stream(
            agent,
            user_message="привет",
            username="u",
            discord_user_id=None,
            vision_images=None,
            channel_id=None,
            author_display_name=None,
            lyrics_marker="[SYSTEM HIDDEN INSTRUCTION: User wants lyrics",
        ):
            chunks.append(chunk)
    finally:
        stream_mod.prepare_turn = orig_prep  # type: ignore[assignment]

    assert talk_called["n"] == 0
    assert len(chunks) == 1
    assert chunks[0].get("type") == "error"
    _assert_safe_user_text(str(chunks[0].get("text") or ""))
    assert chunks[0].get("sounds") == ["bruh"]
    agent._publish_chat_turn_failed.assert_called_once()


async def _run_brain_phase_raises() -> None:
    from core.agent.brain_phase import run_brain_tool_phase

    class BoomLLM:
        async def ainvoke(self, *_a: Any, **_k: Any) -> Any:
            raise RuntimeError("luna_http_500")

    agent = SimpleNamespace(
        config={},
        tools={},
        llm_brain=BoomLLM(),
        brain_max_tokens=None,
        lyrics_reply_max_tokens=512,
        _format_spoken_user_message=lambda text, label: f"[{label}]: {text}",
        _make_human_turn=MagicMock(),
        _ainvoke_text_with_fallback=lambda messages, llm=None: llm.ainvoke(messages),
        _log_model_route=MagicMock(),
        _extract_model_name=MagicMock(return_value=None),
        _execute_tool=AsyncMock(),
    )
    try:
        await run_brain_tool_phase(
            agent,
            user_message="hi",
            speaker_label="U",
            vision_caption=None,
            vision_images=None,
            brain_system="sys",
            lyrics_mode=False,
        )
        raise AssertionError("brain phase must raise")
    except RuntimeError as e:
        assert "luna_http_500" in str(e)


def main() -> int:
    asyncio.run(_run_brain_phase_raises())
    asyncio.run(_run_chat_brain_fail())
    asyncio.run(_run_stream_brain_fail())
    print("OK test_brain_hard_fail_offline")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
