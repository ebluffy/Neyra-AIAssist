use crate::storage::atomic_write;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, path::Path};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "character";
const SETTINGS_FILE: &str = "settings/character.json";
const MAX_MODELS: usize = 64;

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(deny_unknown_fields)]
pub struct CharacterSettings {
    pub schema_version: u32,
    pub model: Option<String>,
    pub fps_limit: u32,
    pub pause_fullscreen: bool,
    pub pause_battery: bool,
    pub always_on_top: bool,
    pub click_through: bool,
}

impl Default for CharacterSettings {
    fn default() -> Self {
        Self {
            schema_version: 1,
            model: None,
            fps_limit: 30,
            pause_fullscreen: true,
            pause_battery: true,
            always_on_top: true,
            click_through: true,
        }
    }
}

#[derive(Serialize, PartialEq, Debug)]
pub struct Capabilities {
    pub transparent: &'static str,
    pub always_on_top: &'static str,
    pub click_through: &'static str,
    pub exclude_from_capture: &'static str,
    pub mechanism: &'static str,
    pub notes: Vec<&'static str>,
}

/// Values are "yes", "not_guaranteed" or "no". The UI shows anything other than
/// "yes" so a degraded overlay is never silent.
pub fn capabilities(os: &str, session: &str, desktop: &str) -> Capabilities {
    match os {
        "windows" => Capabilities {
            transparent: "yes",
            always_on_top: "yes",
            click_through: "yes",
            exclude_from_capture: "yes",
            mechanism: "win32",
            notes: vec!["Capture exclusion needs Windows 10 version 2004 or newer."],
        },
        "linux" if session == "wayland" => {
            let kde = desktop.to_ascii_lowercase().contains("kde");
            Capabilities {
                transparent: "yes",
                always_on_top: "not_guaranteed",
                click_through: "yes",
                exclude_from_capture: "no",
                mechanism: if kde { "wayland-kde" } else { "wayland" },
                notes: if kde {
                    vec![
                        "Wayland does not guarantee always-on-top. On KDE use a KWin window rule for the Neyra character window.",
                        "Layer-shell is a possible later mechanism and is not implemented.",
                    ]
                } else {
                    vec![
                        "Wayland does not guarantee always-on-top. On GNOME start Neyra with graphics mode X11 (XWayland) for a working overlay.",
                    ]
                },
            }
        }
        "linux" if session == "x11" => Capabilities {
            transparent: "yes",
            always_on_top: "yes",
            click_through: "yes",
            exclude_from_capture: "no",
            mechanism: "x11",
            notes: vec!["Transparency needs a running compositor."],
        },
        _ => Capabilities {
            transparent: "not_guaranteed",
            always_on_top: "not_guaranteed",
            click_through: "not_guaranteed",
            exclude_from_capture: "no",
            mechanism: "unknown",
            notes: vec!["Unknown platform or session type. Overlay behaviour is untested."],
        },
    }
}

fn detect_capabilities() -> Capabilities {
    let os = if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "other"
    };
    capabilities(
        os,
        &std::env::var("XDG_SESSION_TYPE").unwrap_or_default(),
        &std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default(),
    )
}

/// The single on/off switch lives in settings/app.json (`character_enabled`).
/// A missing, unreadable or broken file means off.
pub fn app_enabled(root: &Path) -> bool {
    fs::read(root.join("settings/app.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<crate::storage::Settings>(&bytes).ok())
        .map(|settings| settings.character_enabled)
        .unwrap_or(false)
}

pub fn on_settings_saved(app: &tauri::AppHandle, enabled: bool) {
    if !enabled {
        close_overlay(app);
    }
}

pub fn valid_model_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 120
        && name.to_ascii_lowercase().ends_with(".vrm")
        && !name.contains(['/', '\\', ':', '\0'])
        && !name.starts_with('.')
}

pub fn validate(settings: &CharacterSettings) -> Result<(), String> {
    if settings.schema_version != 1 {
        return Err("Несовместимая версия настроек персонажа".into());
    }
    if !(10..=60).contains(&settings.fps_limit) {
        return Err("Лимит FPS персонажа: от 10 до 60".into());
    }
    if let Some(name) = &settings.model {
        if !valid_model_name(name) {
            return Err("Некорректное имя файла модели .vrm".into());
        }
    }
    Ok(())
}

pub fn load(root: &Path) -> Result<CharacterSettings, String> {
    let path = root.join(SETTINGS_FILE);
    if !path.exists() {
        return Ok(CharacterSettings::default());
    }
    let settings: CharacterSettings = serde_json::from_slice(
        &fs::read(path).map_err(|_| "Не удалось прочитать настройки персонажа")?,
    )
    .map_err(|_| "Повреждены настройки персонажа. Исходный файл сохранён")?;
    validate(&settings)?;
    Ok(settings)
}

pub fn save(root: &Path, settings: &CharacterSettings) -> Result<(), String> {
    validate(settings)?;
    fs::create_dir_all(root.join("settings")).map_err(|_| "Не удалось создать папку настроек")?;
    atomic_write(
        &root.join(SETTINGS_FILE),
        &serde_json::to_vec_pretty(settings).map_err(|_| "Не удалось сериализовать настройки")?,
    )
}

pub fn list_models(root: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(root.join("character"))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| valid_model_name(n))
        .collect();
    names.sort();
    names.truncate(MAX_MODELS);
    names
}

