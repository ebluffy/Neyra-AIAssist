# Neyra desktop · Windows and Linux

Tauri 2 + React + TypeScript, with a Rust executor. The server owns LLM orchestration, chat history/memory and STT/TTS. This client has an independent UI; dashboard sources are not reused (only the existing Neyra brand icon).

Implemented for PLAN §3b.11 steps 1–3:

- Server profiles, TLS/loopback URL validation, health/API check, OS-keyring tokens, streaming private chat, status, module enable/disable and soft restart.
- Tray open/Stop/quit; first-launch data directory; dark/light UI. No server is required to open settings.
- Separate authenticated voice socket; 16 kHz mono PCM push-to-talk, server STT → normal chat pipeline → bounded WAV TTS, interruptible native playback.
- Live voice (step 5, **Голос** tab): modes push-to-talk, wake word «Нейра» + command, or always listening. See *Live voice* below.
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

On CachyOS, one command checks packages, builds the AppImage, starts it and prints the manual checklist for steps 5–8 (wake word, DPI, overlay, updater). It does not mark those steps done:

```sh
bash client/scripts/acceptance-linux.sh
```

Russian notes: `docs/ACCEPTANCE-LINUX.md`.

## Local data and credentials

The directory is created on first launch with `settings/`, `permissions/`, `commands/`, `logs/`, `audit/`, `character/`, `models/`, `cache/`, `wakeword/`. Settings live in versioned `settings/app.json`, permissions in `permissions/permissions.json`, audit in `audit/actions.json`; `character/`, `models/` and `wakeword/` are empty reservations for later steps.

Windows: Known Folder Documents (including redirected/OneDrive Documents). Linux: XDG Documents, existing `~/Documents`, otherwise `$XDG_DATA_HOME/neyra` (`~/.local/share/neyra`). The exact path is shown under Server. Writes use an atomic replacement and retry transient locks; broken/unknown-version settings are quarantined, restored from the last good copy where possible, and reported.

Tokens are stored only by `keyring`: Windows Credential Manager or Linux Secret Service (KWallet must expose Secret Service). A locked/unavailable keyring produces an error; there is no plaintext fallback. Each local server profile has a separate keyring entry and private session UUID. User settings, executable paths, audit and assets are never uploaded as server configuration.

The current Control API has token roles, not personal user accounts. Desktop requires an **admin** Bearer (the same bar as existing chat). Owner scope is the stable server `api.desktop_owner_id` (default `admin`), never a hash of the token value and never a client-supplied username. Admin Bearer only authenticates; rotating the API token keeps the same desktop history/memory namespace. Separate owners need distinct `desktop_owner_id` values in server config. Device/session manifests exist only in server RAM. Disconnecting a selected device closes its server socket and ends the current session; it must reconnect manually on that PC. Permanent per-device credentials/pairing are not claimed.

## Quick commands and local data (PLAN §3b.5, §3b.10)

User quick commands live only on this PC, one YAML file per command in `Documents/Neyra/commands/`. They are never written to server config or memory, work without a server connection, and are unavailable from Discord, Telegram and the dashboard (the server only sees names, phrase/hotkey texts and tool names of the current session in RAM; no arguments, paths or regexes).

```yaml
schema_version: 1          # optional, defaults to 1; a newer version is rejected, not guessed
name: Режим игры
triggers:                  # 1-4; each has exactly one of phrase / regex / hotkey
  - phrase: режим игры
  - regex: открой сайт (?P<site>[a-z.-]+)   # named groups fill params
  - hotkey: Ctrl+Alt+G     # Windows/X11 only; needs Ctrl, Alt or Super
params:
  - {name: site, default: example.com}
actions:                   # 1-10 fixed client.* calls, run in order
  - tool: client.open_url
    arguments: {url: "https://{site}/"}
on_error: stop             # or continue
confirm: false             # ask once before the whole command
risk: safe                 # must be confirm if a step closes windows
reply: Готово
speak: false               # speaks `reply` with the server TTS when connected
```

