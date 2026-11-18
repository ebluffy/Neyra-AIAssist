"""Split streamed reply text into plain sentences for per-sentence TTS."""
from __future__ import annotations

import re

_LINK = re.compile(r'\[([^]]+)\]\([^)]*\)')
_MARKUP = re.compile(r'[*_`#>|~]+')
_SPACES = re.compile(r'\s+')
_END = re.compile(r'[.!?…]+["»)]?(?=\s)|\n\s*\n')


def plain_text(text: str) -> str:
    """Voice gets plain text: no code blocks, links or Markdown marks."""
    text = re.sub(r'```.*?(```|$)', ' ', text, flags=re.S)
    text = _LINK.sub(r'\1', text)
    text = _MARKUP.sub('', text)
    return _SPACES.sub(' ', text).strip()


class SentenceSplitter:
    """Feed tokens, get finished sentences. Text inside code fences is never spoken."""

    def __init__(self, min_chars: int = 24, max_chars: int = 280):
        self.min_chars = min_chars
        self.max_chars = max_chars
        self._buffer = ''
        self._raw = ''

    def feed(self, text: str) -> list[str]:
        self._raw += text
        spoken, self._raw = _outside_fences(self._raw)
        self._buffer += spoken
        return self._take(final=False)

    def flush(self) -> list[str]:
        spoken, _ = _outside_fences(self._raw, final=True)
        self._raw = ''
        self._buffer += spoken
        return self._take(final=True)

    def _take(self, final: bool) -> list[str]:
        out: list[str] = []
        while True:
            cut = None
            for match in _END.finditer(self._buffer):
                if len(plain_text(self._buffer[:match.end()])) >= self.min_chars:
                    cut = match.end()
                    break
            if cut is None and len(self._buffer) > self.max_chars:
                window = self._buffer[:self.max_chars]
                cut = max(window.rfind(', '), window.rfind('; '), window.rfind(' '))
                cut = cut + 1 if cut > 0 else self.max_chars
            if cut is None:
                break
            sentence = plain_text(self._buffer[:cut])
            self._buffer = self._buffer[cut:]
            if sentence:
                out.append(sentence)
        if final:
            rest = plain_text(self._buffer)
            self._buffer = ''
            if rest:
                out.append(rest)
        return out


def _outside_fences(raw: str, final: bool = False) -> tuple[str, str]:
    """Return (text outside ``` fences, unfinished tail to keep)."""
    spoken = []
    rest = raw
    while True:
        start = rest.find('```')
        if start < 0:
            # A trailing partial fence marker must wait for more tokens.
            keep = 0 if final else _partial_fence_tail(rest)
            spoken.append(rest[:len(rest) - keep])
            return ''.join(spoken), rest[len(rest) - keep:]
        spoken.append(rest[:start])
        end = rest.find('```', start + 3)
        if end < 0:
            return ''.join(spoken), ('' if final else rest[start:])
        spoken.append(' ')
        rest = rest[end + 3:]


def _partial_fence_tail(text: str) -> int:
    for size in (2, 1):
        if text.endswith('`' * size):
            return size
    return 0
