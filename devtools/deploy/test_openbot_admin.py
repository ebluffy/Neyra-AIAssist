"""Тесты root-хелпера openbot-admin и раскладки дампов (AR-27).

Запуск: pytest -q devtools/deploy/test_openbot_admin.py
Хелпер запускается под `unshare -r` (root в user-namespace) с подставным
`docker`: проверяются порядок сервисов postgres → db, безопасная запись дампа,
права root-каталогов и отказы, если путь контролирует не root. Если
user-namespace недоступны, тесты выполнения пропускаются, статические проверки
скриптов остаются.
"""
from __future__ import annotations

import os
import shutil
import stat
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
    -p|--env-file|-f) shift 2 ;;
    -T) shift ;;
    exec) shift; [ "$1" = "-T" ] && shift; svc="$1"; shift; break ;;
    *) shift ;;
  esac
done
case "$1" in
  pg_isready)
    if [ -n "${SWAP_VICTIM:-}" ] && [ -d "$NEYRA_BACKUP_DIR" ] && [ ! -L "$NEYRA_BACKUP_DIR" ]; then
      mv "$NEYRA_BACKUP_DIR" "${NEYRA_BACKUP_DIR}.real" && ln -s "$SWAP_VICTIM" "$NEYRA_BACKUP_DIR"
    fi
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
               extra_env: dict[str, str] | None = None, compose_dir: Path | None = None,
               make_env_file: bool = True) -> subprocess.CompletedProcess:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    docker = bin_dir / "docker"
    docker.write_text(FAKE_DOCKER, encoding="utf-8")
    docker.chmod(0o755)
    if fake_date:
        date = bin_dir / "date"
        date.write_text(FAKE_DATE, encoding="utf-8")
        date.chmod(0o755)

    compose_dir = compose_dir or tmp_path
    compose = compose_dir / "docker-compose.yml"
    compose.write_text("services:\n  postgres:\n    image: postgres:16\n", encoding="utf-8")
    compose_env = compose_dir / "db.env"
    if make_env_file:
        compose_env.write_text("POSTGRES_USER=neyra\nPOSTGRES_PASSWORD=x\nPOSTGRES_DB=neyra_web\n",
                               encoding="utf-8")
        compose_env.chmod(0o600)
    log = tmp_path / "docker.log"
    log.write_text("", encoding="utf-8")

    env = {
        **os.environ,
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
        "DOCKER_LOG": str(log),
        "NEYRA_COMPOSE_FILE": str(compose),
        "NEYRA_COMPOSE_ENV_FILE": str(compose_env),
        "NEYRA_COMPOSE_PROJECT": "web",
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


def writable_for_group(path: Path) -> None:
    path.chmod(0o777)


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
    # Явные параметры compose: свой проект и root-овый env-файл.
    assert "-p web" in calls[0]
    assert "--env-file" in calls[0]

    dump = dump_path(result)
    assert dump.parent == backup
    assert dump.read_text(encoding="utf-8") == "PGDUMP-CONTENT"
    assert stat.S_IMODE(dump.stat().st_mode) == 0o600
    assert not dump.is_symlink()
    assert stat.S_IMODE(backup.stat().st_mode) == 0o700
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
def test_refuses_backup_parent_writable_by_group(tmp_path: Path) -> None:
    parent = tmp_path / "openbot-owned"
    parent.mkdir()
    writable_for_group(parent)
    backup = parent / "backups"

    result = run_helper(tmp_path, backup, ok_service="postgres")
    assert result.returncode != 0
    assert "доступен на запись группе/другим" in result.stderr


@requires_userns
def test_refuses_compose_in_writable_dir(tmp_path: Path) -> None:
    compose_dir = tmp_path / "compose"
    compose_dir.mkdir()
    writable_for_group(compose_dir)
    backup = tmp_path / "backups"

    result = run_helper(tmp_path, backup, ok_service="postgres", compose_dir=compose_dir)
    assert result.returncode != 0
    assert "COMPOSE_FILE: родитель" in result.stderr


@requires_userns
def test_refuses_missing_compose_env(tmp_path: Path) -> None:
    backup = tmp_path / "backups"
    result = run_helper(tmp_path, backup, ok_service="postgres", make_env_file=False)
    assert result.returncode != 0
    assert "COMPOSE_ENV_FILE: нет файла" in result.stderr


@requires_userns
def test_backup_dir_swapped_to_symlink_after_check(tmp_path: Path) -> None:
    backup = tmp_path / "backups"
    backup.mkdir()
    victim = tmp_path / "victim"
    victim.mkdir()

    result = run_helper(tmp_path, backup, ok_service="postgres",
                        extra_env={"SWAP_VICTIM": str(victim)})
    assert result.returncode != 0
    assert "подменён после проверки" in result.stderr
    assert list(victim.iterdir()) == []
    assert list(backup.glob("pre-migrate-*.dump")) == []


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


def test_setup_keeps_root_paths_out_of_openbot_dir() -> None:
    text = SETUP.read_text(encoding="utf-8")
    assert 'BACKUP_DIR=/var/backups/neyra-web' in text
    assert 'chown root:root "$WEB" "$WEB/data"' in text
    assert 'chown -R openbot:openbot "$WEB/app" "$WEB/node"' in text
    assert "backups-app" not in text
    for line in text.splitlines():
        if line.lstrip().startswith("chown") and "openbot:openbot" in line:
            assert "docker-compose.yml" not in line, line
            assert '"$WEB"' not in line, line
    # .env — корневой файл: симлинк на его месте отвергается (AR-27).
    assert '[ ! -L "$WEB/.env" ]' in text
    assert 'chown -h root:openbot "$WEB/.env"' in text
    # Прямых root-правил docker compose в sudoers больше нет (AR-27).
    assert "NOPASSWD: /usr/bin/docker compose" not in text
    assert "/usr/local/sbin/openbot-admin db-dump" in text


def test_deploy_uses_only_the_root_helper() -> None:
    text = DEPLOY.read_text(encoding="utf-8")
    assert "sudo -n openbot-admin db-dump" in text
    assert "sudo -n docker compose" not in text
    assert "backups-app" not in text
    # Дамп пишет только хелпер: своего pre-migrate в deploy нет.
    assert "pre-migrate" not in text
