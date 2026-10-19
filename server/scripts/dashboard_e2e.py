"""Local-only E2E backend: real API/SQLite and deterministic offline providers.

Run explicitly with the project's dev dependencies. All files live in a temporary
directory; this entrypoint never loads .env or the user's runtime configuration.
"""

from pathlib import Path
import os
import sys
import tempfile
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tests"))

from offline_support import offline_agent, nothing, OfflineResponsesGateway
from core.api.app import build_app
import core.api.app as api_module
from core.runtime.backup import BackupManager


def create_app(root):
    os.environ.pop("NEYRA_DATA_DIR", None)
    agent = offline_agent(root)
    import httpx
    from core.llm.profile import OpenAICompatibleConnection
    agent._llm_conn_talk = OpenAICompatibleConnection("offline", "http://offline.invalid/v1", "synthetic-e2e-key")
    agent._responses_transport = httpx.MockTransport(OfflineResponsesGateway())
    config = agent.config
    config["memory"]["diary_after_turn"] = True
    config["backup"] = {"enabled": False, "local_dir": str(root / "backups")}
    config["dashboard"] = {"enabled": True, "dist_path": str(Path(__file__).resolve().parents[1] / "dashboard" / "dist")}
    config_dir = root / "config"
    config_dir.mkdir(exist_ok=True)
    (root / "config.yaml").write_text("assistant:\n  name: Offline\n")
    plugin = root / "modules" / "offline_example"
    plugin.mkdir(parents=True)
    (plugin / "plugin.yaml").write_text("id: offline_example\nname: Offline example\nversion: 1.0.0\nenabled: true\nlifecycle: on_demand\nmain_script: main.py\n")
    (plugin / "config.yaml").write_text("message: offline\n")
    (plugin / "main.py").write_text("def run_plugin(ctx):\n    return {'ok': True}\n")
    monitor = SimpleNamespace(start=lambda: None, stop=lambda: None, run_once=nothing,
                              last_report={"ok": True, "status": "ok"})
    api_module._schedule_exit_after_response = lambda reason: None
    app = build_app(config, shared_agent=agent, shared_monitor=monitor,
                    shared_backup_manager=BackupManager(config), project_root=root)
    return app


if __name__ == "__main__":
    import argparse
    import uvicorn

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=18787)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="neyra-dashboard-e2e-") as directory:
        os.chdir(directory)
        app = create_app(Path(directory))
        uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
