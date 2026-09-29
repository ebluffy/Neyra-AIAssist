"""Resolve ``voice`` config: per-modality local/cloud with prefer + soft fallback.

Canonical shape::

    voice:
      language: "ru"
      stt:
        prefer: cloud          # cloud | local — first choice when both enable
        local:
          enable: false
          model: "small"
          device: "cpu"
        cloud:
          enable: true
          provider: deepgram   # deepgram | groq | openrouter
          openrouter: {...}
          deepgram: {...}
          groq: {...}
      tts:
        prefer: cloud
        local:
          enable: false
          provider: ""
        cloud:
          enable: true
          provider: yandex
          ...

Selection (STT and TTS independently):
1. Only one of local/cloud enable → that lane.
2. Both enable → try ``prefer`` first; on missing config / runtime fail → other lane.
3. Neither enable, or both unusable → soft ERROR log (core must NOT crash).

Legacy shapes still normalized in-memory:
- ``voice.is_local`` + ``voice.local`` / ``voice.cloud`` (short-lived intermediate)
- flat ``voice.stt.engine`` + ``voice_cloud``
"""

from __future__ import annotations

import logging
from typing import Any, Optional

logger = logging.getLogger("neyra.voice.config")


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _truthy_enable(block: dict[str, Any], default: bool = False) -> bool:
    if "enable" not in block and "enabled" not in block:
        return default
    return bool(block.get("enable", block.get("enabled", default)))


def _is_modality_block(block: dict[str, Any]) -> bool:
    """True if stt/tts block uses local/cloud.enable shape."""
    if not block:
        return False
    if "prefer" in block:
        return True
    loc = block.get("local")
    cld = block.get("cloud")
    if isinstance(loc, dict) and ("enable" in loc or "enabled" in loc or "model" in loc or "device" in loc):
        # modality local may omit enable (default false) but presence of local/cloud keys marks shape
        return isinstance(cld, dict) or "enable" in loc or "enabled" in loc
    if isinstance(cld, dict) and ("enable" in cld or "enabled" in cld or "provider" in cld):
        return True
    return isinstance(loc, dict) and isinstance(cld, dict)


def _is_is_local_shape(raw: dict[str, Any]) -> bool:
    if "is_local" in raw:
        return True
    loc = _as_dict(raw.get("local"))
    cld = _as_dict(raw.get("cloud"))
    # Intermediate: voice.local.stt / voice.cloud.stt (not voice.stt.local)
    return ("stt" in loc or "tts" in loc) and ("stt" in cld or "tts" in cld)


def _norm_prefer(value: Any, default: str = "cloud") -> str:
    p = str(value or default).strip().lower()
    return p if p in ("cloud", "local") else default


def _empty_modality(prefer: str = "cloud") -> dict[str, Any]:
    return {
        "prefer": prefer,
        "local": {"enable": False},
        "cloud": {"enable": False},
    }


def normalize_voice_config(config: dict[str, Any]) -> dict[str, Any]:
    """Return normalized voice dict (modality shape). Never raises."""
    raw = _as_dict(config.get("voice"))
    legacy_cloud_root = _as_dict(config.get("voice_cloud"))

    stt_raw = _as_dict(raw.get("stt"))
    tts_raw = _as_dict(raw.get("tts"))

    if _is_modality_block(stt_raw) or _is_modality_block(tts_raw):
        return _normalize_modality_shape(raw)

    if _is_is_local_shape(raw):
        return _migrate_is_local_shape(raw, legacy_cloud_root)

    return _migrate_legacy_flat(raw, legacy_cloud_root)


def _lane_enable(block: dict[str, Any], *, provider_implies: bool = False) -> bool:
    """Explicit enable/enabled wins; otherwise False (cloud may infer from provider)."""
    if "enable" in block or "enabled" in block:
        return _truthy_enable(block, default=False)
    if provider_implies and str(block.get("provider") or "").strip():
        return True
    return False


