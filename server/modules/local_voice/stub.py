"""
Local voice agent stub (future plugin / plan stage 2).

Intended loop (not implemented yet):
- wake-word on a local microphone
- record until silence
- STT -> core chat (HTTP / Event Bus) -> TTS
- play to headphones and optionally VB-Cable

Cloud TTS in core today is Yandex SpeechKit-shaped; local TTS backends
(CosyVoice / Silero / Piper) land with the autonomy / thin-client stage.
Enable via modules/local_voice/plugin.yaml when a real implementation exists.
"""

from __future__ import annotations

import logging

logger = logging.getLogger("neyra.local_voice")


def run_local_voice_agent(config: dict) -> None:
    cfg = ((config.get("plugins") or {}).get("local_voice") or {})
    logger.info(
        "local_voice_agent stub | wake_word=%s | real mic loop deferred to plan stage 2",
        cfg.get("wake_word", "нейра"),
    )
