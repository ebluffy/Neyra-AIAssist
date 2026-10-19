"""Hide explicit reasoning blocks before publishing incremental text."""


class ReasoningFilter:
    _OPEN = ("<think>", "<thought>", "<redacted_thinking>")
    _CLOSE = ("</think>", "</thought>", "</redacted_thinking>")
    _TAGS = _OPEN + _CLOSE
    _TAG_LIMIT = max(map(len, _TAGS))

    def __init__(self):
        self._pending = ""
        self._stack = []

    def feed(self, text: str) -> str:
        self._pending += text
        output = []
        while self._pending:
            if not self._pending.startswith("<"):
                end = self._pending.find("<")
                if end < 0:
                    end = len(self._pending)
                if not self._stack:
                    output.append(self._pending[:end])
                self._pending = self._pending[end:]
                continue
            probe = self._pending[:self._TAG_LIMIT].lower()
            tag = next((tag for tag in self._TAGS if probe.startswith(tag)), None)
            if tag:
                if tag in self._OPEN:
                    self._stack.append(tag)
                elif self._stack and tag == self._stack[-1].replace("<", "</", 1):
                    self._stack.pop()
                self._pending = self._pending[len(tag):]
            elif any(tag.startswith(probe) for tag in self._TAGS):
                break
            else:
                if not self._stack:
                    output.append("<")
                self._pending = self._pending[1:]
        return "".join(output)

    def finish(self) -> str:
        tail = self._pending if not self._stack else ""
        self._pending = ""
        return tail
