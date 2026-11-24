from core.agent.speakers import resolve_speaker_label
from core.memory.person_profile import speaker_ref_from_account


def test_speaker_label_strips_control_characters():
    assert speaker_ref_from_account(display_name="Боб\nИван") == "Боб Иван"
    assert speaker_ref_from_account(handle="a\x00b") == "a b"
    assert speaker_ref_from_account(display_name="  Боб  ", handle="x") == "Боб"
    assert len(speaker_ref_from_account(display_name="x" * 500)) == 64


def test_uuid_handle_is_not_used_as_a_name():
    assert resolve_speaker_label(
        None, "123e4567-e89b-12d3-a456-426614174000", None, ""
    ) == ""


def test_generic_api_labels_are_not_names():
    for label in ("user", "api_user", "ws_user", "telegram_user", "desktop_user"):
        assert speaker_ref_from_account(display_name=label) == ""
        assert resolve_speaker_label(None, label, None, "") == ""
    for label in ("ebluffy", "dark_user", "ivan_user"):
        assert speaker_ref_from_account(display_name=label) == label
        assert resolve_speaker_label(None, label, None, "") == label


def test_fast_path_fallback_drops_unsafe_label():
    from core.agent.fast_path import _resolve_speaker

    class Broken:
        def _resolve_speaker_label(self, *args):
            raise RuntimeError("memory down")

    assert _resolve_speaker(Broken(), "ws_user", None, "a\nb") == ""


def test_explicit_empty_speaker_name_overrides_placeholder():
    from core.agent.fast_path import _resolve_speaker

    class Label:
        def _resolve_speaker_label(self, *args):
            return "generic_user"

    assert _resolve_speaker(Label(), "generic_user", None, None, "") == ""
    assert _resolve_speaker(Label(), "generic_user", None, None, "Иван") == "Иван"
