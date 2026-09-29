"""Подготовка изображений для VL (меньше токенов/стоимость, достаточно для текста и смысла)."""

from __future__ import annotations

import logging
from io import BytesIO

logger = logging.getLogger("neyra.vision")

__all__ = ["guess_image_mime_from_filename", "prepare_image_for_vision"]

_GUESS_BY_EXT = (
    (".png", "image/png"),
    (".jpg", "image/jpeg"),
    (".jpeg", "image/jpeg"),
    (".webp", "image/webp"),
    (".gif", "image/gif"),
    (".bmp", "image/bmp"),
)


def guess_image_mime_from_filename(filename: str) -> str:
    """Discord часто шлёт content_type пустым — определяем по расширению."""
    fn = (filename or "").lower()
    for ext, mime in _GUESS_BY_EXT:
        if fn.endswith(ext):
            return mime
    return ""


def resolve_discord_image_mime(content_type: str | None, filename: str) -> str:
    """Нормальный image/* или угадывание по имени; octet-stream + .png → image/png."""
    ct = (content_type or "").lower().strip()
    if ct.startswith("image/"):
        return ct
    if ct in ("application/octet-stream", "binary/octet-stream", "") or ct is None:
        g = guess_image_mime_from_filename(filename)
        if g:
            return g
    return ""


def prepare_image_for_vision(
    data: bytes,
    mime: str,
    max_width: int = 1280,
    max_height: int = 720,
) -> tuple[bytes, str]:
    """
    Вписывает картинку в прямоугольник max_width×max_height с сохранением пропорций,
    сохраняет как JPEG. При ошибке или отсутствии Pillow — исходные байты.
    """
    try:
        from PIL import Image, ImageOps
    except ImportError:
        logger.warning("Pillow не установлен — картинка уходит в VL без сжатия (pip install Pillow).")
        return data, mime

    try:
        img = Image.open(BytesIO(data))
        img = ImageOps.exif_transpose(img)
        if getattr(img, "n_frames", 1) > 1:
            img.seek(0)

        rgba = img.convert("RGBA")
        rgb = Image.new("RGB", rgba.size, (255, 255, 255))
        rgb.paste(rgba, mask=rgba.split()[3])
        img = rgb

        w, h = img.size
        if w > max_width or h > max_height:
            img.thumbnail((max_width, max_height), Image.Resampling.LANCZOS)

        out = BytesIO()
        img.save(out, format="JPEG", quality=88, optimize=True)
        return out.getvalue(), "image/jpeg"
    except Exception as e:
        logger.warning("Не удалось сжать изображение для зрения: %s — шлю оригинал.", e)
        if not (mime or "").strip():
            mime = "image/png"
        return data, mime
