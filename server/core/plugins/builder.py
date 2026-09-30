from __future__ import annotations

import logging
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from core.plugins.loader import PluginLoader

logger = logging.getLogger("neyra.plugin_builder")


@dataclass(frozen=True)
class PluginBuilderSettings:
    """
    Личный tool: минимальные настройки прямо в файле (без config.yaml).

    Приоритет ключа:
    1) api_key (в аргументах tool-call)
    2) OPENROUTER_API_KEY из .env / окружения
    """

    # OpenRouter OpenAI-compatible endpoint
    base_url: str = "https://openrouter.ai/api/v1"
    # Минимально-адекватная дефолтная модель для код-генерации. Меняй здесь при необходимости.
    model: str = "tencent/hy3-preview:free"
    # Защита: блокируем изменение этих плагинов из tool-а
    plugin_blacklist: tuple[str, ...] = ("discord",)


def _repo_root() -> Path:
    # core/plugins/builder.py → parents[2] = repo root
    return Path(__file__).resolve().parents[2]


def _modules_dir(root: Path) -> Path:
    return (root / "modules").resolve()


def _normalize_plugin_id(plugin_id: str) -> str:
    return (plugin_id or "").strip().lower()


def _path_jail_check(abs_path: Path, allowed_root: Path) -> None:
    """
    Разрешаем запись строго внутри allowed_root.
    """

    abs_path = abs_path.resolve()
    allowed_root = allowed_root.resolve()
    try:
        abs_path.relative_to(allowed_root)
    except Exception as e:
        raise PermissionError(f"Path jail violation: {abs_path} is outside {allowed_root}") from e


def _normalize_rel_path(rel: str, *, plugin_id: str) -> str:
    """
    Нормализует путь, который вернула модель, к относительному пути ВНУТРИ plugin_dir.

    Фикс для бага "матрёшки": если модель вернула `modules/<id>/main.py` или `<id>/main.py`,
    мы выкидываем этот префикс, чтобы не писать в `modules/<id>/modules/<id>/...`.
    """

    s = (rel or "").replace("\\", "/").strip()
    s = s.lstrip("/")
    if not s:
        return ""

    pid = (plugin_id or "").strip().lower()

    # Запрещаем любые попытки traversal на уровне сегментов.
    parts = [p for p in s.split("/") if p not in ("", ".")]
    if any(p == ".." for p in parts):
        raise PermissionError("Path traversal is not allowed")

    # Срезаем частые "ошибочные" префиксы от модели.
    # 1) modules/<pid>/...
    if len(parts) >= 2 and parts[0].lower() == "modules" and parts[1].lower() == pid:
        parts = parts[2:]
    # 2) <pid>/...
    elif len(parts) >= 1 and parts[0].lower() == pid:
        parts = parts[1:]
    # 3) modules/...
    elif len(parts) >= 1 and parts[0].lower() == "modules":
        # Если модель вернула просто modules/main.py — это невалидно для нашего tool-а
        raise PermissionError("Path must be relative to modules/<plugin_id>/ (no 'modules/' prefix)")

    if not parts:
        return ""

    return "/".join(parts)


def _openrouter_key(explicit_key: str | None) -> str | None:
    k = (explicit_key or "").strip()
    if k:
        return k
    k = (os.getenv("OPENROUTER_API_KEY") or "").strip()
    return k or None


def _call_openrouter_chat(
    *,
    settings: PluginBuilderSettings,
    api_key: str,
    system: str,
    user: str,
    timeout_s: float = 120.0,
) -> str:
    url = f"{settings.base_url.rstrip('/')}/chat/completions"
    logger.info("PluginBuilder: call OpenRouter coder | model=%s", settings.model)
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        # Рекомендованные заголовки OpenRouter (не обязательны)
        "HTTP-Referer": "https://github.com/KORESHon/Neyra-AIAssist",
        "X-Title": "Neyra Plugin Builder Tool",
    }
    payload = {
        "model": settings.model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": 0.2,
    }
    with httpx.Client(timeout=timeout_s) as client:
        r = client.post(url, headers=headers, json=payload)
        r.raise_for_status()
        data = r.json()
    try:
        return data["choices"][0]["message"]["content"]
    except Exception:
        return json.dumps(data, ensure_ascii=False)


