"""STT: локальный faster-whisper, Groq Whisper (OpenAI-compatible), Deepgram Nova (REST)."""

from __future__ import annotations

import base64
import logging
import os
import re
import tempfile
import wave
import asyncio
from pathlib import Path
from typing import Any, Optional

import httpx

logger = logging.getLogger("neyra.stt")


def _normalize_api_key(raw: str) -> str:
    s = (raw or "").strip()
    if s.startswith("\ufeff"):
        s = s[1:].strip()
    if len(s) >= 2 and ((s[0] == s[-1] == '"') or (s[0] == s[-1] == "'")):
        s = s[1:-1].strip()
    return s


def _dedupe_groq_api_key(s: str) -> str:
    """Два ключа Groq часто случайно пишут в одну строку подряд — API даёт 401."""
    s = (s or "").strip()
    if not s:
        return s
    starts = [m.start() for m in re.finditer(r"gsk_", s, flags=re.I)]
    if len(starts) < 2:
        return s
    tail = s[starts[-1] :].strip()
    logger.warning(
        "GROQ_API_KEY: несколько префиксов gsk_ в одной строке — взят последний фрагмент. "
        "Исправь .env: должен быть ровно один ключ."
    )
    return tail


def _wav_duration_sec(path: Path) -> float:
    try:
        with wave.open(str(path), "rb") as w:
            fr = w.getframerate()
            if fr <= 0:
                return 0.0
            return w.getnframes() / float(fr)
    except Exception:
        return 0.0


def _groq_hallucination_discard(text: str, duration_sec: float, *, reject_thanks_max_sec: float) -> bool:
    """Типичные галлюцинации Whisper на шуме/коротком клипе (субтитры, «продолжение следует»)."""
    t = (text or "").strip()
    tl = t.lower()
    if not t:
        return True
    for frag in (
        "продолжение следует",
        "amara.org",
        "dimator",
        "редактор субтитров",
        "субтитры созда",
        "субтитры делал",
    ):
        if frag in tl:
            return True
    if reject_thanks_max_sec > 0 and duration_sec < reject_thanks_max_sec:
        if re.fullmatch(r"спасибо[!.\s…]*", tl, flags=re.I):
            return True
        if re.fullmatch(r"thank you[!.\s]*", tl, flags=re.I):
            return True
    return False


def _deepgram_transcript_from_json(payload: dict[str, Any]) -> str:
    """Извлекает текст из ответа /v1/listen: utterances → alternatives.transcript → words."""
    try:
        results = payload.get("results")
        if not isinstance(results, dict):
            return ""
        utts = results.get("utterances") or []
        if isinstance(utts, list) and utts:
            parts: list[str] = []
            for u in utts:
                if not isinstance(u, dict):
                    continue
                t = str(u.get("transcript") or "").strip()
                if t:
                    parts.append(t)
            joined = " ".join(parts).strip()
            if joined:
                return joined

        channels = results.get("channels") or []
        if not isinstance(channels, list) or not channels:
            return ""
        ch0 = channels[0] if isinstance(channels[0], dict) else {}
        alts = ch0.get("alternatives") or []
        if not isinstance(alts, list) or not alts:
            return ""

        best = ""
        best_conf = -1.0
        for alt in alts:
            if not isinstance(alt, dict):
                continue
            t = str(alt.get("transcript") or "").strip()
            conf = float(alt.get("confidence") or 0.0)
            if t and conf >= best_conf:
                best, best_conf = t, conf
        if best:
            return best

        alt0 = alts[0] if isinstance(alts[0], dict) else {}
        words = alt0.get("words") or []
        if isinstance(words, list) and words:
            wparts: list[str] = []
            for w in words:
                if not isinstance(w, dict):
                    continue
                pw = w.get("punctuated_word") or w.get("word")
                if pw:
                    wparts.append(str(pw))
            return " ".join(wparts).strip()
        return ""
    except Exception:
        return ""


