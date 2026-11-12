#!/usr/bin/env python3
"""Synthetic training clips for the local wake word "Нейра" (openWakeWord custom model).

No owner voice is recorded. Positive clips are server TTS saying "Нейра" with many voices,
speeds and pitches; negative clips are similar-sounding words and phrases. Every clip gets
light noise at a random level. Output is 16 kHz mono WAV plus manifest.csv.

Train the classifier with openWakeWord's training notebook/script on these folders plus
general negative/noise datasets, then put the result in Documents/Neyra/wakeword/
with a wakeword.json (see client/README.md). Uses YANDEX_API_KEY / YANDEX_FOLDER_ID
from the server .env; nothing is sent to the desktop client.

    python scripts/wakeword_synth_dataset.py --out /data/neyra-wakeword --per-text 6
"""
from __future__ import annotations

import argparse
import asyncio
import csv
import io
import os
import random
import sys
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np  # noqa: E402

from core.voice.yandex_tts import synthesize_to_wav_bytes  # noqa: E402

POSITIVE = ['Нейра', 'Нейра!', 'Нейра?', 'Нейра, привет', 'Эй, Нейра', 'Нейра, слушай', 'Нейра, скажи']
NEGATIVE = [
    'нейрон', 'нейро', 'нейросеть', 'Вера', 'Нина', 'Ирина', 'Майра', 'Мойра', 'неделя', 'наверное',
    'не я', 'Нея', 'Нейт', 'Рейна', 'Нэнси', 'ней раз', 'на нейтрали', 'Кира', 'Лейла', 'нерпа',
]
VOICES = ['alena', 'filipp', 'ermil', 'jane', 'madirus', 'omazh', 'zahar', 'dasha', 'julia', 'lera',
          'masha', 'marina', 'alexander', 'kirill', 'anton']
RATE = 16000


def to_16k_mono(data: bytes) -> np.ndarray:
    with wave.open(io.BytesIO(data)) as w:
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32)
        channels, rate = w.getnchannels(), w.getframerate()
    if channels > 1:
        pcm = pcm.reshape(-1, channels).mean(axis=1)
    if rate != RATE:
        positions = np.arange(0, len(pcm), rate / RATE)
        pcm = np.interp(positions, np.arange(len(pcm)), pcm)
    return pcm


def with_noise(pcm: np.ndarray, rng: random.Random) -> np.ndarray:
    pad = np.zeros(int(RATE * rng.uniform(0.2, 0.6)), dtype=np.float32)
    clip = np.concatenate([pad, pcm, pad])
    noise = np.random.default_rng(rng.randrange(1 << 30)).standard_normal(len(clip)) * rng.uniform(20, 400)
    return np.clip(clip * rng.uniform(0.5, 1.0) + noise, -32768, 32767).astype(np.int16)


def write_wav(path: Path, pcm: np.ndarray) -> None:
    with wave.open(str(path), 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm.tobytes())


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--per-text', type=int, default=6, help='variants per phrase')
    parser.add_argument('--seed', type=int, default=1)
    args = parser.parse_args()
    api_key = os.environ.get('YANDEX_API_KEY', '')
    folder = os.environ.get('YANDEX_FOLDER_ID') or os.environ.get('YANDEX_ID_KEY', '')
    if not api_key or not folder:
        print('Set YANDEX_API_KEY and YANDEX_FOLDER_ID (server .env).', file=sys.stderr)
        return 2
    rng = random.Random(args.seed)
    rows = []
    for label, texts in (('positive', POSITIVE), ('negative', NEGATIVE)):
        folder_out = args.out / label
        folder_out.mkdir(parents=True, exist_ok=True)
        for text in texts:
            for n in range(args.per_text):
                voice = rng.choice(VOICES)
                speed = round(rng.uniform(0.8, 1.3), 2)
                pitch = round(rng.uniform(-150, 150), 1)
                try:
                    data = await synthesize_to_wav_bytes(text, api_key=api_key, folder_id=folder, voice=voice,
                                                         role='neutral', speed=speed, pitch_shift_hz=pitch)
                except Exception as exc:
                    print(f'skip {text!r} {voice}: {exc}', file=sys.stderr)
                    continue
                name = f'{label}_{len(rows):05d}.wav'
                write_wav(folder_out / name, with_noise(to_16k_mono(data), rng))
                rows.append(dict(file=f'{label}/{name}', label=label, text=text, voice=voice, speed=speed, pitch=pitch))
    with open(args.out / 'manifest.csv', 'w', newline='', encoding='utf-8') as handle:
        writer = csv.DictWriter(handle, fieldnames=['file', 'label', 'text', 'voice', 'speed', 'pitch'])
        writer.writeheader()
        writer.writerows(rows)
    print(f'{len(rows)} clips in {args.out}')
    return 0


if __name__ == '__main__':
    raise SystemExit(asyncio.run(main()))
