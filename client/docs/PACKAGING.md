# Linux packages: AppImage and deb

Targets built by CI: AppImage and deb on Ubuntu 22.04, NSIS on Windows. The
owner machine is CachyOS (Arch) with KDE Plasma Wayland and NVIDIA.

## Which one on Arch / CachyOS

Use the **AppImage**. Updates replace the file in place.

```sh
chmod +x Neyra_<version>_amd64.AppImage
./Neyra_<version>_amd64.AppImage
```

- Classic AppImages need FUSE 2: `sudo pacman -S fuse2`. Without it run
  `APPIMAGE_EXTRACT_AND_RUN=1 ./Neyra_<version>_amd64.AppImage` (slower start).
  That mode was used for the cloud smoke run below.
- Keep the file somewhere writable by your user (`~/Applications`). The updater
  rewrites it; it cannot update a file in a read-only or root-owned folder.
- The `.deb` is not a native Arch package. Do not install it with `dpkg`. Use the
  AppImage, or build a native package from source later (not provided).
- Optional tools used by the PC contours: `playerctl`, `pulseaudio-utils`/`pactl`,
  `wmctrl` (X11 only). Secrets need a Secret Service provider (KWallet with
  Secret Service enabled, or gnome-keyring); without it the token cannot be saved.

## Graphics (NVIDIA, Wayland)

The AppImage carries its own WebKitGTK built on Ubuntu 22.04. On some Arch setups
a bundled WebKit and the system Mesa/NVIDIA stack disagree. Symptoms: blank or
grey window, EGL errors. Not reproduced here; the cloud VM has no GPU.

Settings -> Server -> Linux graphics (applied at next start, before GTK):

| Mode | Use when |
|---|---|
| Automatic | default, touches nothing |
| Wayland / X11 | force the GDK backend |
| Wayland + NVIDIA workaround | sets `__NV_DISABLE_EXPLICIT_SYNC=1` (worked for the owner in Owyx) |
| Compatibility | sets `WEBKIT_DISABLE_DMABUF_RENDERER=1`; fixes grey windows, slower UI |

Comparing bundled and system WebKit speed is still open (PLAN section 3b, Owyx
block). Do not assume the 30 vs 60 FPS number from Owyx applies to Neyra.

## Child process environment

Programs started by Neyra (shell, browser, terminal helpers, media tools) must not
inherit AppImage paths. `src-tauri/src/appimage_env.rs` restores the child
environment. Unset, empty and custom `LD_LIBRARY_PATH` stay distinct. `APPDIR`,
`APPIMAGE`, `ARGV0` and `OWD` are removed from the child. The parent process keeps
`APPIMAGE` for the updater. Sync launches use `std::process::Command`; chat links
on Linux use `tokio::process::Command`. Windows launches are unchanged. There is
no sidecar process and no file-event watcher.

### AppRun / hook inventory (AR-43)

Audited on 2026-11-03 using the existing `Neyra_0.1.0_amd64.AppImage`
produced on 2026-10-31 (desktop-foundation build), without rebuilding the app.
SHA-256: `4ea67d2ac9124e4d7b0c096feae1d179ab0713101555239ab350706ce762c48d`.
This is evidence for that artifact; the next CI package still needs the same
inspection if bundler or hook versions change.

In a temporary directory, extract just the launchers:

```sh
/path/to/Neyra_0.1.0_amd64.AppImage --appimage-extract 'AppRun*'
/path/to/Neyra_0.1.0_amd64.AppImage --appimage-extract 'apprun-hooks/*'
```

`AppRun` sources only `apprun-hooks/linuxdeploy-plugin-gtk.sh`, then executes
`AppRun.wrapped` (ELF). The hook actively exports `APPDIR`, `GTK_DATA_PREFIX`,
`GTK_THEME`, `XDG_DATA_DIRS`, `GSETTINGS_SCHEMA_DIR`, `GI_TYPELIB_PATH`,
`GIO_MODULE_DIR`, `GTK_EXE_PREFIX`, `GTK_PATH`, `GTK_IM_MODULE_FILE`, and
`GDK_PIXBUF_MODULE_FILE`. Its `GDK_BACKEND=x11` export is commented out;
`APPIMAGE_GTK_THEME`, `COLOR_SCHEME`, and `GTK_THEME_VARIANT` are shell locals.

The wrapped ELF sets `PATH`, `LD_LIBRARY_PATH`, `PYTHONHOME`, `PYTHONPATH`,
`PERLLIB`, `XDG_DATA_DIRS`, `QT_PLUGIN_PATH`, `GSETTINGS_SCHEMA_DIR`,
`GST_PLUGIN_SYSTEM_PATH`, `GST_PLUGIN_SYSTEM_PATH_1_0`, and
`PYTHONDONTWRITEBYTECODE`. Verified with `strings` and by running the extracted
launchers with a temporary `.desktop` containing `Exec=/usr/bin/env` and an
empty `usr/` directory, starting with only `PATH=/usr/bin:/bin`. This executes
the real launchers without starting Neyra. Neither launcher saves `OLD_*`.
The runtime also supplies `APPIMAGE`, `APPDIR`, `ARGV0`, and `OWD`.

The exhaustive cleanup inventory is checked into
`src-tauri/tests/fixtures/appimage-exports.txt` and tested for removal and,
except runtime markers, restoration from `OLD_*`. Path values lose only bundled
components; `GTK_THEME` and `PYTHONDONTWRITEBYTECODE` are restored from `OLD_*`
or removed because the package overwrites them. No gstreamer hook is present
in this artifact; `GST_PLUGIN_SCANNER*` and `GST_PLUGIN_PATH*` are not exported.
Re-audit when enabling that hook or changing the package tooling.

Shell caller variables are applied after parent cleanup. Explicit graphics and
theme values win; explicit path variables retain their non-AppImage components.
The parent environment remains unchanged.

## What was checked in the cloud (Ubuntu VM, no GPU)

- `tauri build --bundles appimage` with the test key produced a signed AppImage
  and `.sig` bound to the version.
- The AppImage started under Xvfb with a temporary HOME, kept running, created
  `~/.local/share/neyra` (no `Documents` folder there) with `character_enabled:
  false`.
- Not checked: CachyOS, KDE Wayland, NVIDIA, system-library mode, Windows.

## Manual acceptance

From the repo root, on the owner machine:

```sh
bash client/scripts/acceptance-linux.sh
```

The script prints the pacman line for anything missing, builds the AppImage,
starts it and writes a step 5–8 checklist (wake word files, current monitor
scale, Wayland session, overlay, local updater test). Steps stay open until
the owner actually runs them. Russian write-up: `ACCEPTANCE-LINUX.md`.

## Windows

NSIS `setup.exe`, per-user install, passive updater install. No code-signing
certificate yet, so SmartScreen warns.