- **Matching:** exact phrase after normalization (lowercase, ё→е, no punctuation, optional leading "Нейра"), or a full-match regex. More than one command matching means no local run and the normal LLM turn. Typed chat text is matched on the client; voice phrases are matched by the server against the session's runtime phrase list and answered with `command_match`, then run locally.
- **Safety:** every step goes through the normal PC policy (master switch, allowlists, secret-path deny list, confirmation cards, 30 s expiry, Stop, audit). A command cannot widen permissions, call tools that are not advertised, or run while the session is locked. Regexes use the linear-time `regex` crate with a size limit.
- **Hot reload:** the folder is polled every 1.5 s. A broken file reports file, line and reason in the UI and keeps its last valid version; other commands keep working. Duplicate names/hotkeys, files over 64 KB and symlinks are reported and skipped.
- **Drafts:** "Нейра, запомни команду…" makes the server call `desktop_command_draft`; the client validates the draft, shows a card and saves locally only after confirmation. Nothing is stored on the server.
- **Import/export:** native Save/Open dialogs (Rust side, no JS file access). One JSON file with `settings` (theme, graphics, audit days), `permissions` and `commands`: no device id, server profiles, tokens or audit. Import is limited to 1 MB / 200 commands, shows a preview (new / same / conflict / invalid), supports skip/overwrite/rename and merge/replace (replace first moves old files into `cache/commands-backup-*`). Permissions are imported only on request, never turn the master switch on, and drop application paths that do not exist here or point at secrets. File names are derived from command names (letters, digits, `-`), so a name cannot escape the folder.

`Documents/Neyra/` contains `settings/`, `commands/`, `permissions/`, `logs/`, `audit/`, `character/`, `models/`, `cache/` and `wakeword/`. `settings/app.json` (schema 2) and `permissions/permissions.json` (schema 1) are written atomically (fsync, rename, retry on locked files) after saving the previous valid file as `.bak`. A corrupt, oversized or newer-version file is moved aside (`*.corrupt-*` / `*.unsupported-*`, five kept), the `.bak` is restored if valid, otherwise defaults are used with the device id salvaged and permissions left **off**; Settings shows what happened. Schema 1 settings migrate automatically (the old file is kept as `app.json.v1.bak`). `logs/client.log` rotates at 256 KB and never contains tokens, arguments or output. The folder can be changed under Settings; data is copied, the old folder is left untouched, and the new location is remembered in a small pointer file in the OS config directory (restart required). Audit retention is configurable (default 30 days).

