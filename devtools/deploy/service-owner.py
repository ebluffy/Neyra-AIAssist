#!/usr/bin/env python3
"""Resolve the owner of a systemd service for update-core.sh.

Prints three lines: user, group, home. Fails instead of silently falling back
to root when the unit is missing, dynamic, or names an unknown account.
"""
from __future__ import annotations

import grp
import pwd
import subprocess
import sys


def fail(message: str, code: int) -> int:
    print(message, file=sys.stderr)
    return code


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        return fail("usage: service-owner.py <service>", 64)
    service = argv[1]
    try:
        result = subprocess.run(
            [
                "systemctl",
                "show",
                "-p",
                "LoadState",
                "-p",
                "User",
                "-p",
                "Group",
                "-p",
                "DynamicUser",
                service,
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError) as error:
        return fail(f"systemctl не выполнился для {service}: {error}", 2)
    if result.returncode != 0:
        return fail(
            f"systemctl show {service} завершился с кодом {result.returncode}: "
            f"{result.stderr.strip()}",
            2,
        )
    props: dict[str, str] = {}
    for line in result.stdout.splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            props[key.strip()] = value.strip()
    missing = {"LoadState", "User", "Group", "DynamicUser"} - props.keys()
    if missing:
        return fail(f"systemctl show {service}: нет свойств {sorted(missing)}", 2)
    load = props["LoadState"]
    raw_user = props["User"]
    raw_group = props["Group"]
    dynamic = props["DynamicUser"]
    if load != "loaded":
        return fail(f"юнит {service} не загружен: LoadState={load or 'empty'}", 2)
    if dynamic.lower() in {"yes", "true", "1"}:
        return fail(f"юнит {service} использует DynamicUser=yes: владелец нестабилен", 3)

    user = raw_user or "root"
    try:
        if user.isdigit():
            entry = pwd.getpwuid(int(user))
            user = entry.pw_name
        else:
            entry = pwd.getpwnam(user)
    except KeyError:
        return fail(f"пользователь сервиса '{user}' не найден", 4)

    group = raw_group
    if not group:
        group = grp.getgrgid(entry.pw_gid).gr_name
    else:
        try:
            if group.isdigit():
                group = grp.getgrgid(int(group)).gr_name
            else:
                grp.getgrnam(group)
        except KeyError:
            return fail(f"группа сервиса '{group}' не найдена", 5)

    home = entry.pw_dir or "/tmp"
    print(user)
    print(group)
    print(home)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
