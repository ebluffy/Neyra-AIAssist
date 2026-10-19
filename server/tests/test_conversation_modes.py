"""Offline checks for configured talk styles and their runtime persistence."""

import asyncio
from types import SimpleNamespace

import pytest
import yaml

from core.agent.conversation_modes import CONVERSATION_MODE_HINTS
from core.agent.micro_plan import MicroPlanSettings
from core.agent.talk_messages import build_talk_system_prompt as build_turn_prompt
from core.agent.talk_messages import build_talk_messages
from core.neyra import NeyraAgent
from core.runtime.config_loader import load_layered_yaml, validate_config_schema


@pytest.fixture
def talk_agent(tmp_path):
    agent = NeyraAgent.__new__(NeyraAgent)
    agent.config = {"assistant": {"system_prompt": "Persona: кратко, с шутками."}}
    agent.backend = "openrouter"
    agent.llm_vision = None
    agent.short_memory = SimpleNamespace(get_history=lambda: [])
    agent._project_root = tmp_path
    agent._micro_plan_settings = lambda: MicroPlanSettings(
        False, "tags", "[PLAN]", "[/PLAN]", "PLAN:", "SAY:", False
    )
    agent._shrink_people_sections = lambda active, others, limit: (active, others)
    return agent


@pytest.mark.parametrize("mode", CONVERSATION_MODE_HINTS)
def test_mode_reaches_shared_turn_prompt_and_context_retry(talk_agent, mode):
    talk_agent.config["agent"] = {"conversation_mode": mode}
    prep = SimpleNamespace(
        attached_caption="", people_active="speaker facts", people_others="",
        memories=["memory"], diary_ctx="", speaker_label="Alice", web_ctx="",
        tool_ctx="", has_vis_prompt=False, last_img_ctx=None, lyrics_mode=False,
        mcp_catalog="", wm_snip="", include_appearance=False, pre_context="",
        talk_vm=None, brain_native_vis=False,
    )
    # chat and chat_stream use this builder; streaming also rebuilds it on context overflow.
    for retry in (False, True):
        prompt = build_turn_prompt(
            talk_agent, prep, brain_context="computed-fact-SENTINEL",
            shrink_people=retry, drop_extra_context=retry,
        )
        assert "Persona: кратко, с шутками." in prompt
        assert "speaker facts" not in prompt
        assert "computed-fact-SENTINEL" not in prompt
        assert "Never expose private reasoning" in prompt
        if mode == "default":
            assert "[CONVERSATION MODE:" not in prompt
        else:
            assert f"[CONVERSATION MODE: {mode}]" in prompt
            assert CONVERSATION_MODE_HINTS[mode] in prompt
        messages = build_talk_messages(
            talk_agent, prep, prompt, user_message="Explain this", vision_images=None,
            brain_context="computed-fact-SENTINEL", drop_extra_context=retry,
        )
        assert messages[0].type == "system"
        assert messages[0].content == prompt
        assert ("speaker facts" in str(messages[1:])) == (not retry)
        assert "computed-fact-SENTINEL" in str(messages[1:])


@pytest.mark.parametrize("mode", ["no_jokes", "technical", "detailed"])
def test_anti_repeat_keeps_mode_and_multiline_output(talk_agent, mode):
    from unittest.mock import AsyncMock, MagicMock

    talk_agent.config["agent"] = {"conversation_mode": mode}
    talk_agent.reply_max_tokens = 400
    talk_agent.short_memory = SimpleNamespace(get_history=lambda: [
        {"role": "assistant", "content": "Повторяющийся ответ"},
    ])
    rewrite = MagicMock()
    rewrite.ainvoke = AsyncMock(return_value=SimpleNamespace(content="Другой ответ\nСледующая строка"))
    talk_agent.llm_talk = MagicMock()
    talk_agent.llm_talk.bind.return_value = rewrite
    text = asyncio.run(talk_agent._de_repeat_reply("Explain", "Повторяющийся ответ"))
    assert text == "Другой ответ\nСледующая строка"
    messages = rewrite.ainvoke.call_args.args[0]
    assert CONVERSATION_MODE_HINTS[mode] in messages[0].content
    if mode in ("technical", "detailed"):
        assert "коротко" not in messages[0].content
        assert "без markdown" not in messages[0].content.lower()
        assert talk_agent.llm_talk.bind.call_args.kwargs["max_tokens"] == 400


def test_empty_reply_retry_keeps_mode(talk_agent):
    from unittest.mock import AsyncMock
    from langchain_core.messages import SystemMessage
    from core.agent.reply_pipeline import retry_short_reply_if_empty
    from core.agent.reply_postprocess import EMPTY_REPLY_PLACEHOLDER

    talk_agent.config["agent"] = {"conversation_mode": "no_jokes"}
    prompt = talk_agent._build_system_prompt()
    talk_agent.llm_talk = SimpleNamespace(ainvoke=AsyncMock(
        return_value=SimpleNamespace(content="Готово"),
    ))
    assert asyncio.run(retry_short_reply_if_empty(
        talk_agent, [SystemMessage(content=prompt)], EMPTY_REPLY_PLACEHOLDER,
    )) == "Готово"
    sent = talk_agent.llm_talk.ainvoke.call_args.args[0]
    assert CONVERSATION_MODE_HINTS["no_jokes"] in sent[0].content


