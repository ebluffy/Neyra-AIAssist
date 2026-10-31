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

Programs started by Neyra (browser, terminal, media tools) must not inherit
AppImage paths. This is handled in `src-tauri/src/policy.rs` (`child_environment`)
and covered by its tests: unset, empty and custom `LD_LIBRARY_PATH` are restored,
and `APPDIR`, `APPIMAGE`, `ARGV0`, `OWD` are removed for children only. The
updater runs in the parent process and still sees `APPIMAGE`. Nothing in the
updater or character code changes this.

## What was checked in the cloud (Ubuntu VM, no GPU)

- `tauri build --bundles appimage` with the test key produced a signed AppImage
  and `.sig` bound to the version.
- The AppImage started under Xvfb with a temporary HOME, kept running, created
  `~/.local/share/neyra` (no `Documents` folder there) with `character_enabled:
  false`.
- Not checked: CachyOS, KDE Wayland, NVIDIA, system-library mode, Windows.

## Windows

NSIS `setup.exe`, per-user install, passive updater install. No code-signing
certificate yet, so SmartScreen warns.
