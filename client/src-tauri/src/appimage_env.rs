//! Child processes must not inherit the AppImage library path or its markers.
//! The parent keeps `APPIMAGE` so the updater can replace the original file.

use std::{
    collections::HashMap,
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Debug, Default, PartialEq, Eq)]
pub struct EnvEdit {
    pub set: Vec<(OsString, OsString)>,
    pub remove: Vec<OsString>,
}

const MARKERS: &[&str] = &["APPDIR", "APPIMAGE", "ARGV0", "OWD"];

const PATH_VARS: &[&str] = &[
    "LD_LIBRARY_PATH",
    "LD_PRELOAD",
    "PATH",
    "GTK_PATH",
    "GTK_EXE_PREFIX",
    "GTK_DATA_PREFIX",
    "GTK_IM_MODULE_FILE",
    "GTK_MODULES",
    "GTK3_MODULES",
    "GIO_EXTRA_MODULES",
    "GIO_MODULE_DIR",
    "GI_TYPELIB_PATH",
    "GDK_PIXBUF_MODULE_FILE",
    "GDK_PIXBUF_MODULEDIR",
    "GSETTINGS_SCHEMA_DIR",
    "QT_PLUGIN_PATH",
    "PYTHONPATH",
    "XDG_DATA_DIRS",
    "WEBKIT_EXEC_PATH",
    "WEBKIT_INJECTED_BUNDLE_PATH",
];

const GRAPHICS: &[(&str, &str)] = &[
    ("GDK_BACKEND", "NEYRA_ORIGINAL_GDK_BACKEND"),
    ("WEBKIT_DISABLE_DMABUF_RENDERER", "NEYRA_ORIGINAL_DMABUF"),
    ("__NV_DISABLE_EXPLICIT_SYNC", "NEYRA_ORIGINAL_EXPLICIT_SYNC"),
];

/// glibc `execvp` default. Used only to find a program when AppImage left PATH unset.
const DEFAULT_PATH: &str = "/usr/bin:/bin";

pub fn child_env_edit(env: &HashMap<OsString, OsString>) -> EnvEdit {
    #[cfg(target_os = "linux")]
    {
        linux_edit(env)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = env;
        EnvEdit::default()
    }
}

pub fn apply_std(command: &mut Command) {
    let env = std::env::vars_os().collect();
    apply_edit(command, &child_env_edit(&env));
}

pub fn apply_async(command: &mut tokio::process::Command) {
    let env = std::env::vars_os().collect();
    apply_edit(command, &child_env_edit(&env));
}

pub fn command_path() -> Option<OsString> {
    launch_path(&std::env::vars_os().collect())
}

fn launch_path(env: &HashMap<OsString, OsString>) -> Option<OsString> {
    if let Some(path) = path_from_env(env) {
        return Some(path);
    }
    #[cfg(target_os = "linux")]
    if appimage(env) {
        return Some(OsString::from(DEFAULT_PATH));
    }
    None
}

fn path_from_env(env: &HashMap<OsString, OsString>) -> Option<OsString> {
    let edit = child_env_edit(env);
    if let Some((_, value)) = edit.set.iter().find(|(key, _)| key == "PATH") {
        return Some(value.clone());
    }
    if edit.remove.iter().any(|key| key == "PATH") {
        return None;
    }
    env.get(OsStr::new("PATH")).cloned()
}

trait CommandEnv {
    fn set(&mut self, key: &OsStr, value: &OsStr);
    fn unset(&mut self, key: &OsStr);
}

impl CommandEnv for Command {
    fn set(&mut self, key: &OsStr, value: &OsStr) {
        self.env(key, value);
    }
    fn unset(&mut self, key: &OsStr) {
        self.env_remove(key);
    }
}

impl CommandEnv for tokio::process::Command {
    fn set(&mut self, key: &OsStr, value: &OsStr) {
        self.env(key, value);
    }
    fn unset(&mut self, key: &OsStr) {
        self.env_remove(key);
    }
}

