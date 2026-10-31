# Neyra desktop · Windows and Linux

Tauri 2 + React + TypeScript, with a Rust executor. The server owns LLM orchestration, chat history/memory and STT/TTS. This client has an independent UI; dashboard sources are not reused (only the existing Neyra brand icon).

Implemented for PLAN §3b.11 steps 1–3:

- Server profiles, TLS/loopback URL validation, health/API check, OS-keyring tokens, streaming private chat, status, module enable/disable and soft restart.
- Tray open/Stop/quit; first-launch data directory; dark/light UI. No server is required to open settings.
- Separate authenticated voice socket; 16 kHz mono PCM push-to-talk, server STT → normal chat pipeline → bounded WAV TTS, interruptible native playback. V1 is half-duplex and returns the final transcript; live sentence streaming, wake word, VAD/AEC/barge-in are later steps.
- Per-device capabilities, local default-off master switch, per-contour settings, app/domain allowlists. Unknown executables/domains and closing windows require a one-time, expiring local confirmation. Arbitrary CLI, file reading/writing and screen/input tools are not available.
- UUID call IDs, deadlines, no automatic reconnect/replay; Stop, permission revocation, disconnect and OS-session lock cancel pending actions. Completed actions, including opened apps, are not undone. OS helper process groups are terminated on cancellation; opened applications are deliberately detached.
- Local content-free action audit, 30-day retention and 2000-row limit. No command parameters, file contents or tokens in audit. Server model trace stores only client tool name/result status.

## Updater and character (beta ship track)

- Updater: Rust-only commands, beta/stable channel, signature and signed-version checks always on, draft-only release workflow, N to N+1 tests against a local server. See `docs/UPDATER.md`.
- Linux packages and CachyOS notes: `docs/PACKAGING.md`.
- Optional desktop character (off by default): `docs/CHARACTER.md`, licences in `character/LICENSES.md`.

## Build and checks

Use Node **22**, stable Rust, and [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). On Linux install WebKitGTK 4.1, GTK 3, ALSA development headers, appindicator and D-Bus development files.

```sh
npm ci --ignore-scripts
npm run lint
npm run typecheck
npm test
npm run build
cd src-tauri
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
cd ..
npm run tauri build -- --bundles deb   # Linux
npm run tauri build -- --bundles nsis  # Windows
```

Dependency lifecycle scripts are disabled for installation; Vite/esbuild and the Tauri CLI use their platform packages. CI produces unsigned test installers (`nsis` / `deb` / `AppImage`) as artifacts, not a signed updater release. Updater plugin + pubkey are wired; `createUpdaterArtifacts` stays off until signing secrets exist — see `docs/UPDATER.md`. Character step-0 license research lives in `character/LICENSES.md` (Desktop Mate assets are not redistributable).

## Local data and credentials

The directory is created on first launch with `settings/`, `permissions/`, `commands/`, `logs/`, `audit/`, `character/`, `models/`, `cache/`. Current settings/permissions live in versioned `settings/app.json`, audit in `audit/actions.json`; later-step directories are empty reservations, not implemented features.

Windows: Known Folder Documents (including redirected/OneDrive Documents). Linux: XDG Documents, existing `~/Documents`, otherwise `$XDG_DATA_HOME/neyra` (`~/.local/share/neyra`). The exact path is shown under Server. Writes use an atomic replacement and retry transient locks; broken/unknown-version settings are preserved and reported rather than overwritten.

Tokens are stored only by `keyring`: Windows Credential Manager or Linux Secret Service (KWallet must expose Secret Service). A locked/unavailable keyring produces an error; there is no plaintext fallback. Each local server profile has a separate keyring entry and private session UUID. User settings, executable paths, audit and assets are never uploaded as server configuration.

The current Control API has token roles, not personal user accounts. Desktop requires an **admin** Bearer (the same bar as existing chat). Owner scope is the stable server `api.desktop_owner_id` (default `admin`), never a hash of the token value and never a client-supplied username. Admin Bearer only authenticates; rotating the API token keeps the same desktop history/memory namespace. Separate owners need distinct `desktop_owner_id` values in server config. Device/session manifests exist only in server RAM. Disconnecting a selected device closes its server socket and ends the current session; it must reconnect manually on that PC. Permanent per-device credentials/pairing are not claimed.

## Platforms

- Windows: native window enumeration/focus/close and media commands; application discovery from PATH and App Paths registry. Commands never go through `cmd`/PowerShell.
- Linux X11: optional `wmctrl`, `playerctl`, `pactl` capabilities are advertised only when installed. Discovery scans PATH and XDG application entries without executing `.desktop` text through a shell.
- KDE Wayland: app/browser launches and available media tools; arbitrary window focus/control is not advertised. Global shortcut registration currently uses the native plugin on Windows/X11; Wayland uses visible PTT/Stop buttons until a portal adapter is validated. No fake capability or forced X11 fallback.
- OS lock state: Windows input desktop, Linux systemd `loginctl` LockedHint. If the session cannot be verified, PC tools fail closed while chat stays available. The client polls lock state every two seconds.
- Linux graphics: auto leaves hardware acceleration alone; explicit Wayland, X11, compatibility and owner-specific NVIDIA workaround modes apply before GTK starts. Child processes receive restored host library paths, not AppImage loader paths or private graphics markers. System-library switching/updater testing remain future release work.

Push-to-talk: button; Windows/X11 also Ctrl+Alt+Space while held and Ctrl+Alt+Escape for Stop, if registration succeeds. Microphone data is capped at 30 seconds and not stored on disk. STT adapters may use a short-lived server temp file and delete it after transcription. Configure server `config/voice.yaml` using `voice.example.yaml`; provider secrets stay in server `.env`. No provider keys are sent to the client.

## Protocols and tests

- `/v1/desktop/bridge`: admin Authorization header, versioned manifest, private chat/history, capabilities updates, device list/disconnect, `client_tool_call` / `client_tool_result` / cancellation.
- `/v1/desktop/voice`: separate admin Authorization header and same session identity, PCM frames ≤32 KB, ≤30 s; `commit`, `stop`, transcript, chat events, base64 WAV chunks. Tokens never appear in query strings.
- Internal model tool names use `client_…` for provider compatibility and map to wire `client.…`. Brain sees only the target device's enabled tools; other adapters have no desktop context.

`server/tests/test_desktop_bridge.py` exercises real ASGI/WebSocket routing with fake providers. `tests/ui_smoke.py` uses Playwright with **simulated native IPC**, so it tests UI wiring, not OS keyring/audio or a real WebView. To run it, start `npm run dev` on port 1420, then `python tests/ui_smoke.py` with Playwright installed. Native hardware and two-machine tests remain manual acceptance; CI or Xvfb cannot prove CachyOS/NVIDIA or Windows audio.
