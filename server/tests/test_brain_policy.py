"""Brain planner policy: plain chat must not pay for a second LLM call."""
from types import SimpleNamespace

from core.agent.brain_policy import (
    TOOL_FAMILY,
    TOOL_FAMILY_HINTS,
    brain_mode,
    looks_like_tool_request,
    should_run_brain,
)


def agent(mode: str = "auto", *, tools=True, capabilities=None):
    return SimpleNamespace(
        config={
            "agent": {"brain": {"mode": mode}},
            "mcp_client": {"llm_tool_calls": tools},
        },
        tools={"dummy": object()} if tools else {},
        llm_brain_capabilities=capabilities,
    )


def prep(*, native_vision: bool = False):
    return SimpleNamespace(brain_native_vis=native_vision)


def test_plain_chat_skips_brain_in_auto_mode():
    run, reason = should_run_brain(
        agent(), prep(), deep_think=False, user_message="привет, как дела?",
        tools_available_override=True,
    )
    assert run is False
    assert reason == "plain_chat"


def test_explicit_deep_think_wins_even_in_off_mode():
    run, reason = should_run_brain(
        agent("off"), prep(), deep_think=True, user_message="привет",
        tools_available_override=False,
    )
    assert run is True
    assert reason == "deep_think"


def test_always_and_off_modes():
    assert should_run_brain(
        agent("always"), prep(), deep_think=False, user_message="привет",
        tools_available_override=False,
    ) == (True, "mode_always")
    assert should_run_brain(
        agent("off"), prep(), deep_think=False, user_message="найди файл отчёт",
        tools_available_override=True,
    ) == (False, "mode_off")


def test_auto_runs_for_tool_intent_only_when_tools_exist():
    assert should_run_brain(
        agent(), prep(), deep_think=False, user_message="найди файл отчёт",
        tools_available_override=True,
    ) == (True, "tool_intent")
    assert should_run_brain(
        agent(), prep(), deep_think=False, user_message="найди файл отчёт",
        tools_available_override=False,
    ) == (False, "no_tools")


def test_auto_runs_for_native_vision():
    assert should_run_brain(
        agent(), prep(native_vision=True), deep_think=False,
        user_message="что на картинке?", vision_images=[("image/png", "x")],
        tools_available_override=False,
    ) == (True, "native_vision")


def test_off_mode_still_runs_for_native_vision():
    assert should_run_brain(
        agent("off"), prep(native_vision=True), deep_think=False,
        user_message="что на картинке?", vision_images=[("image/png", "x")],
        tools_available_override=False,
    ) == (True, "native_vision")


def test_auto_skips_when_brain_provider_has_no_tools():
    run, reason = should_run_brain(
        agent(capabilities={"supports_tool_calls": False}), prep(),
        deep_think=False, user_message="запусти программу",
        tools_available_override=True,
    )
    assert run is False
    assert reason == "tools_unsupported"


def test_tool_hints_cover_ru_and_en():
    for text in (
        "найди файл отчёт", "какая погода завтра", "what time is it",
        "search the web for docs", "open youtube", "turn the volume up",
        "pause the music", "remember that I like tea", "who is Vasya",
        "delete these files", "list my folders", "run these commands",
        "take screenshots", "run the program", "open the file",
        "execute the command", "удали этот файл", "что лежит в папке загрузки",
        "открой эту папку",
    ):
        assert looks_like_tool_request(text)
    for text in (
        "расскажи анекдот", "my profile is private", "sometimes I am tired",
        "моя команда выиграла", "какой у тебя профайл", "вчера было холодно", "",
    ):
        assert not looks_like_tool_request(text)


def test_every_tool_has_family_hints_in_both_languages():
    import inspect
    import re

    from core.desktop.bridge import brain_tools
    from core.tools.builtins import ALL_TOOLS

    desktop_names = set(re.findall(r"'(client\.[a-z_]+)':", inspect.getsource(brain_tools)))
    assert desktop_names
    assert desktop_names <= set(TOOL_FAMILY)

    for tool in ALL_TOOLS:
        name = getattr(tool, "name", None) or getattr(tool, "__name__", "")
        assert name in TOOL_FAMILY, name
    for name, family in TOOL_FAMILY.items():
        assert family in TOOL_FAMILY_HINTS, name
        hints = TOOL_FAMILY_HINTS[family]
        assert any(any("а" <= ch <= "я" or ch == "ё" for ch in hint) for hint in hints), family
        assert any(hint.isascii() for hint in hints), family
        for hint in hints:
            assert looks_like_tool_request(hint), (family, hint)


def test_invalid_mode_falls_back_to_auto():
    assert brain_mode({"agent": {"brain": {"mode": "wat"}}}) == "auto"
    assert brain_mode({}) == "auto"