Not covered here: `server_event` actions (user commands are not written to the server's `fast_path`), global hotkeys on Wayland (use the phrase box or buttons), and Windows hardware checks.

## Platforms

- Windows: native window enumeration/focus/close and media commands; application discovery from PATH and App Paths registry. Commands never go through `cmd`/PowerShell.
- Linux X11: optional `wmctrl`, `playerctl`, `pactl` capabilities are advertised only when installed. Discovery scans PATH and XDG application entries without executing `.desktop` text through a shell.
- KDE Wayland: app/browser launches and available media tools; arbitrary window focus/control is not advertised. Global shortcut registration currently uses the native plugin on Windows/X11; Wayland uses visible PTT/Stop buttons until a portal adapter is validated. No fake capability or forced X11 fallback.
- OS lock state: Windows input desktop, Linux systemd `loginctl` LockedHint. If the session cannot be verified, PC tools fail closed while chat stays available. The client polls lock state every two seconds.
- Linux graphics: auto leaves hardware acceleration alone; explicit Wayland, X11, compatibility and owner-specific NVIDIA workaround modes apply before GTK starts. Child processes receive restored host library paths, not AppImage loader paths or private graphics markers. System-library switching/updater testing remain future release work.

Push-to-talk: button; Windows/X11 also Ctrl+Alt+Space while held and Ctrl+Alt+Escape for Stop, if registration succeeds. Microphone data is capped at 30 seconds and not stored on disk. STT adapters may use a short-lived server temp file and delete it after transcription. Configure server `config/voice.yaml` using `voice.example.yaml`; provider secrets stay in server `.env`. No provider keys are sent to the client.

## Live voice

- **Client = mic + playback + local wake word.** STT, TTS and voice conversion run on the server; no provider keys reach the client.
- **Phrase detection:** an energy VAD with an adaptive noise floor (not a neural VAD) and a user sensitivity. A phrase opens after 60 ms of speech with 300 ms pre-roll and ends after the configured pause (0.5–1.5 s); bursts under 300 ms are dropped (`listen.cancel`); phrases are committed before the 30 s server limit.
- **STT is per segment.** No STT lane here streams partial hypotheses, so the server says `partial_transcripts: false` and only a final transcript is shown.
- **Reply audio:** the server speaks each finished sentence while the reply is still being written. Segments are numbered; the client plays them in order, drops late or duplicate ones, and acknowledges each played segment. The server keeps at most 3 unplayed segments on the client and its sentence queue holds 3, so slow playback slows TTS instead of filling memory.
- **Barge-in:** a new phrase (or Stop) cancels the running turn and its audio; packets of the old turn are dropped on both sides.
- **Echo: no AEC.** By default the microphone is muted while Neyra speaks (half-duplex); interrupt with Stop or Ctrl+Alt+Escape. Voice barge-in during playback is an explicit *headphones* option. Muting is not echo cancellation, and nothing claims otherwise.
- **Stop and screen lock turn the live microphone off.**
- **Wake word «Нейра»:** openWakeWord models run locally through `tract` (pure Rust, no onnxruntime, no network). Until the detector fires, no audio leaves the PC; audio before the wake word is never sent. The scoring path matches the Python openWakeWord reference (max score difference ~1e-5 on the same clip). A «Нейра» model is **not bundled**: train one on synthetic clips from `server/scripts/wakeword_synth_dataset.py` (server TTS, no owner recordings) with openWakeWord training, then put into `Documents/Neyra/wakeword/`:
  - `melspectrogram.onnx`, `embedding_model.onnx` — openWakeWord feature models;
  - your classifier, e.g. `neyra_v1.onnx`;
  - `wakeword.json`: `{"schema_version":1,"phrase":"Нейра","language":"ru","model":"neyra_v1.onnx","license":"…","source":"…"}`.
  Stock English models (`hey_jarvis`, `alexa`, …) are refused: they do not detect «Нейра».
- **Licenses:** openWakeWord code is Apache-2.0. Its stock English wake models are CC BY-NC-SA 4.0 and are not used. Check the terms of the feature models from the openWakeWord release you download and record them in `wakeword.json`. A model you train yourself on synthetic TTS clips is yours, but check the TTS provider's terms for training data.
- **Voice conversion (server):** optional stage TTS → conversion → client, configured in `voice.conversion` (`server/config/voice.example.yaml`). Models are read in place from `server/models/`. If conversion fails, `on_error: passthrough` plays the original TTS voice and the client shows a notice; `stop` stops speaking this turn with `conversion_failed`. The RVC backend needs the optional `rvc-python` package on the server.

## Protocols and tests

- `/v1/desktop/bridge`: admin Authorization header, versioned manifest, private chat/history, capabilities updates, device list/disconnect, `client_tool_call` / `client_tool_result` / cancellation.
- `/v1/desktop/voice` (`neyra.voice.v2`): separate admin Authorization header and same session identity, PCM frames ≤32 KB, ≤30 s. PTT: `commit`, `stop`, transcript, chat events, base64 WAV chunks. Live: `listen.begin` / frames / `commit` with `mode: live` / `listen.cancel`, numbered `audio.chunk` + `audio.segment`, `audio.ack`, `status`, `voice.conversion`. Tokens never appear in query strings.
- Internal model tool names use `client_…` for provider compatibility and map to wire `client.…`. Brain sees only the target device's enabled tools; other adapters have no desktop context.

`server/tests/test_desktop_bridge.py` exercises real ASGI/WebSocket routing with fake providers. `tests/ui_smoke.py` uses Playwright with **simulated native IPC**, so it tests UI wiring, not OS keyring/audio or a real WebView. To run it, start `npm run dev` on port 1420, then `python tests/ui_smoke.py` with Playwright installed. Native hardware and two-machine tests remain manual acceptance; CI or Xvfb cannot prove CachyOS/NVIDIA or Windows audio.
