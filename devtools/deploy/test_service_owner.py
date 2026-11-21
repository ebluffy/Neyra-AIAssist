"""Behavior tests for service-owner.py (AR-133/AR-135)."""
from __future__ import annotations

import grp
import os
import pwd
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "service-owner.py"


def run_owner(tmp_path: Path, *, load: str = "loaded", user: str = "",
              group: str = "", dynamic: str = "no", omit: str = "",
              argv_log: Path | None = None) -> subprocess.CompletedProcess:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    systemctl = bin_dir / "systemctl"
    systemctl.write_text(
        "#!/usr/bin/env python3\n"
        "import os, sys\n"
        "argv = sys.argv[1:]\n"
        "log = os.environ.get('FAKE_ARGV_LOG')\n"
        "if log:\n"
        "    open(log, 'w').write('\\n'.join(argv))\n"
        "requested = [argv[i + 1] for i, item in enumerate(argv) if item == '-p' and i + 1 < len(argv)]\n"
        "props = {\n"
        "    'DynamicUser': os.environ.get('FAKE_DYNAMIC', 'no'),\n"
        "    'User': os.environ.get('FAKE_USER', ''),\n"
        "    'LoadState': os.environ.get('FAKE_LOAD', 'loaded'),\n"
        "    'Group': os.environ.get('FAKE_GROUP', ''),\n"
        "}\n"
        "omit = set(filter(None, os.environ.get('FAKE_OMIT', '').split(',')))\n"
        "for key in ('DynamicUser', 'User', 'LoadState', 'Group'):\n"
        "    if key in requested and key not in omit:\n"
        "        print(props[key] if '--value' in argv else f'{key}={props[key]}')\n",
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
        "FAKE_OMIT": omit,
        "FAKE_ARGV_LOG": str(argv_log or ""),
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
    argv_log = tmp_path / "argv"
    result = run_owner(tmp_path, user=me.pw_name, argv_log=argv_log)
    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines() == [me.pw_name, primary, me.pw_dir]
    argv = argv_log.read_text(encoding="utf-8").splitlines()
    assert "--value" not in argv
    assert argv.count("-p") == 4
    assert {"LoadState", "User", "Group", "DynamicUser"} <= set(argv)


@pytest.mark.skipif(not shutil.which("systemctl"), reason="systemd недоступен")
def test_real_systemd_unit() -> None:
    probe = subprocess.run(
        ["systemctl", "show", "-p", "LoadState", "--value", "systemd-journald.service"],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if probe.returncode != 0 or probe.stdout.strip() != "loaded":
        pytest.skip("systemd-journald.service не загружен")
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "systemd-journald.service"],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert len(result.stdout.splitlines()) == 3


def test_empty_user_is_root(tmp_path: Path) -> None:
    result = run_owner(tmp_path)
    assert result.returncode == 0, result.stderr
    root = pwd.getpwnam("root")
    assert result.stdout.splitlines() == ["root", grp.getgrgid(root.pw_gid).gr_name, root.pw_dir]


def test_missing_property_fails(tmp_path: Path) -> None:
    result = run_owner(tmp_path, omit="Group")
    assert result.returncode == 2
    assert "нет свойств" in result.stderr


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