def _normalize_modality_shape(raw: dict[str, Any]) -> dict[str, Any]:
    language = str(raw.get("language") or "ru")
    stt = _as_dict(raw.get("stt"))
    tts = _as_dict(raw.get("tts"))

    def _lane(mod: dict[str, Any]) -> dict[str, Any]:
        loc = _as_dict(mod.get("local"))
        cld = _as_dict(mod.get("cloud"))
        local_on = _lane_enable(loc)
        cloud_on = _lane_enable(cld, provider_implies=True)
        if local_on and not cloud_on:
            prefer = _norm_prefer(mod.get("prefer"), "local")
        elif cloud_on and not local_on:
            prefer = _norm_prefer(mod.get("prefer"), "cloud")
        else:
            prefer = _norm_prefer(mod.get("prefer"), "cloud")
        return {
            "prefer": prefer,
            "local": {**loc, "enable": local_on},
            "cloud": {**cld, "enable": cloud_on},
        }

    # If only one modality present, keep the other disabled-safe.
    if not stt and not tts:
        stt_out = _empty_modality()
        tts_out = _empty_modality()
    else:
        stt_out = _lane(stt) if stt else _empty_modality()
        tts_out = _lane(tts) if tts else _empty_modality()

    return {
        "language": language,
        "stt": stt_out,
        "tts": tts_out,
    }