def test_plain_chat_does_not_call_brain_end_to_end(tmp_path):
    import asyncio

    from offline_support import offline_agent

    agent = offline_agent(tmp_path / "auto")
    agent.config["agent"]["brain"]["mode"] = "auto"
    calls = []

    async def brain(**kwargs):
        calls.append(kwargs)
        return "facts"

    agent._run_brain_tool_phase = brain
    try:
        out = asyncio.run(agent.chat("привет"))
        assert out["text"]
        assert calls == []

        agent.config["mcp_client"] = {"llm_tool_calls": True}
        agent.tools = {"dummy": object()}
        asyncio.run(agent.chat("найди файл отчёт"))
        assert len(calls) == 1
    finally:
        agent.memory_hub.close()


def test_auto_tool_intent_brain_failure_falls_back_to_talk(tmp_path):
    import asyncio

    from offline_support import offline_agent

    agent = offline_agent(tmp_path / "auto-fail")
    agent.config["agent"]["brain"]["mode"] = "auto"
    agent.config["mcp_client"] = {"llm_tool_calls": True}
    agent.tools = {"dummy": object()}

    async def brain(**kwargs):
        raise RuntimeError("planner down")

    agent._run_brain_tool_phase = brain
    try:
        out = asyncio.run(agent.chat("найди файл отчёт"))
        assert out["text"]
        assert "code" not in out
        talk_prompt = "\n".join(
            str(message.content) for message in agent.llm_talk.messages[-1]
        )
        assert "planner/tool lane is unavailable" in talk_prompt
        assert "not performed" in talk_prompt
    finally:
        agent.memory_hub.close()


def test_deep_think_brain_failure_is_fatal(tmp_path):
    import asyncio

    from offline_support import offline_agent

    agent = offline_agent(tmp_path / "deep-fail")
    agent.config["agent"]["brain"]["mode"] = "auto"

    async def brain(**kwargs):
        raise RuntimeError("planner down")

    agent._run_brain_tool_phase = brain
    try:
        out = asyncio.run(agent.chat("привет", deep_think=True))
        assert out["code"] == "brain_unavailable"
    finally:
        agent.memory_hub.close()


def test_stream_emits_deep_think_phase_only_when_requested(tmp_path):
    import asyncio

    from offline_support import offline_agent

    agent = offline_agent(tmp_path / "stream-phases")
    agent.config["agent"]["brain"]["mode"] = "auto"

    async def brain(**kwargs):
        return "facts"

    async def collect(stream):
        return [chunk async for chunk in stream]

    agent._run_brain_tool_phase = brain
    try:
        deep = asyncio.run(collect(agent.chat_stream("привет", progress=True, deep_think=True)))
        deep_phases = [c["phase"] for c in deep if c.get("type") == "phase"]
        assert "deep_think" in deep_phases
        assert "plan" not in deep_phases

        plain = asyncio.run(collect(agent.chat_stream("привет", progress=True)))
        plain_phases = [c["phase"] for c in plain if c.get("type") == "phase"]
        assert "plan" not in plain_phases
        assert "deep_think" not in plain_phases
    finally:
        agent.memory_hub.close()


def test_brain_failure_after_tool_call_does_not_fall_back(tmp_path):
    import asyncio

    from offline_support import offline_agent

    from core.agent.brain_phase import BrainPhaseError

    agent = offline_agent(tmp_path / "tool-then-fail")
    agent.config["agent"]["brain"]["mode"] = "auto"
    agent.config["mcp_client"] = {"llm_tool_calls": True}
    agent.tools = {"dummy": object()}

    async def brain(**kwargs):
        raise BrainPhaseError("invoke failed after shell_exec", tools_executed=True)

    agent._run_brain_tool_phase = brain
    try:
        out = asyncio.run(agent.chat("найди файл отчёт"))
        assert out["code"] == "brain_unavailable"
    finally:
        agent.memory_hub.close()


def test_stream_brain_failure_after_tool_call_is_fatal(tmp_path):
    import asyncio

    from offline_support import offline_agent

    from core.agent.brain_phase import BrainPhaseError

    agent = offline_agent(tmp_path / "stream-tool-fail")
    agent.config["agent"]["brain"]["mode"] = "auto"
    agent.config["mcp_client"] = {"llm_tool_calls": True}
    agent.tools = {"dummy": object()}

    async def brain(**kwargs):
        raise BrainPhaseError("after tool", tools_executed=True)

    async def collect(stream):
        return [chunk async for chunk in stream]

    agent._run_brain_tool_phase = brain
    try:
        events = asyncio.run(collect(agent.chat_stream("найди файл отчёт", progress=True)))
        assert events[-1]["type"] == "error"
        assert events[-1]["code"] == "brain_unavailable"
    finally:
        agent.memory_hub.close()
