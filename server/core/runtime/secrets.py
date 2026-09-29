"""Загрузка .env и подстановка секретов в конфиг (ключи не хранятся в config.yaml)."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any


def load_dotenv_file(root: Path) -> None:
    try:
        from dotenv import load_dotenv
    except ImportError:
        return
    p = root / ".env"
    if p.is_file():
        load_dotenv(p, override=False)


def _s(name: str) -> str:
    return (os.environ.get(name) or "").strip()


def _as_dict(value: Any) -> dict:
    return value if isinstance(value, dict) else {}


def _stt_is_modality(stt: dict) -> bool:
    """True only if YAML already uses prefer / local.enable / cloud.enable|provider."""
    if "prefer" in stt:
        return True
    loc = stt.get("local")
    cld = stt.get("cloud")
    if isinstance(loc, dict) and ("enable" in loc or "enabled" in loc):
        return True
    if isinstance(cld, dict) and ("enable" in cld or "enabled" in cld or "provider" in cld):
        return True
    return False


def _tts_is_modality(tts: dict) -> bool:
    if "prefer" in tts:
        return True
    loc = tts.get("local")
    cld = tts.get("cloud")
    if isinstance(loc, dict) and ("enable" in loc or "enabled" in loc):
        return True
    if isinstance(cld, dict) and ("enable" in cld or "enabled" in cld or "provider" in cld):
        return True
    return False


def _voice_is_is_local_shape(voice: dict) -> bool:
    """Intermediate shape: voice.is_local + voice.local/cloud.{stt,tts}."""
    if not voice:
        return False
    if "is_local" in voice:
        return True
    loc = voice.get("local")
    cld = voice.get("cloud")
    if not isinstance(loc, dict) or not isinstance(cld, dict):
        return False
    return ("stt" in loc or "tts" in loc) and ("stt" in cld or "tts" in cld)


def apply_env_secrets(cfg: dict) -> None:
    """Непустые переменные из окружения перезаписывают соответствующие поля конфига."""
    if not isinstance(cfg, dict):
        return

    k = _s("OPENROUTER_API_KEY")
    if k:
        cfg.setdefault("openrouter", {})["api_key"] = k

    lk = _s("LLM_API_KEY")
    if lk:
        raw_llm = cfg.get("llm")
        llm_block = raw_llm if isinstance(raw_llm, dict) else {}
        if not str(llm_block.get("api_key") or "").strip():
            merged = dict(llm_block)
            merged["api_key"] = lk
            cfg["llm"] = merged

    def _inject_stt_provider_key(provider: str, key: str) -> None:
        """
        Inject into existing shape only.
        - Modality: voice.stt.cloud.<provider>.api_key
        - is_local: voice.cloud.stt.<provider>.api_key
        - Legacy flat: voice.stt.<provider>.api_key (+ voice_cloud mirror)
        Never invent modality cloud on a clean legacy YAML.
        """
        voice = cfg.get("voice")
        if not isinstance(voice, dict):
            voice = {}
            cfg["voice"] = voice

        # Intermediate is_local shape first (do not create voice.stt)
        if _voice_is_is_local_shape(voice):
            cloud = voice.setdefault("cloud", {})
            if isinstance(cloud, dict):
                cloud_stt = cloud.setdefault("stt", {})
                if isinstance(cloud_stt, dict):
                    block = cloud_stt.setdefault(provider, {})
                    if isinstance(block, dict):
                        block["api_key"] = key
            vc = cfg.setdefault("voice_cloud", {})
            if isinstance(vc, dict):
                vc_stt = vc.setdefault("stt", {})
                if isinstance(vc_stt, dict):
                    vc_stt[f"{provider}_api_key"] = key
            return

        stt = voice.get("stt")
        if not isinstance(stt, dict):
            stt = {}
            voice["stt"] = stt

        if _stt_is_modality(stt):
            cloud = stt.setdefault("cloud", {})
            if isinstance(cloud, dict):
                block = cloud.setdefault(provider, {})
                if isinstance(block, dict):
                    block["api_key"] = key
            return

        # Legacy flat — do not invent modality cloud
        flat = stt.setdefault(provider, {})
        if isinstance(flat, dict):
            flat["api_key"] = key
        vc = cfg.setdefault("voice_cloud", {})
        if isinstance(vc, dict):
            vc_stt = vc.setdefault("stt", {})
            if isinstance(vc_stt, dict):
                vc_stt[f"{provider}_api_key"] = key

    g = _s("GROQ_API_KEY")
    if g:
        _inject_stt_provider_key("groq", g)

    dg = _s("DEEPGRAM_API_KEY")
    if dg:
        _inject_stt_provider_key("deepgram", dg)

    d = _s("DISCORD_TOKEN")
    if d:
        cfg.setdefault("discord", {})["token"] = d

    hf = _s("HF_TOKEN") or _s("HUGGING_FACE_HUB_TOKEN")
    if hf:
        cfg.setdefault("memory", {})["hf_token"] = hf

    sp = _s("SCREEN_PROXY_SECRET")
    if sp:
        # Будущий отдельный модуль screen-proxy (не vision.*); см. PLAN / документацию плагина.
        plug = cfg.setdefault("screen_proxy_plugin", {})
        if isinstance(plug, dict):
            plug["secret"] = sp

    tid = _s("TELEGRAM_API_ID")
    if tid:
        cfg.setdefault("telegram", {})["api_id"] = tid

    tah = _s("TELEGRAM_API_HASH")
    if tah:
        cfg.setdefault("telegram", {})["api_hash"] = tah

    apk = _s("AGENT_PROXY_SECRET_KEY")
    if apk:
        cfg.setdefault("agent_proxy", {})["secret_key"] = apk

    iat = _s("INTERNAL_API_TOKEN")
    if iat:
        cfg.setdefault("internal_api", {})["token"] = iat

    bind_h = _s("INTERNAL_API_BIND_HOST")
    if bind_h:
        cfg.setdefault("internal_api", {})["host"] = bind_h

    iv = _s("INTERNAL_API_VIEWER_TOKEN")
    if iv:
        cfg.setdefault("internal_api", {})["viewer_token"] = iv

    im = _s("INTERNAL_API_MAINT_TOKEN")
    if im:
        cfg.setdefault("internal_api", {})["maint_token"] = im

    wh_in = _s("WEBHOOK_INBOUND_SECRET")
    if wh_in:
        cfg.setdefault("internal_api", {})["webhook_inbound_secret"] = wh_in

    yk = _s("YANDEX_API_KEY")
    yf = _s("YANDEX_FOLDER_ID") or _s("YANDEX_ID_KEY")
    if yk or yf:
        voice = cfg.get("voice")
        if not isinstance(voice, dict):
            voice = {}
            cfg["voice"] = voice
        tts_root = _as_dict(voice.get("tts"))

        if _tts_is_modality(tts_root):
            cloud_tts = tts_root.setdefault("cloud", {})
            if isinstance(cloud_tts, dict):
                if yk:
                    cloud_tts["api_key"] = yk
                if yf:
                    cloud_tts["folder_id"] = yf
        elif _voice_is_is_local_shape(voice):
            # Intermediate shape: keys live under voice.cloud.tts
            cloud = voice.setdefault("cloud", {})
            if isinstance(cloud, dict):
                cloud_tts = cloud.setdefault("tts", {})
                if isinstance(cloud_tts, dict):
                    if yk:
                        cloud_tts["api_key"] = yk
                    if yf:
                        cloud_tts["folder_id"] = yf

        # Legacy mirror — dual-read for old plugins
        vc = cfg.setdefault("voice_cloud", {})
        if isinstance(vc, dict):
            tts = vc.setdefault("tts", {})
            if isinstance(tts, dict):
                if yk:
                    tts["api_key"] = yk
                if yf:
                    tts["folder_id"] = yf
