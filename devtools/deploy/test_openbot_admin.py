"""Тесты root-хелпера openbot-admin и раскладки дампов (AR-27).

Запуск: pytest -q devtools/deploy/test_openbot_admin.py
Хелпер запускается под `unshare -r` (root в user-namespace) с подставным
`docker`: так проверяются порядок сервисов postgres → db и безопасная запись
дампа без root на настоящей площадке. Если user-namespace недоступны, тесты
выполнения пропускаются, статические проверки скриптов остаются.
"""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
HELPER = HERE / "openbot-admin"
DEPLOY = HERE / "deploy-web.sh"
SETUP = HERE / "neyra-web-setup.sh"

FAKE_DOCKER = """#!/bin/sh
echo "$*" >> "$DOCKER_LOG"
svc=""
while [ $# -gt 0 ]; do
  case "$1" in
    -f) shift 2 ;;
    -T) shift ;;
    exec) shift; [ "$1" = "-T" ] && shift; svc="$1"; shift; break ;;
    *) shift ;;
  esac
done
case "$1" in
  pg_isready)
    [ -z "${DB_OK_SERVICE:-}" ] && exit 0
    [ "$svc" = "$DB_OK_SERVICE" ] && exit 0
    exit 1 ;;
  pg_dump)
    if [ -n "${DUMP_FAIL:-}" ]; then exit 1; fi
    printf 'PGDUMP-CONTENT' ;;
  *) exit 0 ;;
esac
"""

FAKE_DATE = """#!/bin/sh
printf '20240102-030405\\n'
"""


def _userns_works() -> bool:
    if not shutil.which("unshare"):
        return False
    probe = subprocess.run(["unshare", "-r", "--", "true"], capture_output=True)
    return probe.returncode == 0


requires_userns = pytest.mark.skipif(not _userns_works(), reason="user namespaces недоступны")


