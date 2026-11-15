"""Строгий разбор .env для скриптов площадки.

Поддерживается ровно тот простой формат, который реально лежит в .env ядра:
строки KEY=VALUE, KEY="VALUE", KEY='VALUE', пустые значения и комментарии
отдельной строкой. Всё, что python-dotenv понял бы иначе (export, inline-
комментарии, ${interpolation}, многострочные кавычки, escape-последовательности),
считается ошибкой формата — лучше отказаться до записи, чем скопировать секрет
неправильно.
"""
from __future__ import annotations

import re

_KEY = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


class EnvFormatError(ValueError):
    """Файл содержит конструкцию, которую скрипт не берется разбирать однозначно."""


def parse_env(text: str, source: str = ".env") -> dict[str, str]:
    values: dict[str, str] = {}
    for number, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        where = f"{source}:{number}"
        if stripped.startswith("export "):
            raise EnvFormatError(f"{where}: убери export — формат должен быть KEY=VALUE")
        if "=" not in line:
            continue
        key, _, raw = line.partition("=")
        key = key.strip()
        if not _KEY.fullmatch(key):
            raise EnvFormatError(f"{where}: некорректное имя переменной")
        value = raw.strip()
        if not value:
            values[key] = ""
            continue
        if "${" in value:
            raise EnvFormatError(f"{where}: подстановка ${{VAR}} не поддерживается, запиши значение буквально")
        if value[0] in "'\"":
            quote = value[0]
            if len(value) < 2 or value[-1] != quote or quote in value[1:-1]:
                raise EnvFormatError(f"{where}: кавычки должны охватывать всё значение без комментария")
            inner = value[1:-1]
            if "\\" in inner:
                raise EnvFormatError(f"{where}: escape-последовательности не поддерживаются")
            values[key] = inner
            continue
        if re.search(r"\s#", value):
            raise EnvFormatError(f"{where}: inline-комментарий не поддерживается, вынеси его на отдельную строку")
        if "\\" in value:
            raise EnvFormatError(f"{where}: обратный слэш не поддерживается, запиши значение без escape")
        values[key] = value
    return values


def read_env(path) -> dict[str, str]:
    with open(path, encoding="utf-8", errors="replace") as handle:
        return parse_env(handle.read(), str(path))