@pytest.mark.parametrize("mode,lyrics_mode,complete", [
    ("brief", True, True),
    ("brief", False, False),
    ("detailed", False, True),
    ("technical", False, True),
    ("default", False, False),
])
def test_empty_retry_uses_turn_state_after_lyrics_resource_edit(
    talk_agent, monkeypatch, mode, lyrics_mode, complete,
):
    from unittest.mock import AsyncMock
    from langchain_core.messages import HumanMessage, SystemMessage
    from core.agent import prompts
    from core.agent.reply_pipeline import polish_clean_reply
    from core.agent.reply_postprocess import EMPTY_REPLY_PLACEHOLDER
    from core.text_resources import prompt_text

    def edited_prompt(key, **params):
        if key == "talk.lyrics":
            return prompt_text(key, **params).replace("[LYRICS MODE / FULL OUTPUT]", "[FULL SONG]")
        return prompt_text(key, **params)

    monkeypatch.setattr(prompts, "prompt_text", edited_prompt)
    talk_agent.config["agent"] = {"conversation_mode": mode}
    prompt = talk_agent._build_system_prompt(lyrics_mode=lyrics_mode)
    assert "[LYRICS MODE" not in prompt
    if lyrics_mode:
        assert "[FULL SONG]" in prompt
    talk_agent.llm_talk = SimpleNamespace(ainvoke=AsyncMock(
        return_value=SimpleNamespace(content="Verse one\nVerse two"),
    ))
    talk_agent._de_repeat_reply = AsyncMock(side_effect=lambda user, text, **kwargs: text)
    # A user's quote must not activate the lyrics retry policy either.
    messages = [SystemMessage(content=prompt), HumanMessage(content="Quote: [LYRICS MODE]")]
    result = asyncio.run(polish_clean_reply(
        talk_agent, user_message="song", clean_text=EMPTY_REPLY_PLACEHOLDER,
        messages=messages, lyrics_mode=lyrics_mode,
    ))
    assert result == "Verse one\nVerse two"
    sent = talk_agent.llm_talk.ainvoke.call_args.args[0]
    assert sent[0].content == prompt
    expected = "reply.retry_complete" if complete else "reply.retry_plain"
    excluded = "reply.retry_plain" if complete else "reply.retry_complete"
    assert prompt_text(expected) in sent[1].content
    assert prompt_text(excluded) not in sent[1].content

def test_missing_mode_preserves_persona(talk_agent):
    assert "[CONVERSATION MODE:" not in talk_agent._build_system_prompt()


def test_brief_mode_does_not_override_full_lyrics(talk_agent):
    talk_agent.config["agent"] = {"conversation_mode": "brief"}
    prompt = talk_agent._build_system_prompt(lyrics_mode=True, has_vision_images=True)
    assert prompt.index("[VISION PRIORITY]") < prompt.index("[CONVERSATION MODE: brief]")
    assert prompt.index("[CONVERSATION MODE: brief]") < prompt.index("[LYRICS MODE")
    assert "Brevity mode must not shorten" in prompt


@pytest.mark.parametrize("mode", CONVERSATION_MODE_HINTS)
def test_admin_update_persists_mode_and_changes_next_prompt(
    client, tmp_path, api_config, auth_headers, talk_agent, stub_agent, mode,
):
    talk_agent.config = api_config
    api_config["assistant"] = {"system_prompt": "Persona"}
    r = client.post("/v1/config/update", json={
        "updates": {"agent.conversation_mode": mode},
    }, headers=auth_headers["admin"])
    assert r.status_code == 200
    assert r.json()["data"]["persisted"] == ["config/agent.yaml"]
    assert r.json()["data"]["llm_rebound"] is False
    stub_agent._setup_llm.assert_not_called()
    root = tmp_path / "project"
    assert load_layered_yaml(root)["agent"]["conversation_mode"] == mode
    snapshot = client.get("/v1/config/runtime", headers=auth_headers["admin"]).json()
    assert snapshot["data"]["values"]["agent.conversation_mode"] == mode
    prompt = talk_agent._build_system_prompt()
    if mode != "default":
        assert CONVERSATION_MODE_HINTS[mode] in prompt
    else:
        assert "[CONVERSATION MODE:" not in prompt


@pytest.mark.parametrize("mode", ["unknown", "", "TECHNICAL", None, True, 1, [], {}])
def test_invalid_mode_rejected_before_any_disk_or_runtime_change(
    client, tmp_path, api_config, auth_headers, mode,
):
    api_config["agent"] = {"conversation_mode": "brief"}
    api_config["logging"]["level"] = "INFO"
    errors = validate_config_schema(api_config | {"agent": {"conversation_mode": mode}})
    assert any("agent.conversation_mode" in err for err in errors)
    r = client.post("/v1/config/update", json={"updates": {
        "logging.level": "DEBUG", "agent.conversation_mode": mode,
    }}, headers=auth_headers["admin"])
    assert r.status_code == 400
    assert api_config["agent"]["conversation_mode"] == "brief"
    assert api_config["logging"]["level"] == "INFO"
    assert not (tmp_path / "project" / "config").exists()


@pytest.mark.parametrize("role", ["viewer", "maint"])
def test_mode_update_requires_admin(client, auth_headers, role):
    r = client.post("/v1/config/update", json={
        "updates": {"agent.conversation_mode": "technical"},
    }, headers=auth_headers[role])
    assert r.status_code == 403


def test_example_config_contains_valid_default():
    from pathlib import Path

    example = Path(__file__).parents[1] / "config" / "agent.example.yaml"
    assert yaml.safe_load(example.read_text())["agent"]["conversation_mode"] == "default"
