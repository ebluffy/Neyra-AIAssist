from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

from core.plugins.loader import PluginLoader
from core.text_resources import prompt_text

logger = logging.getLogger("neyra.plugin_builder")


@dataclass(frozen=True)
class PluginBuilderSettings:
    """Explicit coder connection; runtime defaults come from layered LLM config."""

    base_url: str = ""
    model: str = ""
    provider: str = ""
    headers: dict = field(default_factory=dict)
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


def coder_connection(config: dict):
    from core.llm.profile import resolve_openai_compatible_connection, resolve_role_provider

    llm = config.get("llm") or {}
    role = "coder_model" if llm.get("coder_model") else "brain_model"
    block = llm.get(role) or {}
    model = block.get("model") if isinstance(block, dict) else block
    if not model:
        raise ValueError("Configure llm.coder_model.model or llm.brain_model.model")
    if role == "coder_model" and isinstance(block, dict) and not block.get("provider"):
        config = {**config, "llm": {**llm, "coder_model": {**block, "provider": resolve_role_provider(config, "brain_model")}}}
    connection = resolve_openai_compatible_connection(config, role=role)
    return PluginBuilderSettings(base_url=connection.base_url, model=str(model), provider=connection.provider,
                                 headers=dict(connection.default_headers)), connection.api_key


def _call_openai_chat(
    *,
    settings: PluginBuilderSettings,
    api_key: str,
    system: str,
    user: str,
    timeout_s: float = 120.0,
) -> str:
    url = f"{settings.base_url.rstrip('/')}/chat/completions"
    logger.info("PluginBuilder: coder | provider=%s model=%s", settings.provider or "explicit", settings.model)
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        **settings.headers,
    }
    payload = {
        "model": settings.model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": 0.2,
    }
    from core.agent.model_trace import begin_call, end_call
    from types import SimpleNamespace
    call = begin_call(None, "coder", "plugin_generation", model=SimpleNamespace(model_name=settings.model))
    if call is not None:
        call["provider"] = settings.provider or None
    try:
        with httpx.Client(timeout=timeout_s) as client:
            r = client.post(url, headers=headers, json=payload)
            r.raise_for_status()
            data = r.json()
        end_call(call, SimpleNamespace(response_metadata={"model": data.get("model"),
            "request_id": r.headers.get("x-request-id"), "usage": data.get("usage")}))
    except BaseException:
        end_call(call, status="failed")
        raise
    try:
        return data["choices"][0]["message"]["content"]
    except Exception:
        return json.dumps(data, ensure_ascii=False)


def create_or_edit_plugin_impl(
    plugin_id: str,
    task: str,
    *,
    api_key: str | None = None,
    settings: PluginBuilderSettings | None = None,
    config: dict | None = None,
) -> dict[str, Any]:
    """
    Генерирует/правит файлы плагина внутри modules/<plugin_id>.

    Возвращает структурированный результат (дикт), чтобы агент мог кратко пересказать.
    """

    key = api_key
    if settings is None:
        settings, configured_key = coder_connection(config or {})
        key = key or configured_key
    if not settings.base_url or not settings.model:
        raise ValueError("Coder endpoint and model must be configured")
    pid = _normalize_plugin_id(plugin_id)
    if not pid:
        return {"ok": False, "error": "plugin_id is empty"}
    if pid in set(settings.plugin_blacklist):
        return {"ok": False, "error": f"Access denied: plugin '{pid}' is blacklisted"}

    root = _repo_root()
    modules = _modules_dir(root)
    plugin_dir = (modules / pid).resolve()
    _path_jail_check(plugin_dir, modules)

    if not key:
        return {"ok": False, "error": "Coder provider API key is missing"}

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
            # Configuration may contain provider credentials; never send it to the model.
            for p in sorted(plugin_dir.glob("*.md")):
                existing_files[p.name] = p.read_text(encoding="utf-8", errors="replace")[:20000]
        except Exception:
            # не критично — просто без контекста
            existing_files = {}

    system = prompt_text("coder.plugin_generation")
    user = json.dumps(
        {
            "plugin_id": pid,
            "task": task,
            "existing_files": existing_files,
        },
        ensure_ascii=False,
    )

    raw = _call_openai_chat(settings=settings, api_key=key, system=system, user=user)
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
        logger.warning("PluginBuilder: write failed | plugin_id=%s error_type=%s", pid, type(e).__name__)
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
