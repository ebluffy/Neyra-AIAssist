"""Резолв data_dir ядра и проверка, что каталог внутри выкладки (AR-29).

Запуск: <venv>/python devtools/deploy/check-data-dir.py <server_root>

Печатает разрешённый data_dir ровно так, как его видит ядро
(NEYRA_DATA_DIR → paths.data_dir → ./data). Если каталог вне <server_root>,
выходит с кодом 3: полный бэкап и автооткат update-core.sh копируют только
каталог выкладки, внешние данные в них не попадут.
"""
from __future__ import annotations

import sys
from pathlib import Path


def load_config(root: Path) -> dict:
    try:
        from core.runtime.config_loader import load_layered_config

        return load_layered_config(root, validate=False)
    except Exception:
        pass
    try:
        from core.runtime.config_loader import load_layered_yaml

        return load_layered_yaml(root)
    except Exception:
        return {}


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    sys.path.insert(0, str(root))
    config = load_config(root)
    from core.runtime.paths import resolve_data_dir

    data_dir = resolve_data_dir(root, config if isinstance(config, dict) else {})
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
