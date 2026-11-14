"""Тесты проверки data_dir вне каталога выкладки (AR-29).

Запуск: pytest -q devtools/deploy/test_data_dir.py
Используется временный «сервер» с копией core/runtime/paths.py и подставным
config_loader: проверяется, что check-data-dir.py загружает .env как ядро,
резолвит NEYRA_DATA_DIR и paths.data_dir как ядро и отказывает, когда данные
лежат вне выкладки или конфиг не читается.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "check-data-dir.py"
REPO_RUNTIME = HERE.parent.parent / "server" / "core" / "runtime"

CONFIG_LOADER = """import json, pathlib
def load_layered_config(root, validate=True):
    p = pathlib.Path(root) / 'paths.json'
    if (pathlib.Path(root) / 'broken').exists():
        raise ValueError('config schema validation failed: broken')
    return json.loads(p.read_text()) if p.exists() else {}
"""


def make_root(tmp_path: Path) -> Path:
    root = tmp_path / "srv"
    runtime = root / "core" / "runtime"
    runtime.mkdir(parents=True)
    (root / "core" / "__init__.py").write_text("", encoding="utf-8")
    (runtime / "__init__.py").write_text("", encoding="utf-8")
    shutil.copy(REPO_RUNTIME / "paths.py", runtime / "paths.py")
    shutil.copy(REPO_RUNTIME / "secrets.py", runtime / "secrets.py")
    (runtime / "config_loader.py").write_text(CONFIG_LOADER, encoding="utf-8")
    return root


def run(root: Path, data_dir: str | None = None) -> subprocess.CompletedProcess:
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    env.pop("NEYRA_DATA_DIR", None)
    if data_dir is not None:
        env["NEYRA_DATA_DIR"] = data_dir
    return subprocess.run([sys.executable, str(SCRIPT), str(root)],
                          env=env, capture_output=True, text=True, timeout=30)


def test_default_data_dir_is_inside(tmp_path: Path) -> None:
    root = make_root(tmp_path)
    result = run(root)
    assert result.returncode == 0, result.stderr
    assert Path(result.stdout.strip()) == (root / "data").resolve()


def test_paths_data_dir_relative_is_inside(tmp_path: Path) -> None:
    root = make_root(tmp_path)
    (root / "paths.json").write_text(json.dumps({"paths": {"data_dir": "./custom"}}), encoding="utf-8")
    result = run(root)
    assert result.returncode == 0, result.stderr
    assert Path(result.stdout.strip()) == (root / "custom").resolve()


def test_env_data_dir_inside_is_allowed(tmp_path: Path) -> None:
    root = make_root(tmp_path)
    result = run(root, data_dir=str(root / "other-data"))
    assert result.returncode == 0, result.stderr
    assert Path(result.stdout.strip()) == (root / "other-data").resolve()


def test_env_data_dir_outside_fails(tmp_path: Path) -> None:
    root = make_root(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    result = run(root, data_dir=str(outside))
    assert result.returncode == 3
    assert "вне каталога выкладки" in result.stderr


def test_paths_data_dir_absolute_outside_fails(tmp_path: Path) -> None:
    root = make_root(tmp_path)
    outside = tmp_path / "elsewhere"
    (root / "paths.json").write_text(json.dumps({"paths": {"data_dir": str(outside)}}), encoding="utf-8")
    result = run(root)
    assert result.returncode == 3
    assert "вне каталога выкладки" in result.stderr


def test_dotenv_data_dir_outside_is_seen(tmp_path: Path) -> None:
    root = make_root(tmp_path)
    outside = tmp_path / "dotenv-outside"
    outside.mkdir()
    (root / ".env").write_text(f"NEYRA_DATA_DIR={outside}\n", encoding="utf-8")
    result = run(root)
    assert result.returncode == 3
    assert str(outside.resolve()) in result.stderr


def test_dotenv_data_dir_inside_is_allowed(tmp_path: Path) -> None:
    root = make_root(tmp_path)
    (root / ".env").write_text("NEYRA_DATA_DIR=./from-dotenv\n", encoding="utf-8")
    result = run(root)
    assert result.returncode == 0, result.stderr
    assert Path(result.stdout.strip()) == (root / "from-dotenv").resolve()


def test_config_error_fails_instead_of_default(tmp_path: Path) -> None:
    root = make_root(tmp_path)
    (root / "broken").write_text("", encoding="utf-8")
    result = run(root)
    assert result.returncode == 4
    assert "не удалось прочитать конфиг ядра" in result.stderr
    assert result.stdout.strip() == ""


def test_update_core_checks_data_dir_before_vault() -> None:
    text = (HERE / "update-core.sh").read_text(encoding="utf-8")
    check = text.index("check-data-dir.py")
    vault = text.index("== 4/7 vault key")
    assert check < vault
    assert "data_dir вне $DEST" in text