def _deepgram_body_from_wav_path(path: Path, upload: str) -> tuple[bytes, str, dict[str, str]]:
    """
    Возвращает (body, Content-Type, доп.query для Deepgram).
    upload: wav | linear16
    """
    upload = upload.strip().lower()
    if upload == "wav":
        return path.read_bytes(), _deepgram_upload_content_type(path), {}
    if upload != "linear16":
        return path.read_bytes(), _deepgram_upload_content_type(path), {}
    if path.suffix.lower() != ".wav":
        raise ValueError("Deepgram upload_payload=linear16 ожидает .wav от voice_listen")
    with wave.open(str(path), "rb") as w:
        nch = int(w.getnchannels())
        sw = int(w.getsampwidth())
        fr = int(w.getframerate())
        if sw != 2:
            raise ValueError(f"Deepgram linear16: нужны 16-bit сэмплы (sampwidth=2), получено {sw}")
        pcm = w.readframes(w.getnframes())
    extra = {
        "encoding": "linear16",
        "sample_rate": str(fr),
        "channels": str(nch),
    }
    return pcm, "application/octet-stream", extra


def _audio_mime_for_suffix(path: Path) -> str:
    """Extension → MIME without OS registry (Windows-safe)."""
    suf = path.suffix.lower().lstrip(".")
    if suf == "mpeg":
        suf = "mp3"
    return {
        "wav": "audio/wav",
        "mp3": "audio/mpeg",
        "flac": "audio/flac",
        "m4a": "audio/mp4",
        "ogg": "audio/ogg",
        "oga": "audio/ogg",
        "opus": "audio/ogg",
        "webm": "audio/webm",
        "aac": "audio/aac",
    }.get(suf, "application/octet-stream")


def _deepgram_upload_content_type(path: Path) -> str:
    """Content-Type для тела POST (сырые байты, не multipart)."""
    return _audio_mime_for_suffix(path)


def _save_deepgram_debug_payload(
    *,
    body: bytes,
    original_wav: Path,
    upload_payload: str,
    params: dict[str, str],
    debug_dir: Path,
) -> None:
    """Сохраняет последнее аудио, отправленное в Deepgram, для ручной проверки."""
    try:
        debug_dir.mkdir(parents=True, exist_ok=True)
        mode = upload_payload.strip().lower()
        if mode == "linear16":
            out_path = debug_dir / "debug_deepgram_linear16.pcm"
            out_path.write_bytes(body)
            meta = {
                "sample_rate": params.get("sample_rate", ""),
                "channels": params.get("channels", ""),
                "encoding": params.get("encoding", "linear16"),
            }
            (debug_dir / "debug_deepgram_linear16.meta.txt").write_text(
                "\n".join([f"{k}={v}" for k, v in meta.items()]),
                encoding="utf-8",
            )
        else:
            out_path = debug_dir / "debug_deepgram.wav"
            out_path.write_bytes(body)
        # Копия исходного WAV из voice_listen: позволяет сравнить «до» и «после упаковки».
        raw_copy = debug_dir / "debug_deepgram_source.wav"
        raw_copy.write_bytes(original_wav.read_bytes())
        logger.debug("STT(Deepgram): debug payload сохранён: %s", out_path)
    except Exception as e:
        logger.warning("STT(Deepgram): не удалось сохранить debug payload: %s", e)


