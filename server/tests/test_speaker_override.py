from core.api.app import _speaker_name_override


def test_empty_speaker_label_only_without_any_name_source():
    assert _speaker_name_override() == ""
    assert _speaker_name_override(username="api_user") is None
    assert _speaker_name_override(display_name="Иван") is None
    assert _speaker_name_override(platform_user_id="discord-1") is None
    assert _speaker_name_override(has_context=True) is None
