"""Offline CLI regressions for perf-report; no application or network is started."""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("perf-report")
RUN = "00000000-0000-4000-8000-000000000001"


def row(stage, elapsed, **extra):
    return {
        "schema_version": 1,
        "run_id": RUN,
        "stage": stage,
        "elapsed_ms": elapsed,
        "os": "linux",
        "graphics_backend": "wayland",
        "graphics_mode": "auto",
        "library_mode": "bundled",
        **extra,
    }


class PerfReportTests(unittest.TestCase):
    def cli(self, *paths, data=None):
        return subprocess.run(
            [sys.executable, str(SCRIPT), *map(str, paths)],
            input=data,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_combines_rotated_logs_by_run_and_stage_not_file_order(self):
        with tempfile.TemporaryDirectory() as directory:
            old = Path(directory, "perf.jsonl.1")
            current = Path(directory, "perf.jsonl")
            old.write_text("\n".join(json.dumps(row(s, n)) for s, n in [
                ("process", 0), ("rust_setup", 12), ("webview_ready", 80),
            ]) + "\n", encoding="utf-8")
            current.write_text("\n".join(json.dumps(row(s, n)) for s, n in [
                ("connected", 250), ("first_render", 100),
            ]) + "\n", encoding="utf-8")
            result = self.cli(current, old)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        self.assertIn(f"Run {RUN}", result.stdout)
        self.assertIn("OS: linux  graphics: wayland  mode: auto  libraries: bundled", result.stdout)
        self.assertRegex(result.stdout, r"first_render\s+100\.000\s+20\.000")
        self.assertRegex(result.stdout, r"connected\s+250\.000\s+150\.000")

    def test_missing_stages_do_not_fabricate_deltas_and_unknown_metadata(self):
        data = [row("process", 0), row("first_render", 40), row("connected", 80)]
        for item in data:
            item["graphics_backend"] = None
            item["graphics_mode"] = None
            item["library_mode"] = None
        result = self.cli("-", data="\n".join(map(json.dumps, data)))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("graphics: unknown  mode: unknown  libraries: unknown", result.stdout)
        self.assertRegex(result.stdout, r"rust_setup\s+missing\s+-")
        self.assertRegex(result.stdout, r"first_render\s+40\.000\s+-")
        self.assertRegex(result.stdout, r"connected\s+80\.000\s+40\.000")

    def test_malformed_and_unsupported_rows_are_reported_and_skipped(self):
        data = "\n".join([
            "{truncated", json.dumps(row("process", 0, schema_version=2)),
            json.dumps(row("process", 0, schema_version=True)),
            json.dumps(row("process", -1)), json.dumps(row("process", True)),
            json.dumps(row("process", float("nan"))),
            json.dumps(row("process", 0, run_id="bad\nrun")),
            json.dumps(row("unknown", 3)), json.dumps(row("process", 0)),
        ])
        result = self.cli("-", data=data)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr.count("skipped:"), 8)
        self.assertRegex(result.stdout, r"process\s+0\.000\s+-")

    def test_duplicate_earliest_stage_and_reversed_timestamps(self):
        result = self.cli("-", data="\n".join(map(json.dumps, [
            row("process", 0), row("rust_setup", 10), row("rust_setup", 5),
            row("webview_ready", 4),
        ])))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("keeping earliest marker", result.stderr)
        self.assertRegex(result.stdout, r"rust_setup\s+5\.000\s+5\.000")
        self.assertRegex(result.stdout, r"webview_ready\s+4\.000\s+out-of-order")

    def test_conflicting_metadata_does_not_merge_incompatible_records(self):
        result = self.cli("-", data="\n".join(map(json.dumps, [
            row("process", 0), row("rust_setup", 5, os="windows"),
        ])))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("conflicting os", result.stderr)
        self.assertRegex(result.stdout, r"rust_setup\s+missing\s+-")

    def test_multiple_processes_are_separate_tables(self):
        other = "00000000-0000-4000-8000-000000000002"
        result = self.cli("-", data="\n".join(map(json.dumps, [
            row("process", 0), row("process", 0, run_id=other),
            row("connected", 40), row("connected", 90, run_id=other),
        ])))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.count("Run "), 2)
        self.assertIn(other, result.stdout)

    def test_graphics_modes_include_compatibility_on_wayland(self):
        for mode in ("auto", "wayland", "wayland-nvidia", "x11", "compatibility", None):
            with self.subTest(mode=mode):
                result = self.cli("-", data=json.dumps(row("process", 0, graphics_mode=mode)))
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stderr, "")
                self.assertIn(f"graphics: wayland  mode: {mode or 'unknown'}", result.stdout)

    def test_older_records_without_graphics_mode_remain_supported(self):
        item = row("process", 0)
        del item["graphics_mode"]
        result = self.cli("-", data=json.dumps(item))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        self.assertIn("graphics: wayland  mode: unknown", result.stdout)

    def test_unknown_graphics_modes_are_skipped(self):
        for mode in ("unknown", "WAYLAND", "", 1, True, [], {}):
            with self.subTest(mode=mode):
                result = self.cli("-", data=json.dumps(row("process", 0, graphics_mode=mode)))
                self.assertEqual(result.returncode, 1)
                self.assertIn("skipped: graphics_mode must be", result.stderr)
                self.assertEqual(result.stdout, "")

    def test_same_backend_with_conflicting_graphics_modes_is_not_merged(self):
        result = self.cli("-", data="\n".join(map(json.dumps, [
            row("process", 0), row("rust_setup", 5, graphics_mode="compatibility"),
        ])))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("conflicting graphics_mode", result.stderr)
        self.assertIn("graphics: wayland  mode: auto", result.stdout)
        self.assertRegex(result.stdout, r"rust_setup\s+missing\s+-")

    def test_no_valid_records_and_unreadable_file_fail(self):
        result = self.cli("-", data="{}\n")
        self.assertEqual(result.returncode, 1)
        self.assertIn("no valid performance records", result.stderr)
        with tempfile.TemporaryDirectory() as directory:
            result = self.cli(Path(directory, "missing.jsonl"))
        self.assertEqual(result.returncode, 2)


if __name__ == "__main__":
    unittest.main()
