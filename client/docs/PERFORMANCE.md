# Local performance measurements

Startup measurements are opt-in with `NEYRA_PERF=1` in the desktop process
environment. They contain stage names and timings, never chat text, profile
identifiers, server addresses or credentials. The default is disabled.
Other values, including `true`, do not enable measurements. When disabled,
the instrumentation creates no worker, timers, perf IPC calls or log files.

The file is `logs/perf.jsonl` beneath the client's selected data folder (shown
in Settings). It rotates at 256 KiB and keeps three older files named
`perf.jsonl.1` through `perf.jsonl.3`. Rotation can remove earlier stages of an
old process; the report keeps the stages that remain.

## Startup stages

All elapsed times use the Rust process's monotonic clock:

- `process`: entry to `run()`, before applying graphics recovery settings.
- `rust_setup`: entry to Tauri's setup callback.
- `webview_ready`: main WebView JavaScript entry point, reported through IPC.
- `first_render`: initial React mount commit followed by two animation
  frames, reported through IPC. This allows a paint opportunity, not a guarantee that
  pixels have been presented by the compositor.
- `connected`: first accepted bridge `hello` event. This can include time spent
  by the user selecting a profile or connecting; it is not network latency.

WebView markers are timed when Rust receives their IPC, so IPC scheduling is
included. Stage markers are recorded once per process. Strict Mode rerenders
and subsequent reconnects do not create additional startup samples.

## Log format

The local log uses JSON Lines, one record per stage. Each record repeats the
metadata so rotated files can be inspected independently:

```json
{"schema_version":1,"run_id":"00000000-0000-4000-8000-000000000001","stage":"rust_setup","elapsed_ms":12.5,"os":"linux","graphics_backend":"wayland","graphics_backend_source":"graphics_setting","graphics_mode":"compatibility","library_mode":"bundled"}
```

- `run_id`: random identifier for this process, unrelated to user or chat IDs.
- `elapsed_ms`: monotonic time since the Rust entry point. Dynamic loader and
  launcher time before the entry point are outside this measurement.
- `stage`: `process`, `rust_setup`, `webview_ready`, `first_render`, `connected`.
- `os`: Rust target OS name.
- `graphics_backend`: `wayland` / `x11` when known, otherwise `null`.
- `graphics_mode`: the saved Linux graphics setting, limited to `auto`,
  `wayland`, `wayland-nvidia`, `x11` or `compatibility`; other values are `null`.
- `library_mode`: `bundled` / `system` when known, otherwise `null`.

On Linux, graphics metadata uses `GDK_BACKEND` first, then the
`XDG_SESSION_TYPE` hint. The `graphics_backend_source` is `graphics_setting`
when the application applied a graphics recovery setting
(`NEYRA_GRAPHICS_APPLIED=1`); otherwise it is `gdk_backend` for `GDK_BACKEND`
or `session_type` for the session hint. The saved `graphics_mode` distinguishes
`auto` from `compatibility` even when both report `wayland`, so their startup
measurements can be compared. These fields describe settings and environment,
not a GPU/renderer probe; session type can differ from the backend actually
chosen by GTK.

Library metadata can be annotated explicitly with
`NEYRA_LIBRARY_MODE=bundled` or `NEYRA_LIBRARY_MODE=system`. This variable only
labels the measurement; it does not change library loading. Otherwise an
AppImage environment (`APPIMAGE` / `APPDIR`) is labeled `bundled`, and a native
Linux or Windows run is labeled `system`. For comparisons involving a custom
launcher, use the explicit annotation that matches its actual behavior.

An absent `connected` marker is expected for an offline run. A startup log does
not establish a frame-rate, idle CPU/RAM or packaged performance budget.

## Report

From the repository root:

```sh
python devtools/perf-report /path/to/Neyra/logs/perf.jsonl
python devtools/perf-report /path/to/Neyra/logs/perf.jsonl*
```

The second command includes rotated files. Input file order does not matter
within a process: the script groups records by `run_id` and prints one table
with elapsed milliseconds and the delta from the preceding startup stage.
`missing` marks absent stages; their deltas remain `-`. A timestamp earlier
than its predecessor is shown as `out-of-order`, without a misleading negative
duration. Each report includes the graphics backend, saved graphics mode and
library mode. Unknown metadata, including older logs without `graphics_mode`,
is printed as `unknown`.

Malformed records, unsupported schemas and conflicting metadata produce a
warning on stderr and are skipped. Duplicate stages use the earliest marker.
Exit status is 0 when there are valid records, 1 when none are valid and 2 for
file/encoding/argument errors. Standard input is supported with `-`. The script
uses Python's standard library and does not start the application or use the
network.

Offline report regressions:

```sh
python -m unittest discover -s devtools -p 'test_perf_report.py'
```

## Streaming and history

Chat tokens publish accumulated text in batches with one pending 60 ms timer.
There is no polling while idle. Completion, cancellation, errors, disconnect,
thread switches and unmount cancel pending partial updates. Completed messages
update history; partial text is separate state and does not trigger `save_chats`.

`src/streaming.test.ts` checks the batch limit with 1000 tokens over one second
(17 publications), cleanup and no idle timer. `src/useDesktop.test.ts` drives
mocked desktop events through the hook: 1000 partial tokens produce no history
writes, and a completed answer produces one save. All use fake timers and mock
IPC, without a server. Run these with the normal `npm test` suite.
