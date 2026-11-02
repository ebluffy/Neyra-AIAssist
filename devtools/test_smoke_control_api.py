"""Exercise the real smoke lifecycle, including failure and interruption cleanup."""

import contextlib
import importlib.util
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    "smoke_control_api", Path(__file__).with_name("smoke_control_api.py")
)
smoke = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(smoke)


class SmokeLifecycleTests(unittest.TestCase):
    def exercise(self, failure=None):
        run = subprocess.run
        temporary_directory = tempfile.TemporaryDirectory
        stop_server = smoke.stop_server
        children = []
        ports = []

        with temporary_directory(prefix="neyra-smoke-test-") as root:
            def workspace(*args, **kwargs):
                kwargs["dir"] = root
                return temporary_directory(*args, **kwargs)

            def client(command, **kwargs):
                if command[0] == "node" and failure:
                    if failure == "timeout":
                        raise subprocess.TimeoutExpired(command, kwargs["timeout"])
                    if failure == "signal":
                        os.kill(os.getpid(), signal.SIGTERM)
                    raise subprocess.CalledProcessError(1, command)
                return run(command, **kwargs)

            def stop(process):
                children.append(process)
                port_file = Path(process.args[-1]) / "port.json"
                if port_file.exists():
                    ports.append(int(port_file.read_text(encoding="utf-8")))
                stop_server(process)

            expected = {
                "error": subprocess.CalledProcessError,
                "timeout": subprocess.TimeoutExpired,
                "signal": InterruptedError,
            }.get(failure)
            with (
                patch.object(smoke.tempfile, "TemporaryDirectory", workspace),
                patch.object(smoke.subprocess, "run", client),
                patch.object(smoke, "stop_server", stop),
                self.assertRaises(expected) if expected else contextlib.nullcontext(),
            ):
                smoke.smoke(20)

            self.assertEqual(list(Path(root).iterdir()), [])
            self.assertEqual(len(children), 1)
            self.assertIsNotNone(children[0].poll())
            self.assertEqual(len(ports), 1)
            with socket.socket() as probe:
                probe.settimeout(1)
                self.assertNotEqual(probe.connect_ex(("127.0.0.1", ports[0])), 0)

    def test_success(self):
        self.exercise()

    def test_client_failure(self):
        self.exercise("error")

    def test_client_timeout(self):
        self.exercise("timeout")

    def test_sigterm(self):
        self.exercise("signal")


if __name__ == "__main__":
    unittest.main()
