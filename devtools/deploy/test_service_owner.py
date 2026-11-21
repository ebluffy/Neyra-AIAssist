"""Behavior tests for service-owner.py (AR-133/AR-135)."""
from __future__ import annotations

import grp
import os
import pwd
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "service-owner.py"


def run_owner(tmp_path: Path, *, load: str = "loaded", user: str = "",
              group: str = "", dynamic: str = "no") -> subprocess.CompletedProcess:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    systemctl = bin_dir / "systemctl"
    systemctl.write_text(
        "#!/bin/sh\n"
        'printf "%s\\n" "${FAKE_LOAD:-loaded}" "${FAKE_USER:-}" '
        '"${FAKE_GROUP:-}" "${FAKE_DYNAMIC:-no}"\n',
        encoding="utf-8",
    )
    systemctl.chmod(0o755)
    env = {
        **os.environ,
        "PATH": f"{bin_dir}:{os.environ.get('PATH', '')}",
        "FAKE_LOAD": load,
        "FAKE_USER": user,
        "FAKE_GROUP": group,
        "FAKE_DYNAMIC": dynamic,
    }
    return subprocess.run(
        [sys.executable, str(SCRIPT), "neyra.service"],
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )


def test_user_without_group_uses_primary_group(tmp_path: Path) -> None:
    me = pwd.getpwuid(os.getuid())
    primary = grp.getgrgid(me.pw_gid).gr_name
    result = run_owner(tmp_path, user=me.pw_name)
    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines() == [me.pw_name, primary, me.pw_dir]


def test_empty_user_is_root(tmp_path: Path) -> None:
    result = run_owner(tmp_path)
    assert result.returncode == 0, result.stderr
    root = pwd.getpwnam("root")
    assert result.stdout.splitlines() == ["root", grp.getgrgid(root.pw_gid).gr_name, root.pw_dir]


def test_missing_unit_fails(tmp_path: Path) -> None:
    result = run_owner(tmp_path, load="not-found")
    assert result.returncode == 2
    assert "не загружен" in result.stderr


def test_dynamic_user_fails(tmp_path: Path) -> None:
    me = pwd.getpwuid(os.getuid())
    result = run_owner(tmp_path, user=me.pw_name, dynamic="yes")
    assert result.returncode == 3
    assert "DynamicUser" in result.stderr


def test_unknown_user_fails(tmp_path: Path) -> None:
    result = run_owner(tmp_path, user="neyra-no-such-user")
    assert result.returncode == 4
    assert "не найден" in result.stderr


def test_unknown_group_fails(tmp_path: Path) -> None:
    me = pwd.getpwuid(os.getuid())
    result = run_owner(tmp_path, user=me.pw_name, group="neyra-no-such-group")
    assert result.returncode == 5
    assert "не найдена" in result.stderr


def test_numeric_user_and_group_are_resolved(tmp_path: Path) -> None:
    me = pwd.getpwuid(os.getuid())
    primary = grp.getgrgid(me.pw_gid)
    result = run_owner(tmp_path, user=str(me.pw_uid), group=str(primary.gr_gid))
    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines()[:2] == [me.pw_name, primary.gr_name]