fn apply_edit(command: &mut impl CommandEnv, edit: &EnvEdit) {
    for key in &edit.remove {
        command.unset(key);
    }
    for (key, value) in &edit.set {
        command.set(key, value);
    }
}

#[cfg(target_os = "linux")]
fn appimage(env: &HashMap<OsString, OsString>) -> bool {
    MARKERS.iter().any(|key| env.contains_key(OsStr::new(*key)))
}

#[cfg(target_os = "linux")]
fn get<'a>(env: &'a HashMap<OsString, OsString>, key: &str) -> Option<&'a OsStr> {
    env.get(OsStr::new(key)).map(OsString::as_os_str)
}

#[cfg(target_os = "linux")]
fn bundled_path(path: &Path, mount: Option<&Path>) -> bool {
    if let Some(mount) = mount {
        if !mount.as_os_str().is_empty() && path.starts_with(mount) {
            return true;
        }
    }
    path.components().any(|component| {
        component
            .as_os_str()
            .to_string_lossy()
            .starts_with(".mount_")
    })
}

#[cfg(target_os = "linux")]
fn restored_path(
    current: Option<&OsStr>,
    original: Option<&OsStr>,
    mount: Option<&Path>,
) -> Option<OsString> {
    if let Some(original) = original {
        return Some(original.to_os_string());
    }
    let value = current?;
    if value.is_empty() {
        return Some(OsString::new());
    }
    let kept: Vec<PathBuf> = std::env::split_paths(value)
        .filter(|path| !path.as_os_str().is_empty() && !bundled_path(path, mount))
        .collect();
    if kept.is_empty() {
        None
    } else {
        std::env::join_paths(kept).ok()
    }
}

