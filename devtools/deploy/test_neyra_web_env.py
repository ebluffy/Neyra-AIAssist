"""Тесты neyra-web-env.py на копиях .env (без площадки, без root).

Запуск: pytest -q devtools/deploy/test_neyra_web_env.py
Проверяет связку identity (секрет + issuer, #73) между .env ядра и сайта:
issuer по умолчанию neyra-web, заданное непустое не перезаписывается,
расхождение приводится к ядру, повторный запуск идемпотентен.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "neyra-web-env.py"


def run_sync(tmp_path: Path, web_env: Path, core_env: Path) -> subprocess.CompletedProcess:
    env = {
        **os.environ,
        "WEB": str(web_env.parent),
        "CORE": str(core_env.parent),
    }
    return subprocess.run(
        [sys.executable, str(SCRIPT)],
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )


def read_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in line:
            continue
        key, _, raw = line.partition("=")
        values[key.strip()] = raw.strip().strip("'").strip('"')
    return values


def make_env(tmp_path: Path, name: str, content: str) -> Path:
    path = tmp_path / name / ".env"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


def test_issuer_defaults_to_neyra_web_in_both_envs(tmp_path: Path) -> None:
    web = make_env(
        tmp_path,
        "web",
        "DATABASE_URL='postgres://x'\n"
        "BETTER_AUTH_SECRET='secret-0123456789abcdef0123456789abcdef'\n",  # gitleaks:allow — фиктивная фикстура теста
    )
    core = make_env(tmp_path, "core", "API_TOKEN='core-service-key'\nAPI_MAINT_TOKEN='core-maint-key'\n")  # gitleaks:allow — фиктивная фикстура теста

    first = run_sync(tmp_path, web, core)
    assert first.returncode == 0, first.stderr

    web_values = read_env(web)
    core_values = read_env(core)
    # Один issuer на оба .env, по умолчанию neyra-web; секреты совпадают.
    assert web_values["NEYRA_IDENTITY_JWT_ISSUER"] == "neyra-web"
    assert core_values["NEYRA_IDENTITY_JWT_ISSUER"] == "neyra-web"
    assert web_values["NEYRA_IDENTITY_JWT_SECRET"] == core_values["NEYRA_IDENTITY_JWT_SECRET"]
    # Сайту передаётся maint-ключ, а не админский API_TOKEN (AR-16).
    assert web_values["NEYRA_SERVICE_KEY"] == "core-maint-key"
    assert web_values["NEYRA_SERVICE_KEY"] != core_values["API_TOKEN"]

    # Повторный запуск идемпотентен: файлы не меняются.
    web_before = web.read_text(encoding="utf-8")
    core_before = core.read_text(encoding="utf-8")
    second = run_sync(tmp_path, web, core)
    assert second.returncode == 0, second.stderr
    assert web.read_text(encoding="utf-8") == web_before
    assert core.read_text(encoding="utf-8") == core_before


def test_existing_matching_issuer_is_not_rewritten(tmp_path: Path) -> None:
    web = make_env(
        tmp_path,
        "web",
        "DATABASE_URL='postgres://x'\n"
        "BETTER_AUTH_SECRET='secret-0123456789abcdef0123456789abcdef'\n"  # gitleaks:allow — фиктивная фикстура теста
        "NEYRA_IDENTITY_JWT_ISSUER='custom-issuer'\n",
    )
    core = make_env(
        tmp_path,
        "core",
        "API_TOKEN='core-service-key'\nAPI_MAINT_TOKEN='core-maint-key'\n"  # gitleaks:allow — фиктивная фикстура теста
        "NEYRA_IDENTITY_JWT_SECRET='shared-secret-0123456789abcdef0123456789abcd'\n"  # gitleaks:allow — фиктивная фикстура теста
        "NEYRA_IDENTITY_JWT_ISSUER='custom-issuer'\n",
    )
    result = run_sync(tmp_path, web, core)
    assert result.returncode == 0, result.stderr
    # Совпадающий issuer не перезаписан (секрет сайта при этом выравнивается ядру — это ок).
    assert read_env(web)["NEYRA_IDENTITY_JWT_ISSUER"] == "custom-issuer"
    # После первой синхронизации повторный запуск — побайтовый noop.
    web_before = web.read_text(encoding="utf-8")
    second = run_sync(tmp_path, web, core)
    assert second.returncode == 0, second.stderr
    assert web.read_text(encoding="utf-8") == web_before


def test_mismatched_web_issuer_is_brought_to_core_with_warning(tmp_path: Path) -> None:
    web = make_env(
        tmp_path,
        "web",
        "DATABASE_URL='postgres://x'\n"
        "BETTER_AUTH_SECRET='secret-0123456789abcdef0123456789abcdef'\n"  # gitleaks:allow — фиктивная фикстура теста
        "NEYRA_IDENTITY_JWT_ISSUER='old-issuer'\n",
    )
    core = make_env(
        tmp_path,
        "core",
        "API_TOKEN='core-service-key'\nAPI_MAINT_TOKEN='core-maint-key'\n"  # gitleaks:allow — фиктивная фикстура теста
        "NEYRA_IDENTITY_JWT_SECRET='shared-secret-0123456789abcdef0123456789abcd'\n"  # gitleaks:allow — фиктивная фикстура теста
        "NEYRA_IDENTITY_JWT_ISSUER='core-issuer'\n",
    )

    result = run_sync(tmp_path, web, core)
    assert result.returncode == 0, result.stderr
    assert "issuer" in result.stderr  # предупреждение о расхождении
    web_values = read_env(web)
    assert web_values["NEYRA_IDENTITY_JWT_ISSUER"] == "core-issuer"

    # Повторный запуск идемпотентен и уже без предупреждений.
    second = run_sync(tmp_path, web, core)
    assert second.returncode == 0, second.stderr
    assert "issuer" not in second.stderr


def test_web_only_issuer_is_adopted_by_core(tmp_path: Path) -> None:
    web = make_env(
        tmp_path,
        "web",
        "DATABASE_URL='postgres://x'\n"
        "BETTER_AUTH_SECRET='secret-0123456789abcdef0123456789abcdef'\n"  # gitleaks:allow — фиктивная фикстура теста
        "NEYRA_IDENTITY_JWT_ISSUER='web-issuer'\n",
    )
    core = make_env(tmp_path, "core", "API_TOKEN='core-service-key'\nAPI_MAINT_TOKEN='core-maint-key'\n")  # gitleaks:allow — фиктивная фикстура теста

    result = run_sync(tmp_path, web, core)
    assert result.returncode == 0, result.stderr
    web_before = web.read_text(encoding="utf-8")
    assert read_env(core)["NEYRA_IDENTITY_JWT_ISSUER"] == "web-issuer"
    # Заданное непустое значение сайта не тронуто, повторный запуск — noop.
    second = run_sync(tmp_path, web, core)
    assert second.returncode == 0, second.stderr
    assert web.read_text(encoding="utf-8") == web_before


def test_missing_maint_token_is_not_replaced_with_admin_token(tmp_path: Path) -> None:
    web = make_env(
        tmp_path,
        "web",
        "DATABASE_URL='postgres://x'\n"
        "BETTER_AUTH_SECRET='secret-0123456789abcdef0123456789abcdef'\n",
    )
    core = make_env(
        tmp_path,
        "core",
        "API_TOKEN='core-service-key'\n"  # gitleaks:allow — фиктивная фикстура теста
        "NEYRA_IDENTITY_JWT_SECRET='shared-secret-0123456789abcdef0123456789abcd'\n"
        "NEYRA_IDENTITY_JWT_ISSUER='neyra-web'\n",
    )
    result = run_sync(tmp_path, web, core)
    assert result.returncode == 2
    assert "API_MAINT_TOKEN" in result.stderr
    values = read_env(web)
    assert "NEYRA_SERVICE_KEY" not in values