class STTEngine:
    """STT: faster-whisper (local) или cloud provider из ``voice.stt`` (modality)."""

    def __init__(self, config: dict):
        from core.voice.config import resolve_stt_runtime

        self.config = config
        # Soft ERROR for misconfig is logged once at core startup (main.py).
        rt = resolve_stt_runtime(config)
        local_stt = rt["local_stt"]
        self.engine = str(rt["engine"]).strip().lower()
        self.model_size = str(local_stt.get("model", "small"))
        self.language = str(rt["language"] or "ru")
        self.timeout_seconds = float(rt["timeout_seconds"])
        self.max_retries = int(rt["max_retries"])
        self.cloud_fallback_to_local = bool(rt["fallback_to_local"])
        self._cloud_fail_count = 0
        self._stt_available = bool(rt.get("available", True))
        self._primary_lane = rt.get("primary_lane")
        self._fallback_lane = rt.get("fallback_lane")
        if not self._stt_available:
            logger.error(
                "STT недоступен (local/cloud выключены или не настроены) — "
                "ядро работает, распознавание речи отключено"
            )

        cloud = rt["groq"]
        self.groq_base_url = str(cloud.get("base_url", "https://api.groq.com/openai/v1")).rstrip("/")
        env_k = _dedupe_groq_api_key(_normalize_api_key(os.environ.get("GROQ_API_KEY", "")))
        cfg_k = _dedupe_groq_api_key(_normalize_api_key(str(cloud.get("api_key", ""))))
        self.groq_api_key = env_k or cfg_k
        self.groq_transcriptions_url = str(cloud.get("transcriptions_url", "")).strip()
        self.groq_model = str(cloud.get("model", "whisper-large-v3-turbo")).strip()
        self.groq_temperature = float(cloud.get("temperature", 0.0))
        self.groq_prompt = str(cloud.get("prompt", "")).strip()
        self.groq_filter_hallucinations = bool(cloud.get("filter_hallucinations", True))
        self.groq_reject_short_thanks_max_sec = float(cloud.get("reject_short_thanks_max_sec", 2.0))
        if self.engine == "groq":
            logger.info(
                "STT(Groq): model=%s | key_source=%s | key_len=%s | lane=%s",
                self.groq_model,
                "env" if env_k else ("config" if cfg_k else "none"),
                len(self.groq_api_key),
                self._primary_lane,
            )

        dg = rt["deepgram"]
        env_dg = _normalize_api_key(os.environ.get("DEEPGRAM_API_KEY", ""))
        cfg_dg = _normalize_api_key(str(dg.get("api_key", "")))
        self.dg_api_key = env_dg or cfg_dg
        self.dg_model = str(dg.get("model", "nova-3")).strip()
        self.dg_base_url = str(dg.get("base_url", "https://api.deepgram.com/v1")).rstrip("/")
        self.dg_smart_format = bool(dg.get("smart_format", True))
        self.dg_punctuate = bool(dg.get("punctuate", True))
        self.dg_diarize = bool(dg.get("diarize", False))
        self.dg_utterances = bool(dg.get("utterances", True))
        self.dg_filter_hallucinations = bool(dg.get("filter_hallucinations", False))
        self.dg_reject_short_thanks_max_sec = float(dg.get("reject_short_thanks_max_sec", 2.0))
        # wav — тело как файл WAV; linear16 — только PCM + query encoding/sample_rate/channels (надёжнее для VC)
        self.dg_upload_payload = str(dg.get("upload_payload", "linear16")).strip().lower()
        # true — не передаём language=, включаем detect_language (рекомендуется для VC / смешанного потока)
        # false — всегда language=… (voice.language); true — detect_language (на коротких VC-кусках часто en/id и пустой текст)
        self.dg_use_detect_language = bool(dg.get("use_detect_language", False))
        self.dg_language = str(dg.get("language", "") or "").strip()
        self.dg_dump_payload = bool(dg.get("dump_payload_debug", False))
        self.dg_dump_dir = Path(str(dg.get("dump_payload_dir", "./logs/voice_tmp")).strip() or "./logs/voice_tmp")
        if self.engine == "deepgram":
            logger.info(
                "STT(Deepgram): model=%s | upload=%s | detect_lang=%s | dump=%s | key_source=%s | key_len=%s | lane=%s",
                self.dg_model,
                self.dg_upload_payload,
                self.dg_use_detect_language,
                self.dg_dump_payload,
                "env" if env_dg else ("config" if cfg_dg else "none"),
                len(self.dg_api_key),
                self._primary_lane,
            )

        # OpenRouter STT (Stage 2F): same OPENROUTER_API_KEY as LLM
        or_stt = rt["openrouter"]
        self._openrouter_stt = or_stt
        or_root = config.get("openrouter") if isinstance(config.get("openrouter"), dict) else {}
        env_or = _normalize_api_key(os.environ.get("OPENROUTER_API_KEY", ""))
        cfg_or = _normalize_api_key(str(or_root.get("api_key") or ""))
        self.or_api_key = env_or or cfg_or
        cfg_base = str(or_stt.get("base_url") or or_root.get("base_url") or "").strip().rstrip("/")
        self.or_base_url = cfg_base or "https://openrouter.ai/api/v1"
        self.or_model = str(
            or_stt.get("model") or "openai/whisper-large-v3-turbo"
        ).strip()
        self.or_temperature = float(or_stt.get("temperature", 0.0))
        # multipart = OpenAI-compatible; json = input_audio base64 (OpenRouter native)
        self.or_upload_mode = str(or_stt.get("upload_mode") or "multipart").strip().lower()
        if self.or_upload_mode not in ("multipart", "json"):
            self.or_upload_mode = "multipart"

        if self.engine == "faster-whisper":
            logger.info(
                "STT(local faster-whisper): model=%s | device_cfg=%s | lane=%s",
                self.model_size,
                local_stt.get("device", "cpu"),
                self._primary_lane,
            )

        if self.engine == "openrouter":
            logger.info(
                "STT(OpenRouter): model=%s | upload=%s | key_source=%s | key_len=%s | lane=%s",
                self.or_model,
                self.or_upload_mode,
                "env" if env_or else ("config" if cfg_or else "none"),
                len(self.or_api_key),
                self._primary_lane,
            )

        if self.engine == "none":
            logger.error("STT engine=none — вызовы transcribe вернут пустую строку")

        dev = str(local_stt.get("device", "cpu")).lower()
        if dev == "cuda":
            try:
                import torch
                if not torch.cuda.is_available():
                    dev = "cpu"
            except ImportError:
                dev = "cpu"
        self.device = dev
        self._model = None

    def _load(self) -> bool:
        if self.engine in ("groq", "deepgram", "openrouter", "none"):
            return True
        if self._model is not None:
            return True
        try:
            from faster_whisper import WhisperModel
        except ImportError:
            logger.warning("faster-whisper не установлен — STT отключён (pip install faster-whisper)")
            return False
        try:
            compute_type = "float16" if self.device == "cuda" else "int8"
            self._model = WhisperModel(
                self.model_size,
                device=self.device,
                compute_type=compute_type,
            )
            logger.info("STT: WhisperModel загружена (%s, %s)", self.model_size, self.device)
            return True
        except Exception as e:
            logger.error("STT: не удалось загрузить модель: %s", e)
            return False

    def _deepgram_transcribe_file(self, path: str | Path) -> tuple[str, bool]:
        """(текст, need_local_fallback). См. https://developers.deepgram.com/docs/pre-recorded-audio

        Важно: Deepgram ждёт **сырое тело** запроса (у httpx — ``content=bytes``), не multipart ``files=``
        (так ходит Groq Whisper). Заголовок ``Content-Type`` обязателен и должен совпадать с форматом файла.
        """
        if not self.dg_api_key:
            logger.error("STT(Deepgram): не задан DEEPGRAM_API_KEY в .env (или voice.stt.deepgram.api_key)")
            return "", True

        p = Path(path)
        if not p.exists():
            return "", True

        url = f"{self.dg_base_url}/listen"
        params: dict[str, str] = {
            "model": self.dg_model,
        }
        if self.dg_use_detect_language:
            params["detect_language"] = "true"
        else:
            lang = (self.dg_language or self.language or "ru").strip()
            if lang:
                params["language"] = lang
        if self.dg_smart_format:
            params["smart_format"] = "true"
        if self.dg_punctuate:
            params["punctuate"] = "true"
        if self.dg_diarize:
            params["diarize"] = "true"
        if self.dg_utterances:
            params["utterances"] = "true"

        try:
            body, mime, extra_q = _deepgram_body_from_wav_path(p, self.dg_upload_payload)
        except Exception as e:
            logger.error("STT(Deepgram): подготовка аудио: %s", e)
            return "", True
        params.update(extra_q)
        if self.dg_dump_payload:
            _save_deepgram_debug_payload(
                body=body,
                original_wav=p,
                upload_payload=self.dg_upload_payload,
                params=params,
                debug_dir=self.dg_dump_dir,
            )

        headers = {
            "Authorization": f"Token {self.dg_api_key}",
            "User-Agent": "NeyraDiscordBot/1.0",
            "Content-Type": mime,
        }

        if logger.isEnabledFor(logging.DEBUG):
            logger.debug(
                "STT(Deepgram) POST %s | params=%s | body=%s bytes | Content-Type=%s (raw body, не multipart)",
                url,
                params,
                len(body),
                mime,
            )
        for attempt in range(1, self.max_retries + 2):
            try:
                with httpx.Client(timeout=self.timeout_seconds) as client:
                    resp = client.post(url, headers=headers, params=params, content=body)
                if logger.isEnabledFor(logging.DEBUG):
                    logger.debug("STT(Deepgram) HTTP %s | resp_bytes=%s", resp.status_code, len(resp.content or b""))
                if resp.status_code == 401:
                    raise RuntimeError(
                        "HTTP 401 — проверь DEEPGRAM_API_KEY в .env (заголовок Authorization: Token …)"
                    )
                if resp.status_code >= 400:
                    raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:400]}")
                payload = resp.json()
                text = _deepgram_transcript_from_json(payload)
                if not text:
                    if logger.isEnabledFor(logging.DEBUG):
                        err = payload.get("err_msg") or payload.get("error") or ""
                        r0 = payload.get("results")
                        ch = (r0 or {}).get("channels") if isinstance(r0, dict) else None
                        snippet = ""
                        det_lang = ""
                        if isinstance(r0, dict) and isinstance(ch, list) and ch and isinstance(ch[0], dict):
                            det_lang = str(ch[0].get("detected_language") or "")
                            snippet = repr(ch[0])[:900]
                        logger.debug(
                            "STT(Deepgram): пустой transcript | err=%s | top_keys=%s | channels=%s | detected_language=%s | ch0=%s",
                            err or "(нет)",
                            list(payload.keys())[:24],
                            len(ch) if isinstance(ch, list) else ch,
                            det_lang or "(нет)",
                            snippet or "(нет)",
                        )
                    return "", False
                if logger.isEnabledFor(logging.DEBUG):
                    logger.debug("STT(Deepgram): transcript len=%s | preview=%r", len(text), text[:160])
                dur = _wav_duration_sec(p)
                if self.dg_filter_hallucinations and _groq_hallucination_discard(
                    text,
                    dur,
                    reject_thanks_max_sec=self.dg_reject_short_thanks_max_sec,
                ):
                    logger.info(
                        "STT(Deepgram): отброшен как hallucination (%.2fs): %s",
                        dur,
                        text[:120],
                    )
                    return "", False
                return text, False
            except Exception as e:
                if attempt >= self.max_retries + 1:
                    logger.error("STT(Deepgram) ошибка: %s", e)
                    return "", True
                logger.warning("STT(Deepgram) retry %s/%s: %s", attempt, self.max_retries + 1, e)
        return "", True

    def _cloud_transcribe_file(self, path: str | Path) -> tuple[str, bool]:
        """(текст, need_local_fallback). Fallback только при сбое HTTP/сети, не при пустом/отфильтрованном ответе."""
        if not self.groq_api_key:
            logger.error("STT(Groq): не задан GROQ_API_KEY в .env (или voice.stt.groq после подстановки)")
            return "", True

        p = Path(path)
        if not p.exists():
            return "", True
        mime = _audio_mime_for_suffix(p)
        if mime == "application/octet-stream":
            mime = "audio/wav"
        url = (
            self.groq_transcriptions_url
            if self.groq_transcriptions_url
            else f"{self.groq_base_url}/audio/transcriptions"
        )
        headers = {
            "Authorization": f"Bearer {self.groq_api_key}",
            "User-Agent": "NeyraDiscordBot/1.0",
        }

        for attempt in range(1, self.max_retries + 2):
            try:
                with p.open("rb") as f:
                    files = {"file": (p.name, f, mime)}
                    data = {
                        "model": self.groq_model,
                        "language": self.language or "ru",
                        "response_format": "json",
                        "temperature": str(self.groq_temperature),
                    }
                    if self.groq_prompt:
                        data["prompt"] = self.groq_prompt[:512]
                    with httpx.Client(timeout=self.timeout_seconds) as client:
                        resp = client.post(url, headers=headers, files=files, data=data)
                if resp.status_code == 401:
                    raise RuntimeError(
                        "HTTP 401 invalid_api_key — проверь GROQ_API_KEY в .env, перевыпусти ключ в Groq Console."
                    )
                if resp.status_code >= 400:
                    raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:300]}")
                payload = resp.json()
                text = str(payload.get("text") or "").strip()
                if not text:
                    return "", False
                dur = _wav_duration_sec(p)
                if self.groq_filter_hallucinations and _groq_hallucination_discard(
                    text,
                    dur,
                    reject_thanks_max_sec=self.groq_reject_short_thanks_max_sec,
                ):
                    logger.info(
                        "STT(Groq): отброшен типичный hallucination (%.2fs): %s",
                        dur,
                        text[:120],
                    )
                    return "", False
                return text, False
            except Exception as e:
                if attempt >= self.max_retries + 1:
                    logger.error("STT(Groq) ошибка: %s", e)
                    return "", True
                logger.warning("STT(Groq) retry %s/%s: %s", attempt, self.max_retries + 1, e)
        return "", True

    def _audio_format_from_path(self, path: Path) -> str:
        suf = path.suffix.lower().lstrip(".")
        if suf in ("wav", "mp3", "flac", "m4a", "ogg", "webm", "aac", "mpeg"):
            return "mp3" if suf == "mpeg" else suf
        # Avoid mimetypes.guess_type on Windows — registry read can raise PermissionError.
        return suf or "wav"

    def _audio_mime_from_path(self, path: Path) -> str:
        mime = _audio_mime_for_suffix(path)
        if mime == "application/octet-stream":
            return f"audio/{self._audio_format_from_path(path)}"
        return mime

    def _openrouter_transcribe_file(self, path: str | Path) -> tuple[str, bool]:
        """(text, need_local_fallback). Soft errors — never raise to callers."""
        if not self.or_api_key:
            logger.error(
                "STT(OpenRouter): нет OPENROUTER_API_KEY — cloud STT не заработает"
            )
            return "", True

        p = Path(path)
        if not p.exists():
            return "", True
        if p.stat().st_size <= 0:
            return "", False

        url = f"{self.or_base_url.rstrip('/')}/audio/transcriptions"
        headers = {
            "Authorization": f"Bearer {self.or_api_key}",
            "User-Agent": "Neyra/1.0",
            "HTTP-Referer": "https://github.com/KORESHon/Neyra-AIAssist",
            "X-Title": "Neyra",
        }
        fmt = self._audio_format_from_path(p)
        mime = self._audio_mime_from_path(p)

        for attempt in range(1, self.max_retries + 2):
            try:
                with httpx.Client(timeout=self.timeout_seconds) as client:
                    if self.or_upload_mode == "json":
                        raw = p.read_bytes()
                        # OpenRouter: raw base64 bytes, not data-URI
                        b64 = base64.b64encode(raw).decode("ascii")
                        body: dict[str, Any] = {
                            "model": self.or_model,
                            "input_audio": {"data": b64, "format": fmt},
                            "language": self.language or "ru",
                            "temperature": self.or_temperature,
                            "response_format": "json",
                        }
                        resp = client.post(
                            url,
                            headers={**headers, "Content-Type": "application/json"},
                            json=body,
                        )
                    else:
                        with p.open("rb") as f:
                            files = {"file": (p.name, f, mime)}
                            data = {
                                "model": self.or_model,
                                "language": self.language or "ru",
                                "response_format": "json",
                                "temperature": str(self.or_temperature),
                            }
                            resp = client.post(
                                url, headers=headers, files=files, data=data
                            )

                if resp.status_code == 401:
                    raise RuntimeError(
                        "HTTP 401 — проверь OPENROUTER_API_KEY (тот же, что для LLM)"
                    )
                if resp.status_code == 429:
                    raise RuntimeError(f"HTTP 429 rate limit: {resp.text[:200]}")
                if resp.status_code >= 400:
                    raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:300]}")

                payload = resp.json()
                text = str(payload.get("text") or "").strip()
                usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
                if usage:
                    logger.debug(
                        "STT(OpenRouter) usage seconds=%s cost=%s",
                        usage.get("seconds"),
                        usage.get("cost"),
                    )
                if not text:
                    return "", False
                return text, False
            except Exception as e:
                if attempt >= self.max_retries + 1:
                    logger.error("STT(OpenRouter) ошибка: %s", e)
                    return "", True
                logger.warning(
                    "STT(OpenRouter) retry %s/%s: %s",
                    attempt,
                    self.max_retries + 1,
                    e,
                )
        return "", True

    def transcribe_file(self, path: str | Path) -> str:
        path = str(path)
        if not getattr(self, "_stt_available", True) or self.engine in ("", "none"):
            logger.error("STT вызов пропущен — полоса не настроена (soft; ядро живо)")
            return ""
        if self.engine == "deepgram":
            text, need_fallback = self._deepgram_transcribe_file(path)
            if text:
                self._cloud_fail_count = 0
                return text
            if not need_fallback:
                self._cloud_fail_count = 0
                return ""
            self._cloud_fail_count += 1
            if not self.cloud_fallback_to_local:
                return ""
            logger.warning("STT: fallback на local faster-whisper после ошибки Deepgram")

        elif self.engine == "groq":
            text, need_fallback = self._cloud_transcribe_file(path)
            if text:
                self._cloud_fail_count = 0
                return text
            if not need_fallback:
                self._cloud_fail_count = 0
                return ""
            self._cloud_fail_count += 1
            if not self.cloud_fallback_to_local:
                return ""
            logger.warning("STT: fallback на local faster-whisper после ошибки Groq")

        elif self.engine == "openrouter":
            text, need_fallback = self._openrouter_transcribe_file(path)
            if text:
                self._cloud_fail_count = 0
                return text
            if not need_fallback:
                self._cloud_fail_count = 0
                return ""
            self._cloud_fail_count += 1
            if not self.cloud_fallback_to_local:
                return ""
            logger.warning("STT: fallback на local faster-whisper после ошибки OpenRouter")

        if not self._load() or not self._model:
            return ""
        try:
            segments, _ = self._model.transcribe(
                path,
                language=self.language if self.language else None,
                vad_filter=True,
            )
            text = " ".join(s.text.strip() for s in segments).strip()
            return text
        except Exception as e:
            logger.error("STT local transcribe_file: %s", e)
            return ""

    def transcribe_bytes(self, data: bytes, suffix: str = ".ogg") -> str:
        if not data:
            return ""
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tf:
            tf.write(data)
            tmp = tf.name
        try:
            return self.transcribe_file(tmp)
        finally:
            try:
                os.unlink(tmp)
            except OSError:
                pass

    async def warmup(self) -> bool:
        """Фоновая подгрузка модели STT, чтобы первый реальный запрос не лагал."""
        try:
            if self.engine == "groq":
                logger.info("STT warmup: cloud Groq mode (%s)", self.groq_model)
                return True
            if self.engine == "deepgram":
                logger.info("STT warmup: cloud Deepgram (%s)", self.dg_model)
                return True
            loop = asyncio.get_running_loop()
            return bool(await loop.run_in_executor(None, self._load))
        except Exception as e:
            logger.warning("STT warmup ошибка: %s", e)
            return False