def create_or_edit_plugin_impl(
    *,
    plugin_id: str,
    task: str,
    api_key: str | None = None,
    settings: PluginBuilderSettings | None = None,
) -> dict[str, Any]:
    """
    Генерирует/правит файлы плагина внутри modules/<plugin_id>.

    Возвращает структурированный результат (дикт), чтобы агент мог кратко пересказать.
    """

    settings = settings or PluginBuilderSettings()
    pid = _normalize_plugin_id(plugin_id)
    if not pid:
        return {"ok": False, "error": "plugin_id is empty"}
    if pid in set(settings.plugin_blacklist):
        return {"ok": False, "error": f"Access denied: plugin '{pid}' is blacklisted"}

    root = _repo_root()
    modules = _modules_dir(root)
    plugin_dir = (modules / pid).resolve()
    _path_jail_check(plugin_dir, modules)

    key = _openrouter_key(api_key)
    if not key:
        return {"ok": False, "error": "OpenRouter API key missing (api_key arg or OPENROUTER_API_KEY env)"}

    loader = PluginLoader(root=root)
    existed = plugin_dir.exists()
    logger.info("PluginBuilder: start | plugin_id=%s existed=%s", pid, existed)
    backup_ok = False
    backup_path = None
    if existed:
        backup_ok, backup_path = loader.create_plugin_backup(pid)
        logger.info("PluginBuilder: backup | ok=%s path=%s", backup_ok, backup_path)

    # Подготовим минимальный контекст: существующие файлы (только верхний уровень, без рекурсии).
    existing_files: dict[str, str] = {}
    if existed:
        try:
            for p in sorted(plugin_dir.glob("*.py")):
                existing_files[p.name] = p.read_text(encoding="utf-8", errors="replace")[:20000]
            for p in sorted(plugin_dir.glob("*.yaml")):
                existing_files[p.name] = p.read_text(encoding="utf-8", errors="replace")[:20000]
            for p in sorted(plugin_dir.glob("*.md")):
                existing_files[p.name] = p.read_text(encoding="utf-8", errors="replace")[:20000]
        except Exception:
            # не критично — просто без контекста
            existing_files = {}

    system = (
        "Ты — инженер по плагинам проекта Neyra.\n"
        "Нужно сгенерировать изменения плагина в modules/<plugin_id>.\n"
        "ВЫХОД СТРОГО: JSON вида {\"files\": [{\"path\": \"relative/path\", \"content\": \"...\"}], \"notes\": \"...\"}.\n"
        "Запрещено менять что-либо вне modules/<plugin_id>.\n"
        "Не трогай плагины: discord.\n"
        "ВАЖНО: Все пути files[].path должны быть ОТНОСИТЕЛЬНЫМИ к корню плагина (НЕ включать modules/<id>/).\n"
        "Если создаёшь новый плагин: добавь modules/<plugin_id>/plugin.yaml и modules/<plugin_id>/main.py.\n"
        "В plugin.yaml ОБЯЗАТЕЛЬНО укажи main_script: \"main.py\" (не пустой).\n"
        "Не добавляй бинарные данные.\n"
    )
    user = json.dumps(
        {
            "plugin_id": pid,
            "task": task,
            "existing_files": existing_files,
        },
        ensure_ascii=False,
    )

    raw = _call_openrouter_chat(settings=settings, api_key=key, system=system, user=user)
    try:
        plan = json.loads(raw)
    except Exception as e:
        # При плохом JSON не пишем ничего
        logger.warning("PluginBuilder: model output invalid JSON | plugin_id=%s err=%s", pid, e)
        return {"ok": False, "error": f"Model output is not valid JSON: {e}", "raw": raw[:4000]}

    files = plan.get("files")
    if not isinstance(files, list) or not files:
        return {"ok": False, "error": "Model output JSON missing 'files' list", "raw": raw[:2000]}

    written: list[str] = []
    try:
        plugin_dir.mkdir(parents=True, exist_ok=True)
        for f in files:
            if not isinstance(f, dict):
                continue
            rel_raw = str(f.get("path") or "")
            content = f.get("content")
            if not rel_raw or not isinstance(content, str):
                continue
            rel = _normalize_rel_path(rel_raw, plugin_id=pid)
            if not rel:
                continue
            target = (plugin_dir / rel).resolve()
            _path_jail_check(target, plugin_dir)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
            written.append(rel)
    except Exception as e:
        if existed and backup_ok and backup_path:
            loader.rollback_plugin(pid, backup_path=backup_path)
        return {"ok": False, "error": f"Write failed: {e}", "written": written}

    logger.info("PluginBuilder: wrote files | plugin_id=%s count=%s", pid, len(written))

    # Структурная валидация: tool должен класть plugin.yaml в корень plugin_dir.
    manifest_path = (plugin_dir / "plugin.yaml").resolve()
    if not manifest_path.exists():
        if existed and backup_ok and backup_path:
            loader.rollback_plugin(pid, backup_path=backup_path)
        logger.warning("PluginBuilder: missing plugin.yaml after write | plugin_id=%s", pid)
        return {
            "ok": False,
            "error": "Plugin manifest missing at modules/<plugin_id>/plugin.yaml (model wrote files into a wrong subdir)",
            "written": written,
        }

    # Валидация main_script из manifest: должен указывать на файл внутри plugin_dir.
    try:
        import yaml

        raw_manifest = yaml.safe_load(manifest_path.read_text(encoding="utf-8")) or {}
        main_script = str(raw_manifest.get("main_script") or "").strip()
        if not main_script:
            # Авто-ремонт: если модель забыла main_script, но положила main.py — подставим дефолт.
            candidate = (plugin_dir / "main.py").resolve()
            if candidate.exists():
                raw_manifest["main_script"] = "main.py"
                manifest_path.write_text(
                    yaml.safe_dump(raw_manifest, allow_unicode=True, sort_keys=False),
                    encoding="utf-8",
                )
                logger.warning("PluginBuilder: fixed empty main_script -> main.py | plugin_id=%s", pid)
                main_script = "main.py"
            else:
                raise ValueError("plugin.yaml has empty main_script")
        main_abs = (plugin_dir / main_script).resolve()
        _path_jail_check(main_abs, plugin_dir)
        if not main_abs.exists():
            raise FileNotFoundError(f"main_script not found: {main_script}")
    except Exception as e:
        if existed and backup_ok and backup_path:
            loader.rollback_plugin(pid, backup_path=backup_path)
        logger.warning("PluginBuilder: invalid plugin manifest | plugin_id=%s err=%s", pid, e)
        return {"ok": False, "error": f"Invalid plugin manifest: {e}", "written": written}

    # Reload: если reload упадёт, откатываемся (если есть бэкап)
    ok, msg = loader.reload_plugin(pid)
    logger.info("PluginBuilder: reload | plugin_id=%s ok=%s msg=%s", pid, ok, msg)
    if not ok and existed and backup_ok and backup_path:
        loader.rollback_plugin(pid, backup_path=backup_path)
        ok2, msg2 = loader.reload_plugin(pid)
        logger.warning("PluginBuilder: rollback+reload | plugin_id=%s ok=%s msg=%s", pid, ok2, msg2)
        return {
            "ok": False,
            "error": f"Reload failed: {msg}. Rolled back: {msg2}",
            "written": written,
        }

    # Если это новый плагин и reload не удался — вернуть явную ошибку (чтобы агент видел, что E3 не завершён).
    if not ok and not existed:
        return {"ok": False, "error": f"Reload failed: {msg}", "written": written}

    return {
        "ok": True,
        "plugin_id": pid,
        "existed": existed,
        "backup": backup_path if backup_ok else None,
        "written": written,
        "notes": str(plan.get("notes") or "")[:2000],
    }

