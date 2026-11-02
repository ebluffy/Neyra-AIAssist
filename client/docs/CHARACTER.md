# Desktop character (PLAN section 3b.6)

Off by default. With `character_enabled: false` in `settings/app.json` no overlay
window exists and the 3D code is never loaded (it is a separate Vite chunk, about
770 kB, fetched only by the overlay window when a model is selected).

Licence research and asset table: `character/LICENSES.md`. No third-party `.vrm`
or animation file is bundled. Desktop Mate was studied from public pages only; its
EULA forbids reverse engineering, so none was done, and none of its code or assets
is used.

## What exists

| Part | Where |
|---|---|
| On/off switch (single source) | `settings/app.json` `character_enabled`, checkbox «Персонаж на рабочем столе» on the Settings screen |
| Other options: model file, FPS 10-60, always-on-top, click-through, pause flags | `settings/character.json` (versioned, broken file is kept and reported) |
| Capability report per platform, shown in the UI | `character.rs` `capabilities()` |
| Overlay window: transparent, no frame, always-on-top, skip taskbar, click-through, content protection | `character.rs` `open_overlay()` |
| VRM licence reader (VRM 0.x and 1.0 meta, GLB header checks, 64 MB cap) | `character.rs` `parse_vrm_info()` |
| Model load over IPC, only while enabled, name must be a plain `.vrm` in `character/` | `character_model_load` |
| Renderer: three.js + `@pixiv/three-vrm`, breathing, blink, look-at, state poses, mouth, FPS limit, pause when hidden | `src/overlay/renderer.ts` |
| Cursor look-at: Rust polls the cursor every 50 ms while the overlay exists | `watch_cursor()` |
| Lip-sync: Rust turns the TTS WAV into 20 ms loudness frames just before playback; overlay plays them from that moment | `mouth_levels()`, `emit_mouth()`, `src/lipsync.ts` |
| Voice states (listening / thinking / speaking / idle) from `desktop-event` | `src/overlay/state.ts` |
| Fallback marker when no model is selected or loading fails | `src/overlay/fallback.ts` |

The mouth follows loudness only (one `aa` expression), not visemes. Sync is the
playback start time, so a stalled output device can drift.

## Platform behaviour

| Platform | Transparent | Always on top | Click-through | Hidden from screenshots |
|---|---|---|---|---|
| Windows | yes | yes | yes | yes (Windows 10 2004+) |
| Linux X11 | yes (needs compositor) | yes | yes | no |
| KDE Wayland | yes | not guaranteed: use a KWin window rule for "Neyra character" | yes | no |
| GNOME Wayland | yes | not guaranteed: run Neyra with graphics mode X11 (XWayland) | yes | no |

The UI shows these values for the current session; nothing degrades silently.
Layer-shell is not implemented. Cursor position may be unavailable on Wayland;
the character then keeps looking forward.

## Security notes

- The overlay is our own bundled page. Tauri allows app commands from every
  window, so the overlay page could call them too. It loads no remote content.
  The CSP gained `blob:` for `img-src` and `connect-src` so embedded VRM textures
  can load; nothing remote was added (a test checks this).
- Models are read-only local files. Licence info is shown to the user; only
  `redistribution: allowed` models may ever be considered for an installer.

## Checks

- `cargo test` (VRM meta, model path rules, mouth frames, settings, capabilities).
- `npm test` (animation, state map, mouth playback).
- `python tests/overlay_smoke.py`: headless Chrome with software WebGL loads the
  synthetic model `tests/fixtures/neyra-test.vrm` (made by
  `scripts/make-test-vrm.mjs`, CC0), writes the mouth expression, and checks the
  background is transparent.

Not checked: a real VRM with textures and spring bones, GPU speed, the overlay on
a real KDE/GNOME/Windows desktop, click-through on Wayland, always-on-top, the
test matrix in PLAN 3b.6, idle CPU/GPU numbers. Animations from Mixamo or VRMA
files are not loaded yet.
