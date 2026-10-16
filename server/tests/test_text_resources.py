"""Resource correctness and exact prompt parity with merged PR #27."""

import ast
import json
import shutil
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

import pytest

from core import text_resources as resources
from core.agent import prompts
from core.agent.conversation_modes import conversation_mode_hint
from core.agent.micro_plan import MicroPlanSettings

ROOT = Path(__file__).resolve().parents[1]
CASES = json.loads((Path(__file__).parent / "fixtures" / "prompt_contracts.json").read_text())


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["kind"] + ":" + str(case["kwargs"].get("conversation_mode", case["kwargs"].get("mode", "context"))))
def test_prompt_text_is_unchanged_from_main(case, monkeypatch):
    monkeypatch.setattr(prompts, "datetime", SimpleNamespace(now=lambda: datetime(2026, 1, 2, 3, 4, 5)))
    kwargs = dict(case["kwargs"])
    if case["kind"] == "talk":
        kwargs["micro_plan"] = MicroPlanSettings(**kwargs["micro_plan"])
        actual = prompts.build_talk_system_prompt(**kwargs)
    elif case["kind"] == "brain":
        actual = prompts.build_brain_system_prompt(**kwargs)
    else:
        actual = conversation_mode_hint(**kwargs)
    assert actual == case["expected"]


def test_all_static_prompt_references_exist_and_no_catalog_orphans():
    catalog = resources._catalog("prompts", "en")
    referenced = set()
    for directory in (ROOT / "core", ROOT / "modules"):
        for path in directory.rglob("*.py"):
            for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "prompt_text":
                    assert node.args and isinstance(node.args[0], ast.Constant), path
                    key = node.args[0].value
                    assert key in catalog, (path, key)
                    assert {keyword.arg for keyword in node.keywords} == resources._parameters(catalog[key]), (path, key)
                    referenced.add(key)
    assert referenced == set(catalog)


def test_resources_work_outside_server_and_preserve_braces_as_data(tmp_path, monkeypatch):
    resources._catalog.cache_clear()
    monkeypatch.chdir(tmp_path)
    value = "{not_a_template} <@123>"
    assert value in resources.prompt_text("talk.speaker_label", username=value)
    assert resources.validate_text_resources()["prompts"] > 0


def test_message_language_is_independent_of_service_prompts():
    english = resources.message_text("brain.unavailable", locale="en")
    assert english != resources.message_text("brain.unavailable", locale="ru")
    assert english == resources.message_text("brain.unavailable", locale="../../secret")
    assert resources.message_text("reply.empty") == "Затупила на секунду. Повтори коротко, пожалуйста."
    assert "You are Neyra's internal planning" in resources.prompt_text("brain.role")


@pytest.mark.parametrize("parameters", [{}, {"username": "u", "extra": "PRIVATE_VALUE"}])
def test_missing_or_extra_parameters_fail_without_leaking_data(parameters):
    with pytest.raises(resources.TextResourceError) as error:
        resources.prompt_text("talk.speaker_label", **parameters)
    assert "PRIVATE_VALUE" not in str(error.value)
    with pytest.raises(resources.TextResourceError, match="Unknown"):
        resources.prompt_text("missing.resource")


@pytest.fixture
def catalog_copy(tmp_path, monkeypatch):
    target = tmp_path / "resources"
    shutil.copytree(ROOT / "resources", target)
    monkeypatch.setattr(resources, "_ROOT", target)
    resources._catalog.cache_clear()
    yield target
    resources._catalog.cache_clear()


def test_missing_translation_falls_back_but_mismatched_translation_fails(catalog_copy):
    path = catalog_copy / "messages" / "ru.json"
    path.write_text(json.dumps({"reply.empty": "Проверка"}), encoding="utf-8")
    assert resources.message_text("brain.unavailable") == resources.message_text("brain.unavailable", locale="en")
    resources.validate_text_resources()
    path.write_text(json.dumps({"reply.empty": "Проверка {unknown}"}), encoding="utf-8")
    resources._catalog.cache_clear()
    with pytest.raises(resources.TextResourceError, match="Translation"):
        resources.validate_text_resources()


@pytest.mark.parametrize("template", ["{person.__class__}", "{person[key]}", "{person!r}", "{person:>8}", "{}", "{"])
def test_resource_templates_cannot_traverse_objects_or_use_format_expressions(catalog_copy, template):
    (catalog_copy / "prompts" / "en.json").write_text(json.dumps({"test.policy": template}), encoding="utf-8")
    with pytest.raises(resources.TextResourceError):
        resources.prompt_text("test.policy", person="data")


@pytest.mark.parametrize("contents", ['{"key":"one","key":"two"}', '{"key":7}', '{}', '[]', 'not json'])
def test_bad_catalog_fails_explicitly(catalog_copy, contents):
    (catalog_copy / "prompts" / "en.json").write_text(contents, encoding="utf-8")
    with pytest.raises(resources.TextResourceError):
        resources.validate_text_resources()


def test_missing_catalog_does_not_silently_replace_service_policy(catalog_copy):
    (catalog_copy / "prompts" / "en.json").unlink()
    with pytest.raises(resources.TextResourceError, match="prompts/en.json"):
        resources.prompt_text("brain.role")