fn overlay_open(app: &tauri::AppHandle) -> bool {
    app.get_webview_window(LABEL).is_some()
}

fn close_overlay(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.close();
    }
}

fn open_overlay(app: &tauri::AppHandle, settings: &CharacterSettings) -> Result<(), String> {
    if overlay_open(app) {
        return Ok(());
    }
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("overlay.html".into()))
        .title("Neyra character")
        .inner_size(320.0, 480.0)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true)
        .focused(false)
        .always_on_top(settings.always_on_top)
        .content_protected(true)
        .build()
        .map_err(|_| "Не удалось открыть окно персонажа")?;
    if settings.click_through {
        window
            .set_ignore_cursor_events(true)
            .map_err(|_| "Не удалось включить click-through")?;
    }
    Ok(())
}

fn state_value(root: &Path, app: &tauri::AppHandle) -> Result<Value, String> {
    Ok(json!({
        "enabled": app_enabled(root),
        "settings": load(root)?,
        "capabilities": detect_capabilities(),
        "models": list_models(root),
        "overlay_open": overlay_open(app),
        "renderer": "placeholder",
        "directory": root.join("character").to_string_lossy(),
    }))
}

#[tauri::command]
pub fn character_state(app: tauri::AppHandle) -> Result<Value, String> {
    let root = crate::storage::data_root()?;
    state_value(&root, &app)
}

#[tauri::command]
pub fn character_save(app: tauri::AppHandle, settings: CharacterSettings) -> Result<Value, String> {
    let root = crate::storage::data_root()?;
    validate(&settings)?;
    if let Some(name) = &settings.model {
        if !list_models(&root).contains(name) {
            return Err("Файл модели не найден в папке character".into());
        }
    }
    save(&root, &settings)?;
    state_value(&root, &app)
}

#[tauri::command]
pub fn character_overlay(app: tauri::AppHandle, show: bool) -> Result<Value, String> {
    let root = crate::storage::data_root()?;
    if show {
        if !app_enabled(&root) {
            return Err("Персонаж выключен в настройках".into());
        }
        let settings = load(&root)?;
        open_overlay(&app, &settings)?;
    } else {
        close_overlay(&app);
    }
    state_value(&root, &app)
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn temp_root() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(Uuid::new_v4().to_string());
        fs::create_dir_all(root.join("character")).unwrap();
        root
    }

    #[test]
    fn character_is_off_by_default_and_loads_without_a_file() {
        let root = temp_root();
        let settings = load(&root).unwrap();
        assert!(settings.model.is_none());
        assert!(!app_enabled(&root));
        assert!(!root.join(SETTINGS_FILE).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn settings_round_trip_and_reject_bad_values() {
        let root = temp_root();
        let mut settings = CharacterSettings {
            model: Some("avatar.vrm".into()),
            ..Default::default()
        };
        save(&root, &settings).unwrap();
        assert_eq!(load(&root).unwrap(), settings);
        settings.fps_limit = 500;
        assert!(save(&root, &settings).is_err());
        settings.fps_limit = 30;
        for bad in [
            "../x.vrm",
            "a/b.vrm",
            "a\\b.vrm",
            "x.glb",
            ".hidden.vrm",
            "",
        ] {
            settings.model = Some(bad.into());
            assert!(validate(&settings).is_err(), "{bad}");
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn corrupt_settings_file_is_kept_and_reported() {
        let root = temp_root();
        fs::create_dir_all(root.join("settings")).unwrap();
        fs::write(root.join(SETTINGS_FILE), b"{not json").unwrap();
        assert!(load(&root).is_err());
        assert_eq!(fs::read(root.join(SETTINGS_FILE)).unwrap(), b"{not json");
        fs::write(
            root.join(SETTINGS_FILE),
            br#"{"schema_version":1,"surprise":1}"#,
        )
        .unwrap();
        assert!(load(&root).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn only_plain_vrm_files_are_listed() {
        let root = temp_root();
        for name in ["b.vrm", "A.VRM", "notes.txt", "model.glb"] {
            fs::write(root.join("character").join(name), b"x").unwrap();
        }
        fs::create_dir(root.join("character/dir.vrm")).unwrap();
        assert_eq!(list_models(&root), vec!["A.VRM", "b.vrm"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn degraded_platforms_are_reported_not_hidden() {
        assert_eq!(capabilities("windows", "", "").always_on_top, "yes");
        let kde = capabilities("linux", "wayland", "KDE");
        assert_eq!(kde.always_on_top, "not_guaranteed");
        assert_eq!(kde.mechanism, "wayland-kde");
        assert!(!kde.notes.is_empty());
        let gnome = capabilities("linux", "wayland", "GNOME");
        assert_eq!(gnome.mechanism, "wayland");
        assert!(gnome.notes[0].contains("X11"));
        assert_eq!(capabilities("linux", "x11", "KDE").always_on_top, "yes");
        assert_eq!(capabilities("linux", "", "").mechanism, "unknown");
        assert_eq!(capabilities("linux", "x11", "").exclude_from_capture, "no");
    }
}
