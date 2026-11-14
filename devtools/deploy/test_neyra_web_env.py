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
    # AR-23/AR-36: web-ключ — свой (сгенерирован в API_WEB_TOKEN), admin-ключ —
    # maint, а не admin API_TOKEN. Старого общего ключа больше нет.
    assert web_values["NEYRA_WEB_KEY"] == core_values["API_WEB_TOKEN"]
    assert web_values["NEYRA_WEB_KEY"] != core_values["API_MAINT_TOKEN"]
    assert web_values["NEYRA_ADMIN_KEY"] == "core-maint-key"
    assert web_values["NEYRA_ADMIN_KEY"] != core_values["API_TOKEN"]
    assert "NEYRA_SERVICE_KEY" not in web_values

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


def test_web_and_admin_keys_are_separate(tmp_path: Path) -> None:
    web = make_env(
        tmp_path,
        "web",
        "DATABASE_URL='postgres://x'\n"
        "BETTER_AUTH_SECRET='secret-0123456789abcdef0123456789abcdef'\n",  # gitleaks:allow — фиктивная фикстура теста
    )
    core = make_env(
        tmp_path,
        "core",
        "API_TOKEN='core-service-key'\n"  # gitleaks:allow — фиктивная фикстура теста
        "API_MAINT_TOKEN='core-maint-key'\n"  # gitleaks:allow — фиктивная фикстура теста
        "API_WEB_TOKEN='core-web-key'\n",  # gitleaks:allow — фиктивная фикстура теста
    )

    result = run_sync(tmp_path, web, core)
    assert result.returncode == 0, result.stderr
    values = read_env(web)
    assert values["NEYRA_WEB_KEY"] == "core-web-key"
    assert values["NEYRA_ADMIN_KEY"] == "core-maint-key"
    assert "NEYRA_SERVICE_KEY" not in values


def test_missing_web_token_is_generated_for_the_core(tmp_path: Path) -> None:
    web = make_env(
        tmp_path,
        "web",
        "DATABASE_URL='postgres://x'\n"
        "BETTER_AUTH_SECRET='secret-0123456789abcdef0123456789abcdef'\n",  # gitleaks:allow — фиктивная фикстура теста
    )
    core = make_env(
        tmp_path,
        "core",
        "API_TOKEN='core-service-key'\n"  # gitleaks:allow — фиктивная фикстура теста
        "API_MAINT_TOKEN='core-maint-key'\n",  # gitleaks:allow — фиктивная фикстура теста
    )
    result = run_sync(tmp_path, web, core)
    assert result.returncode == 0, result.stderr
    core_values = read_env(core)
    values = read_env(web)
    assert core_values["API_WEB_TOKEN"]
    assert len(core_values["API_WEB_TOKEN"]) >= 32
    assert values["NEYRA_WEB_KEY"] == core_values["API_WEB_TOKEN"]
    assert values["NEYRA_ADMIN_KEY"] == "core-maint-key"
    assert values["NEYRA_WEB_KEY"] != values["NEYRA_ADMIN_KEY"]


def test_legacy_shared_key_is_removed(tmp_path: Path) -> None:
    web = make_env(
        tmp_path,
        "web",
        "DATABASE_URL='postgres://x'\n"
        "BETTER_AUTH_SECRET='secret-0123456789abcdef0123456789abcdef'\n"  # gitleaks:allow — фиктивная фикстура теста
        "NEYRA_SERVICE_KEY='old-shared-key'\n",  # gitleaks:allow — фиктивная фикстура теста
    )
    core = make_env(
        tmp_path,
        "core",
        "API_MAINT_TOKEN='core-maint-key'\nAPI_WEB_TOKEN='core-web-key'\n",  # gitleaks:allow — фиктивная фикстура теста
    )
    result = run_sync(tmp_path, web, core)
    assert result.returncode == 0, result.stderr
    assert "NEYRA_SERVICE_KEY" not in read_env(web)


def test_missing_maint_token_never_falls_back_to_admin_token(tmp_path: Path) -> None:
    web = make_env(
        tmp_path,
        "web",
        "DATABASE_URL='postgres://x'\n"
        "BETTER_AUTH_SECRET='secret-0123456789abcdef0123456789abcdef'\n",  # gitleaks:allow — фиктивная фикстура теста
    )
    core = make_env(
        tmp_path,
        "core",
        "API_TOKEN='core-service-key'\n"  # gitleaks:allow — фиктивная фикстура теста
        "NEYRA_IDENTITY_JWT_SECRET='shared-secret-0123456789abcdef0123456789abcd'\n"
        "NEYRA_IDENTITY_JWT_ISSUER='neyra-web'\n",
    )
    result = run_sync(tmp_path, web, core)
    # AR-38: admin-токен API_TOKEN в интернет-сервис не попадает даже как fallback.
    assert result.returncode == 2
    assert "API_MAINT_TOKEN" in result.stderr
    assert "API_TOKEN сайту не передаётся" in result.stderr
    values = read_env(web)
    assert "NEYRA_ADMIN_KEY" not in values
    assert values["NEYRA_WEB_KEY"]


def test_matching_web_and_admin_keys_are_refused(tmp_path: Path) -> None:
    original = (
        "DATABASE_URL='postgres://x'\n"
        "BETTER_AUTH_SECRET='secret-0123456789abcdef0123456789abcdef'\n"  # gitleaks:allow — фиктивная фикстура теста
    )
    web = make_env(tmp_path, "web", original)
    core = make_env(
        tmp_path,
        "core",
        "API_MAINT_TOKEN='same-key'\n"  # gitleaks:allow — фиктивная фикстура теста
        "API_WEB_TOKEN='same-key'\n",  # gitleaks:allow — фиктивная фикстура теста
    )
    result = run_sync(tmp_path, web, core)
    assert result.returncode == 1
    assert "совпадает с API_MAINT_TOKEN" in result.stderr
    # Отказ до записи: ни ключей, ни остальных NEYRA_* в .env сайта нет.
    assert web.read_text(encoding="utf-8") == original
    core_values = read_env(core)
    assert core_values["API_WEB_TOKEN"] == "same-key"
    assert core_values["API_MAINT_TOKEN"] == "same-key"
