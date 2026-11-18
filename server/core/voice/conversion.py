"""Optional voice conversion after server TTS.

The models stay where they are (``server/models/*.pth`` + ``*.index``, RVC).
This stage only reads them. The error policy is explicit:

* ``passthrough`` — send the original TTS voice and tell the client it happened;
* ``stop`` — stop speaking for this turn with ``conversion_failed``.

Nothing silently swaps the voice.
"""
from __future__ import annotations

import asyncio
import logging
import os
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Protocol

logger = logging.getLogger('neyra.voice.conversion')

SERVER_ROOT = Path(__file__).resolve().parents[2]
MODELS_DIR = SERVER_ROOT / 'models'
MAX_AUDIO = 8 * 1024 * 1024
POLICIES = ('passthrough', 'stop')


class ConversionError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class Backend(Protocol):
    def convert(self, wav: bytes) -> bytes: ...


@dataclass(frozen=True)
class ConversionSettings:
    enabled: bool = False
    backend: str = 'rvc'
    model: str = ''
    index: str = ''
    on_error: str = 'passthrough'
    pitch: int = 0
    device: str = 'cpu'
    timeout_seconds: float = 20.0

    @classmethod
    def from_config(cls, config) -> 'ConversionSettings':
        voice = config.get('voice') if isinstance(config, dict) else None
        raw = voice.get('conversion') if isinstance(voice, dict) else None
        if not isinstance(raw, dict):
            return cls()
        on_error = str(raw.get('on_error') or 'passthrough').strip().lower()
        if on_error not in POLICIES:
            logger.error('voice.conversion.on_error=%r is not passthrough/stop; using stop', on_error)
            on_error = 'stop'
        try:
            pitch = int(raw.get('pitch', 0))
            timeout = float(raw.get('timeout_seconds', 20.0))
        except (TypeError, ValueError):
            pitch, timeout = 0, 20.0
        return cls(
            enabled=bool(raw.get('enabled', False)),
            backend=str(raw.get('backend') or 'rvc').strip().lower(),
            model=str(raw.get('model') or '').strip(),
            index=str(raw.get('index') or '').strip(),
            on_error=on_error,
            pitch=max(-24, min(24, pitch)),
            device=str(raw.get('device') or 'cpu').strip(),
            timeout_seconds=max(1.0, min(120.0, timeout)),
        )


def model_path(name: str, suffix: str, models_dir: Path = MODELS_DIR) -> Path:
    """Resolve a plain file name inside server/models. No paths, no other folders."""
    if not name or name != Path(name).name or name.startswith('.') or not name.endswith(suffix):
        raise ConversionError('model_invalid')
    root = models_dir.resolve()
    path = (root / name).resolve()
    if path.parent != root:
        raise ConversionError('model_invalid')
    if not path.is_file():
        raise ConversionError('model_missing')
    return path


class RvcBackend:
    """RVC inference through the optional ``rvc-python`` package (not a core dependency)."""

    def __init__(self, settings: ConversionSettings, models_dir: Path = MODELS_DIR):
        self.model = model_path(settings.model, '.pth', models_dir)
        self.index = model_path(settings.index, '.index', models_dir) if settings.index else None
        try:
            from rvc_python.infer import RVCInference
        except Exception as exc:
            raise ConversionError('backend_unavailable') from exc
        self._engine = RVCInference(device=settings.device)
        self._engine.load_model(str(self.model), index_path=str(self.index) if self.index else '')
        self._engine.set_params(f0up_key=settings.pitch)
        self._lock = threading.Lock()

    def convert(self, wav: bytes) -> bytes:
        with self._lock, tempfile.TemporaryDirectory(prefix='neyra-vc-') as folder:
            source = os.path.join(folder, 'in.wav')
            target = os.path.join(folder, 'out.wav')
            with open(source, 'wb') as handle:
                handle.write(wav)
            self._engine.infer_file(source, target)
            with open(target, 'rb') as handle:
                return handle.read()


class VoiceConversion:
    def __init__(self, config, backend_factory: Callable[[ConversionSettings], Backend] | None = None):
        self.settings = ConversionSettings.from_config(config)
        self._factory = backend_factory or self._default_factory
        self._backend: Backend | None = None
        self._load_lock = asyncio.Lock()

    @staticmethod
    def _default_factory(settings: ConversionSettings) -> Backend:
        if settings.backend != 'rvc':
            raise ConversionError('backend_unknown')
        return RvcBackend(settings)

    def describe(self) -> dict:
        s = self.settings
        return dict(enabled=s.enabled, model=s.model if s.enabled else '', on_error=s.on_error)

    async def convert(self, wav: bytes) -> bytes:
        """Return converted WAV or raise ConversionError. Caller applies on_error."""
        if not wav:
            raise ConversionError('empty_audio')
        loop = asyncio.get_running_loop()
        async with self._load_lock:
            if self._backend is None:
                try:
                    self._backend = await loop.run_in_executor(None, self._factory, self.settings)
                except ConversionError:
                    raise
                except Exception as exc:
                    logger.error('voice conversion backend failed to load: %s', exc)
                    raise ConversionError('backend_failed') from exc
        backend = self._backend
        job = loop.run_in_executor(None, backend.convert, wav)
        try:
            out = await asyncio.wait_for(asyncio.shield(job), self.settings.timeout_seconds)
        except asyncio.TimeoutError as exc:
            raise ConversionError('timeout') from exc
        except ConversionError:
            raise
        except Exception as exc:
            logger.error('voice conversion failed: %s', exc)
            raise ConversionError('convert_failed') from exc
        if not out or len(out) > MAX_AUDIO or not out.startswith(b'RIFF'):
            raise ConversionError('bad_output')
        return out
