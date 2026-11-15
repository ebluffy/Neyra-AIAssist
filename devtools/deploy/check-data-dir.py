"""Резолв data_dir ядра и проверка, что каталог внутри выкладки (AR-29).

Запуск: <venv>/python devtools/deploy/check-data-dir.py <server_root>

Порядок как у ядра: `.env` каталога выкладки загружается через
`core.runtime.secrets.load_dotenv_file`, затем конфиг через
`core.runtime.config_loader.load_layered_config`. Поэтому `NEYRA_DATA_DIR`,
заданный в `.env`, виден проверке. Ошибка загрузки `.env`/конфига — отказ
(код 4), а не подстановка `./data`: иначе проверка молча пропускает выкладку.

Печатает разрешённый data_dir. Если каталог вне <server_root>, выходит с кодом 3:
полный бэкап и автооткат update-core.sh копируют только каталог выкладки,
внешние данные в них не попадут.
"""
from __future__ import annotations

import sys
from pathlib import Path


def fail(message: str) -> int:
    print(message, file=sys.stderr)
    return 4


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    sys.path.insert(0, str(root))

    try:
        from core.runtime.secrets import load_dotenv_file
    except Exception as exc:  # noqa: BLE001 — сообщаем причину как есть
        return fail(f"не удалось загрузить core.runtime.secrets из {root}: {exc}")

    if (root / ".env").is_file():
        try:
            import dotenv  # noqa: F401
        except ImportError:
            return fail("в окружении нет python-dotenv: .env ядра не будет прочитан")
    try:
        load_dotenv_file(root)
    except Exception as exc:  # noqa: BLE001 — сломанное ядро не должно давать traceback
        return fail(f"не удалось загрузить .env ядра из {root}: {exc}")

    try:
        from core.runtime.config_loader import load_layered_config

        config = load_layered_config(root)
    except Exception as exc:  # noqa: BLE001 — пустой конфиг вместо ошибки недопустим
        return fail(f"не удалось прочитать конфиг ядра в {root}: {exc}")

    try:
        from core.runtime.paths import resolve_data_dir
    except Exception as exc:  # noqa: BLE001 — обещаем код 4, а не traceback
        return fail(f"не удалось загрузить core.runtime.paths из {root}: {exc}")

    try:
        data_dir = resolve_data_dir(root, config if isinstance(config, dict) else {})
    except Exception as exc:  # noqa: BLE001 — битый ~/путь не должен давать traceback
        return fail(f"не удалось разрешить data_dir: {exc}")
    print(data_dir)
    if data_dir != root and root not in data_dir.parents:
        print(
            f"data_dir {data_dir} вне каталога выкладки {root}: полный бэкап и откат "
            f"его не покрывают. Перенеси data_dir внутрь {root} или убери "
            "NEYRA_DATA_DIR / paths.data_dir.",
            file=sys.stderr,
        )
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
