"""Migration status selects the runtime DB and never migrates or creates it."""

import os
import sqlite3

import pytest

from scripts import db_migrations


@pytest.fixture
def root(tmp_path, monkeypatch):
    inherited = os.environ
    original = dict(inherited)
    monkeypatch.setattr(os, "environ", inherited.copy())
    monkeypatch.setattr(db_migrations, "SERVER_ROOT", tmp_path)
    monkeypatch.delenv("NEYRA_DATA_DIR", raising=False)
    monkeypatch.setattr("sys.argv", ["db_migrations.py", "--status"])
    (tmp_path / "config").mkdir()
    (tmp_path / "config.yaml").write_text("paths:\n  data_dir: ./runtime\nassistant: {}\n")
    (tmp_path / "config/runtime.yaml").write_text("logging:\n  level: INFO\n  system_log: ./logs/system.log\n")
    (tmp_path / "config/llm.yaml").write_text("llm:\n  talk_model:\n    provider: offline\n    model: offline\n")
    yield tmp_path
    unchanged = dict(inherited) == original
    assert unchanged, "CLI test modified the inherited process environment"


def database(path, versions=range(1, 8)):
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as conn:
        conn.execute("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY)")
        conn.executemany("INSERT INTO schema_migrations VALUES(?)", [(v,) for v in versions])
    return path


def test_real_layered_config_selects_custom_db_read_only(root, capsys):
    db = database(root / "external#?.sqlite")
    database(root / "runtime/memory/neyra_memory.db", [1])
    (root / "config/memory.yaml").write_text(f"memory:\n  sqlite_path: '{db}'\n")
    before = db.read_bytes()
    assert db_migrations.main() == 0
    output = capsys.readouterr().out
    assert f"memory_db: {db}" in output
    assert "missing:  none" in output
    assert db.read_bytes() == before


def test_dotenv_data_dir_matches_runtime_resolution(root, capsys):
    target = root / "environment-data"
    db = database(target / "memory/neyra_memory.db")
    (root / ".env").write_text(f"NEYRA_DATA_DIR={target}\n")
    assert db_migrations.main() == 0
    assert f"memory_db: {db}" in capsys.readouterr().out


def test_explicit_copy_bypasses_live_config(root, monkeypatch, capsys):
    copy = root / "copy"
    db = database(copy / "memory/neyra_memory.db")
    (root / "config.yaml").unlink()
    def forbidden(*args, **kwargs):
        pytest.fail("Explicit copy inspection must not load live configuration")
    monkeypatch.setattr("core.runtime.config_loader.load_layered_config", forbidden)
    monkeypatch.setattr("core.runtime.secrets.load_dotenv_file", forbidden)
    monkeypatch.setattr("sys.argv", ["db_migrations.py", "--data-dir", str(copy)])
    assert db_migrations.main() == 0
    assert f"memory_db: {db}" in capsys.readouterr().out


@pytest.mark.parametrize("error", [ValueError("PRIVATE-CONFIG-DETAIL"), FileNotFoundError("PRIVATE-CONFIG-DETAIL")])
def test_config_failure_is_nonzero_and_does_not_inspect_fallback(root, monkeypatch, capsys, error):
    def fail(*args, **kwargs):
        raise error
    def forbidden(*args, **kwargs):
        pytest.fail("Invalid configuration must not fall back to another DB")
    monkeypatch.setattr("core.runtime.config_loader.load_layered_config", fail)
    monkeypatch.setattr(db_migrations, "_versions", forbidden)
    assert db_migrations.main() == 2
    result = capsys.readouterr()
    assert not result.out
    assert "no database inspected" in result.err
    assert "PRIVATE-CONFIG-DETAIL" not in result.err


@pytest.mark.parametrize("versions", [None, [1, 2, 3, 4, 5]])
def test_missing_or_outdated_copy_is_nonzero_without_writes(root, monkeypatch, capsys, versions):
    copy = root / "copy"
    db = copy / "memory/neyra_memory.db"
    if versions:
        database(db, versions)
    before = db.read_bytes() if db.exists() else None
    monkeypatch.setattr("sys.argv", ["db_migrations.py", "--data-dir", str(copy)])
    assert db_migrations.main() == 1
    assert "missing:" in capsys.readouterr().out
    assert (db.read_bytes() if db.exists() else None) == before
