from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "fetch_lavalink_plugins.py"
spec = spec_from_file_location("fetch_lavalink_plugins", SCRIPT)
module = module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(module)

SHA = "b33460b38ad13b5cd07da75e46444397cf0ea2df"


def test_snapshot_url_uses_maven_for_sha_versions():
    assert module._plugin_download_url("dev.lavalink.youtube", "youtube-plugin", SHA) == (
        "https://maven.lavalink.dev/snapshots/dev/lavalink/youtube/youtube-plugin/"
        f"{SHA}/youtube-plugin-{SHA}.jar"
    )
    assert module._plugin_download_url("dev.lavalink.youtube", "youtube-plugin", "1.18.2") == (
        "https://github.com/lavalink-devs/youtube-source/releases/download/"
        "1.18.2/youtube-plugin-1.18.2.jar"
    )


def test_snapshot_version_updates_yaml_flag(tmp_path):
    cfg = tmp_path / "application.yml"
    cfg.write_text(
        'lavalink:\n  plugins:\n'
        '    - dependency: "dev.lavalink.youtube:youtube-plugin:1.18.2"\n'
        "      snapshot: false\n",
        encoding="utf-8",
    )
    module._sync_youtube_plugin_version_in_yaml(cfg, SHA)
    text = cfg.read_text(encoding="utf-8")
    assert f"youtube-plugin:{SHA}" in text
    assert "snapshot: true" in text
    module._sync_youtube_plugin_version_in_yaml(cfg, "1.19.0")
    assert "snapshot: false" in cfg.read_text(encoding="utf-8")


def test_fallback_version_accepts_release_and_snapshot_names():
    assert module._version_from_jar_name("youtube-plugin-1.18.2.jar") == "1.18.2"
    assert module._version_from_jar_name(f"youtube-plugin-{SHA}.jar") == SHA
    assert module._version_from_jar_name("other.jar") == ""
