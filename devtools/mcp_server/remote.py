"""Run the debug MCP beside a flat server install over SSH stdio."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


def select_api_token(api: dict) -> str:
    explicit = os.environ.get("NEYRA_API_TOKEN", "").strip()
    if explicit:
        return explicit
    if os.environ.get("NEYRA_MCP_ALLOW_WRITES") == "1":
        token = str(api.get("token") or api.get("viewer_token") or "").strip()
    else:
        token = str(api.get("viewer_token") or "").strip()
    if not token:
        raise RuntimeError("Set API_VIEWER_TOKEN or an explicit NEYRA_API_TOKEN for MCP; admin fallback requires NEYRA_MCP_ALLOW_WRITES=1.")
    return token


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server-root", required=True, type=Path)
    args = parser.parse_args()
    root = args.server_root.resolve(strict=True)
    os.environ["NEYRA_SERVER_ROOT"] = str(root)
    os.environ["NEYRA_MCP_LOAD_RUNTIME"] = "1"
    # Loading .env/config must precede importing server.py; runtime initialization is not needed.
    sys.path.insert(0, str(root))
    from core.runtime.secrets import load_dotenv_file
    from core.runtime.config_loader import load_layered_config
    load_dotenv_file(root)
    config = load_layered_config(root, validate=False)
    api = config.get("api") or {}
    os.environ["NEYRA_API_TOKEN"] = select_api_token(api)
    os.environ.setdefault("NEYRA_API_BASE", f"http://127.0.0.1:{int(api.get('port') or 8787)}")
    system_log = (config.get("logging") or {}).get("system_log")
    if system_log:
        os.environ.setdefault("NEYRA_LOG_PATH", str(root / system_log))
    os.chdir(root)
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from server import main as run
    run()


if __name__ == "__main__":
    main()