def _migrate_is_local_shape(
    raw: dict[str, Any],
    legacy_cloud_root: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    is_local = bool(raw.get("is_local", False))
    loc = _as_dict(raw.get("local"))
    cld = _as_dict(raw.get("cloud"))
    loc_stt = _as_dict(loc.get("stt"))
    cld_stt = _as_dict(cld.get("stt"))
    loc_tts = _as_dict(loc.get("tts"))
    cld_tts = _as_dict(cld.get("tts"))
    # Merge legacy voice_cloud.tts secrets into cloud TTS (is_local shape)
    lc_tts = _as_dict(_as_dict(legacy_cloud_root).get("tts"))
    if lc_tts:
        merged_tts = dict(lc_tts)
        merged_tts.update(cld_tts)
        cld_tts = merged_tts
    language = str(raw.get("language") or "ru")
    prefer = "local" if is_local else "cloud"
    timeout = float(raw.get("timeout_seconds", 30.0))
    max_retries = int(raw.get("max_retries", 1))
    fallback = bool(raw.get("fallback_to_local", True))

    cloud_stt = {
        **cld_stt,
        "enable": (not is_local) or fallback,
        "timeout_seconds": cld_stt.get("timeout_seconds", timeout),
        "max_retries": cld_stt.get("max_retries", max_retries),
    }
    local_stt = {
        **loc_stt,
        "enable": is_local or fallback,
    }
    return {
        "language": language,
        "stt": {
            "prefer": prefer,
            "local": local_stt,
            "cloud": cloud_stt,
        },
        "tts": {
            "prefer": prefer,
            "local": {**loc_tts, "enable": bool(loc_tts.get("provider")) and is_local},
            "cloud": {**cld_tts, "enable": (not is_local) or bool(cld_tts.get("provider"))},
        },
    }


def _migrate_legacy_flat(raw: dict[str, Any], legacy_cloud_root: dict[str, Any]) -> dict[str, Any]:
    old_stt = _as_dict(raw.get("stt"))
    lc_stt = _as_dict(legacy_cloud_root.get("stt"))
    lc_tts = _as_dict(legacy_cloud_root.get("tts"))

    engine = str(old_stt.get("engine") or lc_stt.get("provider") or "faster-whisper").strip().lower()
    is_local = engine in ("faster-whisper", "local", "whisper")
    provider = "deepgram" if is_local else engine
    if provider in ("faster-whisper", "local", "whisper"):
        provider = "deepgram"

    deepgram = _as_dict(old_stt.get("deepgram"))
    if not deepgram and lc_stt:
        deepgram = {
            "model": lc_stt.get("model", "nova-3"),
            "base_url": lc_stt.get("base_url", "https://api.deepgram.com/v1"),
            "api_key": lc_stt.get("deepgram_api_key") or lc_stt.get("api_key"),
        }

    return {
        "language": str(old_stt.get("language") or lc_stt.get("language") or "ru"),
        "stt": {
            "prefer": "local" if is_local else "cloud",
            "local": {
                "enable": is_local or bool(old_stt.get("fallback_to_local", True)),
                "model": old_stt.get("model", "small"),
                "device": old_stt.get("device", "cpu"),
            },
            "cloud": {
                "enable": (not is_local) or bool(old_stt.get("fallback_to_local", True)),
                "provider": provider,
                "timeout_seconds": float(old_stt.get("timeout_seconds") or lc_stt.get("timeout_seconds") or 30.0),
                "max_retries": int(old_stt.get("max_retries", 1)),
                "openrouter": _as_dict(old_stt.get("openrouter")),
                "deepgram": deepgram,
                "groq": _as_dict(old_stt.get("groq")),
            },
        },
        "tts": {
            "prefer": "cloud" if lc_tts else "local",
            "local": {"enable": False, "provider": ""},
            "cloud": {**lc_tts, "enable": bool(lc_tts)},
        },
    }


def _pick_lane(modality: dict[str, Any]) -> tuple[Optional[str], Optional[str], list[str]]:
    """
    Returns (primary_lane, fallback_lane, soft_errors).
    Lanes are ``local`` | ``cloud`` | None.
    """
    loc = _as_dict(modality.get("local"))
    cld = _as_dict(modality.get("cloud"))
    local_on = _truthy_enable(loc, default=False)
    cloud_on = _truthy_enable(cld, default=False)
    prefer = _norm_prefer(modality.get("prefer"), "cloud")
    errs: list[str] = []

    if local_on and cloud_on:
        primary = prefer
        fallback = "local" if prefer == "cloud" else "cloud"
        return primary, fallback, errs
    if cloud_on:
        return "cloud", None, errs
    if local_on:
        return "local", None, errs
    errs.append("both local.enable and cloud.enable are false")
    return None, None, errs


def resolve_stt_runtime(config: dict[str, Any]) -> dict[str, Any]:
    """Flatten STT settings for STTEngine. Soft-errors listed in ``soft_errors``."""
    voice = normalize_voice_config(config)
    stt = _as_dict(voice.get("stt"))
    local_stt = _as_dict(stt.get("local"))
    cloud_stt = _as_dict(stt.get("cloud"))
    primary, fallback, errs = _pick_lane(stt)

    if primary == "local":
        engine = "faster-whisper"
    elif primary == "cloud":
        engine = str(cloud_stt.get("provider") or cloud_stt.get("engine") or "deepgram").strip().lower()
        if engine in ("faster-whisper", "local", "whisper", ""):
            engine = "deepgram"
    else:
        engine = "none"

    return {
        "language": voice.get("language") or "ru",
        "prefer": _norm_prefer(stt.get("prefer"), "cloud"),
        "primary_lane": primary,
        "fallback_lane": fallback,
        "engine": engine,
        "timeout_seconds": float(cloud_stt.get("timeout_seconds", 30.0)),
        "max_retries": int(cloud_stt.get("max_retries", 1)),
        "fallback_to_local": fallback == "local" or (
            primary == "cloud" and _truthy_enable(local_stt, default=False)
        ),
        "local_stt": local_stt,
        "cloud_stt": cloud_stt,
        "openrouter": _as_dict(cloud_stt.get("openrouter")),
        "deepgram": _as_dict(cloud_stt.get("deepgram")),
        "groq": _as_dict(cloud_stt.get("groq")),
        "available": primary is not None,
        "soft_errors": errs,
    }


def resolve_tts_runtime(config: dict[str, Any]) -> dict[str, Any]:
    """Active TTS lane settings. Soft-errors listed in ``soft_errors``."""
    voice = normalize_voice_config(config)
    tts = _as_dict(voice.get("tts"))
    primary, fallback, errs = _pick_lane(tts)
    loc = _as_dict(tts.get("local"))
    cld = _as_dict(tts.get("cloud"))
    active = loc if primary == "local" else cld if primary == "cloud" else {}
    return {
        "language": voice.get("language") or "ru",
        "prefer": _norm_prefer(tts.get("prefer"), "cloud"),
        "primary_lane": primary,
        "fallback_lane": fallback,
        "tts": active,
        "local_tts": loc,
        "cloud_tts": cld,
        "available": primary is not None,
        "soft_errors": errs,
    }


def collect_voice_soft_errors(config: dict[str, Any]) -> list[str]:
    """Human-readable soft errors for STT/TTS (never raises)."""
    out: list[str] = []
    stt = resolve_stt_runtime(config)
    tts = resolve_tts_runtime(config)
    for e in stt.get("soft_errors") or []:
        out.append(f"STT: {e} — распознавание речи работать не будет, поднастройте voice.stt")
    for e in tts.get("soft_errors") or []:
        out.append(f"TTS: {e} — озвучка работать не будет, поднастройте voice.tts")

    # Cloud enabled but obviously missing provider/key hints (soft only)
    if stt.get("primary_lane") == "cloud":
        prov = str(stt.get("engine") or "")
        if prov == "deepgram" and not (
            (_as_dict(stt.get("deepgram")).get("api_key")) 
        ):
            # key may still come from env at runtime — only hint if empty after secrets
            import os
            if not (os.environ.get("DEEPGRAM_API_KEY") or "").strip():
                out.append(
                    "STT(cloud/deepgram): нет DEEPGRAM_API_KEY — cloud STT не заработает, "
                    "пока не зададите ключ или не включите local"
                )
        if prov == "groq" and not (_as_dict(stt.get("groq")).get("api_key")):
            import os
            if not (os.environ.get("GROQ_API_KEY") or "").strip():
                out.append(
                    "STT(cloud/groq): нет GROQ_API_KEY — cloud STT не заработает"
                )
        if prov == "openrouter":
            import os
            from_cfg = str((_as_dict(config.get("openrouter")).get("api_key") or "")).strip()
            if not from_cfg and not (os.environ.get("OPENROUTER_API_KEY") or "").strip():
                out.append(
                    "STT(cloud/openrouter): нет OPENROUTER_API_KEY — cloud STT не заработает"
                )

    if tts.get("primary_lane") == "cloud":
        tblock = _as_dict(tts.get("tts"))
        import os
        if str(tblock.get("provider") or "").lower() == "yandex":
            if not (tblock.get("api_key") or (os.environ.get("YANDEX_API_KEY") or "").strip()):
                out.append(
                    "TTS(cloud/yandex): нет YANDEX_API_KEY — озвучка не заработает"
                )

    return out


def log_voice_soft_errors(config: dict[str, Any], *, log: Optional[logging.Logger] = None) -> list[str]:
    """
    Log soft ERROR lines for misconfigured STT/TTS. Never raises / never aborts core.
    """
    lg = log or logger
    msgs = collect_voice_soft_errors(config)
    for m in msgs:
        lg.error("%s", m)
    if not msgs:
        stt = resolve_stt_runtime(config)
        tts = resolve_tts_runtime(config)
        lg.info(
            "Voice lanes | STT primary=%s fallback=%s engine=%s | TTS primary=%s fallback=%s",
            stt.get("primary_lane"),
            stt.get("fallback_lane"),
            stt.get("engine"),
            tts.get("primary_lane"),
            tts.get("fallback_lane"),
        )
    return msgs


def print_voice_preflight(config: Optional[dict[str, Any]] = None) -> int:
    """
    CLI helper for launchers. Always returns 0 (soft-only).
    """
    if config is None:
        from pathlib import Path
        import yaml
        from core.runtime.secrets import apply_env_secrets, load_dotenv_file

        root = Path(__file__).resolve().parents[2]
        load_dotenv_file(root)
        cfg_path = root / "config.yaml"
        if not cfg_path.is_file():
            cfg_path = root / "config.example.yaml"
        data = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) if cfg_path.is_file() else {}
        if not isinstance(data, dict):
            data = {}
        apply_env_secrets(data)
        config = data

    stt = resolve_stt_runtime(config)
    tts = resolve_tts_runtime(config)
    print(
        f"[voice] STT: primary={stt.get('primary_lane')} "
        f"fallback={stt.get('fallback_lane')} engine={stt.get('engine')} "
        f"| prefer={stt.get('prefer')}"
    )
    print(
        f"[voice] TTS: primary={tts.get('primary_lane')} "
        f"fallback={tts.get('fallback_lane')} "
        f"| prefer={tts.get('prefer')}"
    )
    errs = collect_voice_soft_errors(config)
    if errs:
        print("[voice] ERROR (soft - core still starts; tune STT/TTS):")
        for e in errs:
            print(f"  - {e}")
    else:
        print("[voice] OK - STT/TTS lanes look configured")
    return 0
