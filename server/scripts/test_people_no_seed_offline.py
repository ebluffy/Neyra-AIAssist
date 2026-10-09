"""Offline: no people_seed; empty Hub stays empty after bootstrap hydrate."""

from __future__ import annotations

import importlib.util
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def test_people_seed_module_gone() -> None:
    assert importlib.util.find_spec("core.agent.people_seed") is None


def test_empty_hub_stays_empty_after_hydrate() -> None:
    from core.memory import MemoryHub, PeopleDB

    td = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
    try:
        cfg = {"memory": {"sqlite_path": str(Path(td.name) / "hub.db"), "rag_enabled": False}}
        hub = MemoryHub(cfg, long_memory=None)
        try:
            assert hub.list_people() == []
            pdb = PeopleDB(cfg)
            pdb.memory_hub = hub
            loaded = pdb.hydrate_from_hub(hub)
            assert loaded == 0
            assert pdb._cache == {}
            assert hub.list_people() == []
        finally:
            hub.sqlite.close()
    finally:
        td.cleanup()


def test_wipe_then_hydrate_stays_empty() -> None:
    from core.memory import MemoryHub, PeopleDB

    td = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
    try:
        cfg = {"memory": {"sqlite_path": str(Path(td.name) / "hub.db"), "rag_enabled": False}}
        hub = MemoryHub(cfg, long_memory=None)
        try:
            hub.ensure_person_for_account(
                platform="discord",
                platform_user_id="999",
                handle="temp",
                display_name="Temp",
            )
            assert len(hub.list_people()) == 1
            hub.wipe(["people"], backup_dir=Path(td.name) / "backups")
            assert hub.list_people() == []
            pdb = PeopleDB(cfg)
            pdb.memory_hub = hub
            assert pdb.hydrate_from_hub(hub) == 0
            assert pdb._cache == {}
        finally:
            hub.sqlite.close()
    finally:
        td.cleanup()


if __name__ == "__main__":
    test_people_seed_module_gone()
    test_empty_hub_stays_empty_after_hydrate()
    test_wipe_then_hydrate_stays_empty()
    print("OK test_people_no_seed_offline")