def run_helper(tmp_path: Path, backup_dir: Path, *, ok_service: str = "", fake_date: bool = False,
               extra_env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    docker = bin_dir / "docker"
    docker.write_text(FAKE_DOCKER, encoding="utf-8")
    docker.chmod(0o755)
    if fake_date:
        date = bin_dir / "date"
        date.write_text(FAKE_DATE, encoding="utf-8")
        date.chmod(0o755)

    compose = tmp_path / "docker-compose.yml"
    compose.write_text("services:\n  postgres:\n    image: postgres:16\n", encoding="utf-8")
    log = tmp_path / "docker.log"
    log.write_text("", encoding="utf-8")

    env = {
        **os.environ,
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
        "DOCKER_LOG": str(log),
        "NEYRA_COMPOSE_FILE": str(compose),
        "NEYRA_BACKUP_DIR": str(backup_dir),
        "NEYRA_KEEP_DUMPS": "10",
        "DB_OK_SERVICE": ok_service,
        **(extra_env or {}),
    }
    return subprocess.run(
        ["unshare", "-r", "--", "bash", str(HELPER), "db-dump"],
        env=env, capture_output=True, text=True, timeout=60,
    )


def dump_path(result: subprocess.CompletedProcess) -> Path:
    for line in result.stdout.splitlines():
        if line.startswith("path="):
            return Path(line.removeprefix("path="))
    raise AssertionError(f"нет path= в выводе: {result.stdout}\n{result.stderr}")


@requires_userns
def test_dump_safe_file_and_service_order(tmp_path: Path) -> None:
    backup = tmp_path / "backups"
    result = run_helper(tmp_path, backup, ok_service="db")
    assert result.returncode == 0, result.stderr

    calls = (tmp_path / "docker.log").read_text(encoding="utf-8").splitlines()
    assert "exec -T postgres pg_isready" in calls[0]
    assert "exec -T db pg_isready" in calls[1]
    assert "exec -T db pg_dump" in calls[2]
    assert len(calls) == 3

    dump = dump_path(result)
    assert dump.parent == backup
    assert dump.read_text(encoding="utf-8") == "PGDUMP-CONTENT"
    mode = dump.stat().st_mode & 0o777
    assert mode == 0o600, oct(mode)
    assert not dump.is_symlink()
    dir_mode = backup.stat().st_mode & 0o777
    assert dir_mode == 0o700, oct(dir_mode)
    assert "size=14" in result.stdout


@requires_userns
def test_postgres_used_first_when_it_answers(tmp_path: Path) -> None:
    backup = tmp_path / "backups"
    result = run_helper(tmp_path, backup, ok_service="postgres")
    assert result.returncode == 0, result.stderr
    calls = (tmp_path / "docker.log").read_text(encoding="utf-8").splitlines()
    assert "exec -T postgres pg_isready" in calls[0]
    assert "exec -T postgres pg_dump" in calls[1]
    assert len(calls) == 2


@requires_userns
def test_refuses_symlinked_backup_dir(tmp_path: Path) -> None:
    victim = tmp_path / "victim"
    victim.mkdir()
    link = tmp_path / "backups-link"
    link.symlink_to(victim)

    result = run_helper(tmp_path, link, ok_service="postgres")
    assert result.returncode != 0
    assert "символическая ссылка" in result.stderr
    assert list(victim.iterdir()) == []


@requires_userns
def test_predictable_name_symlink_is_replaced_not_followed(tmp_path: Path) -> None:
    backup = tmp_path / "backups"
    backup.mkdir()
    victim = tmp_path / "victim.txt"
    victim.write_text("не трогать", encoding="utf-8")
    # Имя, которое хелпер возьмёт: фиксированная дата из подставного `date`.
    (backup / "pre-migrate-20240102-030405.dump").symlink_to(victim)

    result = run_helper(tmp_path, backup, ok_service="postgres", fake_date=True)
    assert result.returncode == 0, result.stderr
    assert victim.read_text(encoding="utf-8") == "не трогать"
    dump = dump_path(result)
    assert not dump.is_symlink()
    assert dump.read_text(encoding="utf-8") == "PGDUMP-CONTENT"


@requires_userns
def test_rotation_keeps_last_dumps(tmp_path: Path) -> None:
    backup = tmp_path / "backups"
    backup.mkdir()
    for index in range(12):
        (backup / f"pre-migrate-20240101-0000{index:02d}.dump").write_text("old", encoding="utf-8")

    result = run_helper(tmp_path, backup, ok_service="postgres")
    assert result.returncode == 0, result.stderr
    dumps = sorted(backup.glob("pre-migrate-*.dump"))
    assert len(dumps) == 10
    assert dump_path(result) in dumps


@requires_userns
def test_empty_dump_fails(tmp_path: Path) -> None:
    backup = tmp_path / "backups"
    result = run_helper(tmp_path, backup, ok_service="postgres", extra_env={"DUMP_FAIL": "1"})
    assert result.returncode != 0
    assert "pg_dump не выполнился" in result.stderr
    assert list(backup.glob("pre-migrate-*.dump")) == []


def test_setup_keeps_compose_and_backups_root_owned() -> None:
    text = SETUP.read_text(encoding="utf-8")
    for line in text.splitlines():
        if line.lstrip().startswith("chown"):
            assert "docker-compose.yml" not in line, line
    assert 'chown root:root "$WEB/backups"' in text
    assert 'chmod 0700 "$WEB/backups"' in text
    assert '/usr/local/sbin/openbot-admin db-dump' in text
    assert '[ ! -L "$dir" ]' in text


def test_deploy_fallback_is_symlink_safe_and_ordered() -> None:
    text = DEPLOY.read_text(encoding="utf-8")
    assert 'DUMP_TMP="$(mktemp' in text
    assert 'mv -f "$DUMP_TMP" "$DUMP"' in text
    assert "backups-app" in text
    assert "for pg_service in postgres db" in text