#[cfg(target_os = "linux")]
fn linux_edit(env: &HashMap<OsString, OsString>) -> EnvEdit {
    let mut edit = EnvEdit::default();
    if appimage(env) {
        let mount = get(env, "APPDIR")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from);
        for name in PATH_VARS {
            let old = format!("OLD_{name}");
            match restored_path(get(env, name), get(env, &old), mount.as_deref()) {
                Some(value) => edit.set.push((OsString::from(*name), value)),
                None => edit.remove.push(OsString::from(*name)),
            }
            edit.remove.push(OsString::from(old));
        }
        for name in MARKERS {
            edit.remove.push(OsString::from(*name));
        }
    }
    let applied = env.contains_key(OsStr::new("NEYRA_GRAPHICS_APPLIED"));
    for (key, original) in GRAPHICS {
        if applied {
            match get(env, original) {
                Some(value) => edit.set.push((OsString::from(*key), value.to_os_string())),
                None => edit.remove.push(OsString::from(*key)),
            }
        }
        edit.remove.push(OsString::from(*original));
    }
    edit.remove.push(OsString::from("NEYRA_GRAPHICS_APPLIED"));
    edit
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: &[(&str, &str)]) -> HashMap<OsString, OsString> {
        pairs
            .iter()
            .map(|(key, value)| (OsString::from(*key), OsString::from(*value)))
            .collect()
    }

    #[test]
    fn preparing_a_child_leaves_appimage_on_the_parent_process() {
        let before = std::env::var_os("APPIMAGE");
        let mut command = Command::new("neyra-child-env-test");
        apply_std(&mut command);
        assert_eq!(std::env::var_os("APPIMAGE"), before);
    }

    #[test]
    fn edit_keeps_the_parent_map_and_drops_appimage_from_the_plan() {
        let env = map(&[
            ("APPIMAGE", "/home/me/Neyra.AppImage"),
            ("APPDIR", "/tmp/.mount_N"),
            ("LD_LIBRARY_PATH", "/tmp/.mount_N/usr/lib"),
        ]);
        let before = env.clone();
        let edit = child_env_edit(&env);
        assert_eq!(env, before);
        #[cfg(target_os = "linux")]
        {
            assert!(edit.remove.iter().any(|key| key == "APPIMAGE"));
            assert!(edit.set.iter().all(|(key, _)| key != "APPIMAGE"));
            assert!(edit.remove.iter().any(|key| key == "LD_LIBRARY_PATH"));
        }
        #[cfg(not(target_os = "linux"))]
        {
            assert!(edit.set.is_empty() && edit.remove.is_empty());
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn launch_path_uses_the_default_only_when_appimage_cleared_path() {
        let cleared = map(&[
            ("APPDIR", "/tmp/.mount_N"),
            ("APPIMAGE", "/home/me/Neyra.AppImage"),
            ("PATH", "/tmp/.mount_N/usr/bin"),
        ]);
        assert!(path_from_env(&cleared).is_none());
        assert_eq!(launch_path(&cleared).unwrap(), OsString::from(DEFAULT_PATH));
        let empty = map(&[
            ("APPDIR", "/tmp/.mount_N"),
            ("APPIMAGE", "/home/me/Neyra.AppImage"),
            ("PATH", ""),
        ]);
        assert_eq!(launch_path(&empty).unwrap(), OsString::from(""));
        let custom = map(&[("PATH", "/custom/bin:/usr/bin")]);
        assert_eq!(
            launch_path(&custom).unwrap(),
            OsString::from("/custom/bin:/usr/bin")
        );
        let unset = map(&[("FOO", "bar")]);
        assert!(launch_path(&unset).is_none());
        assert_eq!(command_path(), launch_path(&std::env::vars_os().collect()));
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn windows_edit_ignores_markers_and_keeps_the_process_path() {
        for pairs in [
            &[("LD_LIBRARY_PATH", "/custom/lib")][..],
            &[("LD_LIBRARY_PATH", "")],
            &[
                ("APPIMAGE", r"C:\Neyra.AppImage"),
                ("APPDIR", r"C:\mount"),
                ("LD_LIBRARY_PATH", r"C:\custom\lib"),
            ],
        ] {
            let edit = child_env_edit(&map(pairs));
            assert!(edit.set.is_empty() && edit.remove.is_empty());
        }
        assert_eq!(command_path(), std::env::var_os("PATH"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_spawn_keeps_unset_empty_and_custom_library_path() {
        let comspec = std::env::var("COMSPEC").unwrap();
        let system_root = std::env::var("SYSTEMROOT").unwrap();
        let probe = |preset: Option<&str>| {
            let mut command = Command::new(&comspec);
            command.args(["/d", "/c", "set LD_LIBRARY_PATH& set APPIMAGE"]);
            command.env_clear();
            command.env("SYSTEMROOT", &system_root);
            command.env("COMSPEC", &comspec);
            if let Some(value) = preset {
                command.env("LD_LIBRARY_PATH", value);
            }
            command.env("APPIMAGE", r"C:\Neyra.AppImage");
            apply_std(&mut command);
            let output = command.output().unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8_lossy(&output.stdout).into_owned()
        };
        let unset = probe(None);
        assert!(
            unset.contains("LD_LIBRARY_PATH") && unset.contains("not defined"),
            "{unset}"
        );
        assert!(unset.contains(r"APPIMAGE=C:\Neyra.AppImage"), "{unset}");
        let empty = probe(Some(""));
        assert!(
            empty
                .lines()
                .any(|line| line.trim_end() == "LD_LIBRARY_PATH="),
            "{empty}"
        );
        let custom = probe(Some(r"C:\custom\lib"));
        assert!(
            custom.contains(r"LD_LIBRARY_PATH=C:\custom\lib"),
            "{custom}"
        );
    }

    #[cfg(target_os = "linux")]
    struct Case {
        name: &'static str,
        pairs: &'static [(&'static str, &'static str)],
        present: &'static [(&'static str, &'static str)],
        absent: &'static [&'static str],
    }

    #[cfg(target_os = "linux")]
    fn cases() -> Vec<Case> {
        const MARKER_PAIRS: &[(&str, &str)] = &[
            ("FOO", "bar"),
            ("APPDIR", "/tmp/.mount_N"),
            ("APPIMAGE", "/home/me/Neyra.AppImage"),
            ("ARGV0", "Neyra"),
            ("OWD", "/home/me"),
        ];
        const MARKER_KEYS: &[&str] = &["APPDIR", "APPIMAGE", "ARGV0", "OWD"];
        vec![
            Case {
                name: "no markers, LD unset",
                pairs: &[("FOO", "bar")],
                present: &[("FOO", "bar")],
                absent: &["LD_LIBRARY_PATH", "APPIMAGE", "APPDIR", "ARGV0", "OWD"],
            },
            Case {
                name: "no markers, LD empty",
                pairs: &[("FOO", "bar"), ("LD_LIBRARY_PATH", "")],
                present: &[("FOO", "bar"), ("LD_LIBRARY_PATH", "")],
                absent: &["APPIMAGE", "APPDIR"],
            },
            Case {
                name: "no markers, LD custom",
                pairs: &[("FOO", "bar"), ("LD_LIBRARY_PATH", "/my/lib")],
                present: &[("FOO", "bar"), ("LD_LIBRARY_PATH", "/my/lib")],
                absent: &["APPIMAGE", "APPDIR", "ARGV0", "OWD"],
            },
            Case {
                name: "no markers, mount-like LD stays",
                pairs: &[
                    ("FOO", "bar"),
                    ("LD_LIBRARY_PATH", "/tmp/.mount_custom/lib"),
                ],
                present: &[("LD_LIBRARY_PATH", "/tmp/.mount_custom/lib")],
                absent: &["APPIMAGE"],
            },
            Case {
                name: "markers, LD unset",
                pairs: MARKER_PAIRS,
                present: &[("FOO", "bar")],
                absent: &["LD_LIBRARY_PATH", "APPDIR", "APPIMAGE", "ARGV0", "OWD"],
            },
            Case {
                name: "markers, LD empty",
                pairs: &[
                    ("FOO", "bar"),
                    ("APPDIR", "/tmp/.mount_N"),
                    ("APPIMAGE", "/home/me/Neyra.AppImage"),
                    ("ARGV0", "Neyra"),
                    ("OWD", "/home/me"),
                    ("LD_LIBRARY_PATH", ""),
                ],
                present: &[("LD_LIBRARY_PATH", ""), ("FOO", "bar")],
                absent: MARKER_KEYS,
            },
            Case {
                name: "markers, OLD LD empty",
                pairs: &[
                    ("FOO", "bar"),
                    ("APPDIR", "/tmp/.mount_N"),
                    ("APPIMAGE", "/home/me/Neyra.AppImage"),
                    ("ARGV0", "Neyra"),
                    ("OWD", "/home/me"),
                    ("OLD_LD_LIBRARY_PATH", ""),
                    ("LD_LIBRARY_PATH", "/tmp/.mount_N/usr/lib"),
                ],
                present: &[("LD_LIBRARY_PATH", "")],
                absent: &["APPDIR", "APPIMAGE", "ARGV0", "OWD", "OLD_LD_LIBRARY_PATH"],
            },
            Case {
                name: "markers, OLD LD custom",
                pairs: &[
                    ("FOO", "bar"),
                    ("APPDIR", "/tmp/.mount_N"),
                    ("APPIMAGE", "/home/me/Neyra.AppImage"),
                    ("ARGV0", "Neyra"),
                    ("OWD", "/home/me"),
                    ("OLD_LD_LIBRARY_PATH", "/my/lib"),
                    ("LD_LIBRARY_PATH", "/tmp/.mount_N/usr/lib:/other"),
                ],
                present: &[("LD_LIBRARY_PATH", "/my/lib")],
                absent: &["APPDIR", "APPIMAGE", "ARGV0", "OWD", "OLD_LD_LIBRARY_PATH"],
            },
            Case {
                name: "markers, mixed LD",
                pairs: &[
                    ("FOO", "bar"),
                    ("APPDIR", "/tmp/.mount_N"),
                    ("APPIMAGE", "/home/me/Neyra.AppImage"),
                    ("ARGV0", "Neyra"),
                    ("OWD", "/home/me"),
                    (
                        "LD_LIBRARY_PATH",
                        "/tmp/.mount_N/usr/lib:/opt/lib:/run/user/1/.mount_other/lib",
                    ),
                ],
                present: &[("LD_LIBRARY_PATH", "/opt/lib")],
                absent: MARKER_KEYS,
            },
            Case {
                name: "markers, custom LD only",
                pairs: &[
                    ("FOO", "bar"),
                    ("APPDIR", "/tmp/.mount_N"),
                    ("APPIMAGE", "/home/me/Neyra.AppImage"),
                    ("ARGV0", "Neyra"),
                    ("OWD", "/home/me"),
                    ("LD_LIBRARY_PATH", "/opt/lib"),
                ],
                present: &[("LD_LIBRARY_PATH", "/opt/lib")],
                absent: MARKER_KEYS,
            },
            Case {
                name: "markers, mount-only LD",
                pairs: &[
                    ("FOO", "bar"),
                    ("APPDIR", "/tmp/.mount_N"),
                    ("APPIMAGE", "/home/me/Neyra.AppImage"),
                    ("ARGV0", "Neyra"),
                    ("OWD", "/home/me"),
                    ("LD_LIBRARY_PATH", "/tmp/.mount_N/usr/lib"),
                ],
                present: &[("FOO", "bar")],
                absent: &["LD_LIBRARY_PATH", "APPDIR", "APPIMAGE", "ARGV0", "OWD"],
            },
            Case {
                name: "markers, trailing colon is unset",
                pairs: &[
                    ("FOO", "bar"),
                    ("APPDIR", "/tmp/.mount_N"),
                    ("APPIMAGE", "/home/me/Neyra.AppImage"),
                    ("LD_LIBRARY_PATH", "/tmp/.mount_N/usr/lib:"),
                ],
                present: &[("FOO", "bar")],
                absent: &["LD_LIBRARY_PATH", "APPIMAGE", "APPDIR"],
            },
            Case {
                name: "APPIMAGE without APPDIR",
                pairs: &[
                    ("FOO", "bar"),
                    ("APPIMAGE", "/home/me/Neyra.AppImage"),
                    ("ARGV0", "Neyra"),
                    ("OWD", "/home/me"),
                    ("LD_LIBRARY_PATH", "/tmp/.mount_Z/usr/lib:/opt/lib"),
                ],
                present: &[("LD_LIBRARY_PATH", "/opt/lib"), ("FOO", "bar")],
                absent: &["APPIMAGE", "ARGV0", "OWD", "APPDIR"],
            },
            Case {
                name: "gtk gio gdk webkit paths",
                pairs: &[
                    ("FOO", "bar"),
                    ("APPDIR", "/tmp/.mount_N"),
                    ("APPIMAGE", "/home/me/Neyra.AppImage"),
                    ("ARGV0", "Neyra"),
                    ("OWD", "/home/me"),
                    ("GTK_PATH", "/tmp/.mount_N/usr/lib/gtk-3.0"),
                    ("GTK_DATA_PREFIX", "/tmp/.mount_N"),
                    ("GTK_EXE_PREFIX", "/tmp/.mount_N"),
                    ("GTK_IM_MODULE_FILE", "/tmp/.mount_N/immodules.cache"),
                    ("GIO_EXTRA_MODULES", "/tmp/.mount_N/usr/lib/gio/modules"),
                    ("GI_TYPELIB_PATH", "/tmp/.mount_N/usr/lib/girepository-1.0"),
                    (
                        "GDK_PIXBUF_MODULE_FILE",
                        "/tmp/.mount_N/usr/lib/gdk-pixbuf/loaders.cache",
                    ),
                    ("WEBKIT_EXEC_PATH", "/tmp/.mount_N/usr/lib/webkit2gtk-4.1"),
                    (
                        "WEBKIT_INJECTED_BUNDLE_PATH",
                        "/tmp/.mount_N/usr/lib/webkit2gtk-4.1/injected-bundle",
                    ),
                    (
                        "GSETTINGS_SCHEMA_DIR",
                        "/tmp/.mount_N/usr/share/glib-2.0/schemas",
                    ),
                    ("XDG_DATA_DIRS", "/tmp/.mount_N/usr/share:/usr/share"),
                    ("LD_PRELOAD", "/tmp/.mount_N/libhack.so:/usr/lib/libnice.so"),
                ],
                present: &[
                    ("FOO", "bar"),
                    ("XDG_DATA_DIRS", "/usr/share"),
                    ("LD_PRELOAD", "/usr/lib/libnice.so"),
                ],
                absent: &[
                    "APPDIR",
                    "APPIMAGE",
                    "ARGV0",
                    "OWD",
                    "GTK_PATH",
                    "GTK_DATA_PREFIX",
                    "GTK_EXE_PREFIX",
                    "GTK_IM_MODULE_FILE",
                    "GIO_EXTRA_MODULES",
                    "GI_TYPELIB_PATH",
                    "GDK_PIXBUF_MODULE_FILE",
                    "WEBKIT_EXEC_PATH",
                    "WEBKIT_INJECTED_BUNDLE_PATH",
                    "GSETTINGS_SCHEMA_DIR",
                ],
            },
            Case {
                name: "graphics forced backend is cleared",
                pairs: &[
                    ("FOO", "bar"),
                    ("NEYRA_GRAPHICS_APPLIED", "1"),
                    ("GDK_BACKEND", "wayland"),
                    ("WEBKIT_DISABLE_DMABUF_RENDERER", "1"),
                ],
                present: &[("FOO", "bar")],
                absent: &[
                    "GDK_BACKEND",
                    "WEBKIT_DISABLE_DMABUF_RENDERER",
                    "NEYRA_GRAPHICS_APPLIED",
                    "NEYRA_ORIGINAL_GDK_BACKEND",
                    "NEYRA_ORIGINAL_DMABUF",
                    "LD_LIBRARY_PATH",
                ],
            },
            Case {
                name: "graphics previous backend is restored",
                pairs: &[
                    ("FOO", "bar"),
                    ("NEYRA_GRAPHICS_APPLIED", "1"),
                    ("GDK_BACKEND", "wayland"),
                    ("NEYRA_ORIGINAL_GDK_BACKEND", "x11"),
                ],
                present: &[("FOO", "bar"), ("GDK_BACKEND", "x11")],
                absent: &["NEYRA_GRAPHICS_APPLIED", "NEYRA_ORIGINAL_GDK_BACKEND"],
            },
            Case {
                name: "markers, PATH keeps system dirs",
                pairs: &[
                    ("FOO", "bar"),
                    ("APPDIR", "/tmp/.mount_N"),
                    ("APPIMAGE", "/home/me/Neyra.AppImage"),
                    ("PATH", "/tmp/.mount_N/usr/bin:/usr/bin:/bin"),
                ],
                present: &[("PATH", "/usr/bin:/bin"), ("FOO", "bar")],
                absent: &["APPDIR", "APPIMAGE"],
            },
            Case {
                name: "markers, OLD PATH empty",
                pairs: &[
                    ("FOO", "bar"),
                    ("APPDIR", "/tmp/.mount_N"),
                    ("APPIMAGE", "/home/me/Neyra.AppImage"),
                    ("OLD_PATH", ""),
                    ("PATH", "/tmp/.mount_N/usr/bin"),
                ],
                present: &[("PATH", ""), ("FOO", "bar")],
                absent: &["OLD_PATH", "APPIMAGE", "APPDIR"],
            },
        ]
    }

    #[cfg(target_os = "linux")]
    fn env_program() -> PathBuf {
        for candidate in ["/usr/bin/env", "/bin/env"] {
            let path = PathBuf::from(candidate);
            if path.is_file() {
                return path;
            }
        }
        panic!("env program is missing");
    }

    #[cfg(target_os = "linux")]
    fn parse_env(bytes: &[u8]) -> HashMap<String, String> {
        String::from_utf8_lossy(bytes)
            .lines()
            .filter_map(|line| {
                let (key, value) = line.split_once('=')?;
                Some((key.to_string(), value.to_string()))
            })
            .collect()
    }

    #[cfg(target_os = "linux")]
    fn finish(output: std::process::Output, name: &str) -> HashMap<String, String> {
        assert!(
            output.status.success(),
            "{name}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        parse_env(&output.stdout)
    }

    #[cfg(target_os = "linux")]
    fn check(case: &Case, got: &HashMap<String, String>) {
        for key in case.absent {
            assert!(
                !got.contains_key(*key),
                "{} still has {key}={:?}",
                case.name,
                got.get(*key)
            );
        }
        for (key, value) in case.present {
            assert_eq!(
                got.get(*key).map(String::as_str),
                Some(*value),
                "{}",
                case.name
            );
        }
    }

    #[cfg(target_os = "linux")]
    fn spawn_sync(case: &Case) -> HashMap<String, String> {
        let parent = map(case.pairs);
        let edit = child_env_edit(&parent);
        let mut command = Command::new(env_program());
        command.env_clear().envs(&parent);
        apply_edit(&mut command, &edit);
        finish(command.output().expect(case.name), case.name)
    }

    #[cfg(target_os = "linux")]
    async fn spawn_async(case: &Case) -> HashMap<String, String> {
        let parent = map(case.pairs);
        let edit = child_env_edit(&parent);
        let mut command = tokio::process::Command::new(env_program());
        command.env_clear().envs(&parent);
        apply_edit(&mut command, &edit);
        finish(command.output().await.expect(case.name), case.name)
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn sync_launch_covers_ld_library_path_and_appimage_markers() {
        for case in cases() {
            check(&case, &spawn_sync(&case));
        }
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn async_launch_covers_ld_library_path_and_appimage_markers() {
        for case in cases() {
            let sync = spawn_sync(&case);
            let async_child = spawn_async(&case).await;
            check(&case, &sync);
            check(&case, &async_child);
            for key in case
                .absent
                .iter()
                .chain(case.present.iter().map(|(key, _)| key))
            {
                assert_eq!(sync.get(*key), async_child.get(*key), "{} {key}", case.name);
            }
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn apply_std_matches_the_edit_of_the_process_environment() {
        let env = std::env::vars_os().collect();
        let edit = child_env_edit(&env);
        let program = env_program();
        let mut via_process = Command::new(&program);
        apply_std(&mut via_process);
        let mut via_edit = Command::new(&program);
        apply_edit(&mut via_edit, &edit);
        let left = finish(via_process.output().unwrap(), "process");
        let right = finish(via_edit.output().unwrap(), "edit");
        for key in [
            "LD_LIBRARY_PATH",
            "APPIMAGE",
            "APPDIR",
            "ARGV0",
            "OWD",
            "GTK_PATH",
            "GIO_EXTRA_MODULES",
            "GDK_PIXBUF_MODULE_FILE",
            "WEBKIT_EXEC_PATH",
            "PATH",
        ] {
            assert_eq!(left.get(key), right.get(key), "{key}");
        }
    }
}
