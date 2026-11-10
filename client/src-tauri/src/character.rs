use crate::storage::atomic_write;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, path::Path};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "character";
const SETTINGS_FILE: &str = "settings/character.json";
const MAX_MODELS: usize = 64;
const MAX_MODEL_BYTES: u64 = 64 * 1024 * 1024;
const MAX_VRM_JSON_BYTES: usize = 8 * 1024 * 1024;
const MOUTH_FRAME_MS: u32 = 20;
const MOUTH_NOISE_FLOOR: f32 = 0.02;
const MOUTH_FULL_SCALE: f32 = 0.25;

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

fn app_theme(root: &Path) -> String {
    let theme = fs::read(root.join("settings/app.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| value.get("theme")?.as_str().map(str::to_string))
        .unwrap_or_else(|| "neyra".into());
    if crate::storage::valid_theme(&theme) {
        theme
    } else {
        "neyra".into()
    }
}

fn on_settings_saved(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
    if !enabled {
        close_overlay(app);
        Ok(())
    } else if let Some(window) = app.get_webview_window(LABEL) {
        let root = crate::storage::data_root()?;
        let settings = load(&root)?;
        // The character settings did not change here, so a refused platform call should
        // roll back to the same values instead of closing a window the user is looking at.
        apply_window_properties(&window, &settings, Some(&settings))?;
        window
            .emit(
                "character-settings",
                serde_json::json!({ "fps_limit": settings.fps_limit }),
            )
            .map_err(|e| format!("Не удалось отправить настройки в окно персонажа: {e}"))?;
        Ok(())
    } else {
        Ok(())
    }
}

/// Refresh a live overlay after a save that is not about the character (theme, permissions).
/// Best effort: a refused platform call must not fail the save or close the overlay the user sees.
pub fn refresh_overlay_after_settings_save(app: &tauri::AppHandle, enabled: bool) {
    if let Err(error) = on_settings_saved(app, enabled) {
        if let Ok(root) = crate::storage::data_root() {
            crate::logs::log(
                &root,
                "warn",
                &format!("character overlay refresh after settings save failed: {error}"),
            );
        }
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

#[derive(Serialize, PartialEq, Debug)]
pub struct ModelInfo {
    pub spec: &'static str,
    pub title: String,
    pub authors: Vec<String>,
    pub license: String,
    pub license_url: String,
    /// "allowed", "not_allowed" or "unknown". Only "allowed" lets a model be
    /// bundled into an installer; anything else stays a local user file.
    pub redistribution: &'static str,
    pub size_bytes: u64,
}

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .chars()
        .take(200)
        .collect()
}

/// Reads the licence block of a .vrm (binary glTF) without loading meshes.
/// Rejects anything that is not a well-formed GLB with a VRM 0.x or 1.0 block.
pub fn parse_vrm_info(bytes: &[u8]) -> Result<ModelInfo, String> {
    let bad = || "Файл не похож на корректную модель VRM".to_string();
    if bytes.len() < 20 || &bytes[0..4] != b"glTF" {
        return Err(bad());
    }
    let word =
        |at: usize| u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]);
    if word(4) != 2 || word(8) as usize != bytes.len() {
        return Err(bad());
    }
    let json_len = word(12) as usize;
    if &bytes[16..20] != b"JSON" || json_len > MAX_VRM_JSON_BYTES || 20 + json_len > bytes.len() {
        return Err(bad());
    }
    let root: Value = serde_json::from_slice(&bytes[20..20 + json_len]).map_err(|_| bad())?;
    let extensions = root.get("extensions").ok_or_else(bad)?;
    let size_bytes = bytes.len() as u64;
    if let Some(meta) = extensions.get("VRMC_vrm").and_then(|v| v.get("meta")) {
        let authors = meta
            .get("authors")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(Value::as_str)
                    .map(|a| a.chars().take(100).collect())
                    .take(10)
                    .collect()
            })
            .unwrap_or_default();
        let redistribution = match meta.get("allowRedistribution").and_then(Value::as_bool) {
            Some(true) => "allowed",
            Some(false) => "not_allowed",
            None => "unknown",
        };
        return Ok(ModelInfo {
            spec: "1.0",
            title: text(meta, "name"),
            authors,
            license: text(meta, "avatarPermission"),
            license_url: text(meta, "licenseUrl"),
            redistribution,
            size_bytes,
        });
    }
    if let Some(meta) = extensions.get("VRM").and_then(|v| v.get("meta")) {
        let license = text(meta, "licenseName");
        let redistribution = match license.as_str() {
            "Redistribution_Prohibited" => "not_allowed",
            "CC0" | "CC_BY" | "CC_BY_NC" | "CC_BY_SA" | "CC_BY_NC_SA" | "CC_BY_ND"
            | "CC_BY_NC_ND" => "allowed",
            _ => "unknown",
        };
        let author = text(meta, "author");
        return Ok(ModelInfo {
            spec: "0.x",
            title: text(meta, "title"),
            authors: if author.is_empty() {
                vec![]
            } else {
                vec![author]
            },
            license,
            license_url: text(meta, "otherLicenseUrl"),
            redistribution,
            size_bytes,
        });
    }
    Err(bad())
}

fn model_path(root: &Path, name: &str) -> Result<std::path::PathBuf, String> {
    if !valid_model_name(name) {
        return Err("Некорректное имя файла модели .vrm".into());
    }
    let path = root.join("character").join(name);
    let metadata = fs::symlink_metadata(&path).map_err(|_| "Файл модели не найден")?;
    if !metadata.is_file() {
        return Err("Файл модели не найден".into());
    }
    if metadata.len() > MAX_MODEL_BYTES {
        return Err("Файл модели больше 64 МБ".into());
    }
    Ok(path)
}

pub fn read_model(root: &Path, name: &str) -> Result<(Vec<u8>, ModelInfo), String> {
    let bytes = fs::read(model_path(root, name)?).map_err(|_| "Не удалось прочитать модель")?;
    let info = parse_vrm_info(&bytes)?;
    Ok((bytes, info))
}

/// Mouth openness per 20 ms frame, 0..=255, from 16-bit PCM WAV audio.
/// Same noise gate and scale as the overlay, so the mouth follows loudness only.
pub fn mouth_levels(wav: &[u8]) -> Vec<u8> {
    if wav.len() < 44 || &wav[0..4] != b"RIFF" || &wav[8..12] != b"WAVE" {
        return vec![];
    }
    let (mut at, mut rate, mut channels) = (12usize, 0u32, 0usize);
    while at + 8 <= wav.len() {
        let size =
            u32::from_le_bytes([wav[at + 4], wav[at + 5], wav[at + 6], wav[at + 7]]) as usize;
        let body = at + 8;
        let id = &wav[at..at + 4];
        if id == b"fmt " && size >= 16 && body + 16 <= wav.len() {
            let format = u16::from_le_bytes([wav[body], wav[body + 1]]);
            let bits = u16::from_le_bytes([wav[body + 14], wav[body + 15]]);
            if format != 1 || bits != 16 {
                return vec![];
            }
            channels = u16::from_le_bytes([wav[body + 2], wav[body + 3]]) as usize;
            rate = u32::from_le_bytes([wav[body + 4], wav[body + 5], wav[body + 6], wav[body + 7]]);
        } else if id == b"data" && rate > 0 && channels > 0 {
            let end = wav.len().min(body.saturating_add(size));
            let samples: Vec<f32> = wav[body..end]
                .chunks(2)
                .filter(|b| b.len() == 2)
                .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0)
                .collect();
            let per_frame = ((rate as usize * channels * MOUTH_FRAME_MS as usize) / 1000).max(1);
            return samples
                .chunks(per_frame)
                .map(|frame| {
                    let rms =
                        (frame.iter().map(|v| v * v).sum::<f32>() / frame.len() as f32).sqrt();
                    let open = ((rms - MOUTH_NOISE_FLOOR) / (MOUTH_FULL_SCALE - MOUTH_NOISE_FLOOR))
                        .clamp(0.0, 1.0);
                    (open * 255.0).round() as u8
                })
                .collect();
        }
        at = body.saturating_add(size).saturating_add(size % 2);
    }
    vec![]
}

/// Called when TTS audio is about to play. Sends the mouth track only while
/// the overlay window exists; nothing is computed otherwise.
pub fn emit_mouth(app: &tauri::AppHandle, wav: &[u8]) {
    if !overlay_open(app) {
        return;
    }
    let levels = mouth_levels(wav);
    if !levels.is_empty() {
        let _ = app.emit(
            "character-mouth",
            json!({"frame_ms": MOUTH_FRAME_MS, "levels": levels}),
        );
    }
}

fn watch_cursor(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        while let Some(window) = app.get_webview_window(LABEL) {
            if let (Ok(cursor), Ok(position), Ok(size)) = (
                window.cursor_position(),
                window.outer_position(),
                window.inner_size(),
            ) {
                let center_x = position.x as f64 + size.width as f64 / 2.0;
                let center_y = position.y as f64 + size.height as f64 / 3.0;
                let scale = 900.0;
                let _ = app.emit(
                    "character-cursor",
                    json!({
                        "x": ((cursor.x - center_x) / scale).clamp(-1.0, 1.0),
                        "y": ((cursor.y - center_y) / scale).clamp(-1.0, 1.0),
                    }),
                );
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    });
}

fn overlay_open(app: &tauri::AppHandle) -> bool {
    app.get_webview_window(LABEL).is_some()
}

fn close_overlay(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.close();
    }
}

pub trait WindowActions {
    fn set_always_on_top(&self, always_on_top: bool) -> Result<(), String>;
    fn set_ignore_cursor_events(&self, ignore: bool) -> Result<(), String>;
    fn close(&self) -> Result<(), String>;
}

impl WindowActions for tauri::WebviewWindow {
    fn set_always_on_top(&self, always_on_top: bool) -> Result<(), String> {
        self.set_always_on_top(always_on_top)
            .map_err(|e| format!("Не удалось установить режим поверх окон: {e}"))
    }

    fn set_ignore_cursor_events(&self, ignore: bool) -> Result<(), String> {
        self.set_ignore_cursor_events(ignore)
            .map_err(|e| format!("Не удалось переключить сквозной клик: {e}"))
    }

    fn close(&self) -> Result<(), String> {
        <tauri::WebviewWindow>::close(self)
            .map_err(|e| format!("Не удалось закрыть окно персонажа: {e}"))
    }
}

pub fn apply_window_properties<W: WindowActions + ?Sized>(
    window: &W,
    target: &CharacterSettings,
    previous: Option<&CharacterSettings>,
) -> Result<(), String> {
    window.set_always_on_top(target.always_on_top)?;
    if let Err(err) = window.set_ignore_cursor_events(target.click_through) {
        if let Some(prev) = previous {
            if let Err(rb_err) = window.set_always_on_top(prev.always_on_top) {
                let _ = window.close();
                return Err(format!(
                    "{err}. Откат поверх окон не удался ({rb_err}), окно закрыто"
                ));
            }
        } else {
            let _ = window.close();
        }
        return Err(err);
    }
    Ok(())
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
    if let Err(err) = apply_window_properties(&window, settings, None) {
        let _ = window.close();
        return Err(err);
    }
    watch_cursor(app.clone());
    Ok(())
}

pub fn resolve_renderer_status(overlay_open: bool, model_configured: bool) -> &'static str {
    if !overlay_open {
        "unknown"
    } else if model_configured {
        "configured"
    } else {
        "fallback"
    }
}

fn state_value(root: &Path, app: &tauri::AppHandle) -> Result<Value, String> {
    let is_open = overlay_open(app);
    let has_model = load(root).map(|s| s.model.is_some()).unwrap_or(false);
    Ok(json!({
        "enabled": app_enabled(root),
        "theme": app_theme(root),
        "settings": load(root)?,
        "capabilities": detect_capabilities(),
        "models": list_models(root),
        "overlay_open": is_open,
        "renderer": resolve_renderer_status(is_open, has_model),
        "directory": root.join("character").to_string_lossy(),
    }))
}

#[tauri::command]
pub fn character_state(app: tauri::AppHandle) -> Result<Value, String> {
    let root = crate::storage::data_root()?;
    state_value(&root, &app)
}

pub fn save_character_settings_orchestrated<W, FWrite, FEmit>(
    window: Option<&W>,
    target: &CharacterSettings,
    previous: &CharacterSettings,
    write_fn: FWrite,
    emit_fn: FEmit,
) -> Result<(), String>
where
    W: WindowActions + ?Sized,
    FWrite: FnOnce(&CharacterSettings) -> Result<(), String>,
    FEmit: FnOnce(u32) -> Result<(), String>,
{
    if let Some(w) = window {
        apply_window_properties(w, target, Some(previous))?;

        if let Err(write_err) = write_fn(target) {
            if let Err(rb_err) = apply_window_properties(w, previous, None) {
                let _ = w.close();
                return Err(format!(
                    "Не удалось сохранить настройки ({write_err}). Откат параметров окна не удался ({rb_err}), окно закрыто."
                ));
            }
            return Err(write_err);
        }

        let _ = emit_fn(target.fps_limit);
        Ok(())
    } else {
        write_fn(target)?;
        let _ = emit_fn(target.fps_limit);
        Ok(())
    }
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

    let previous = load(&root)?;
    let window = app.get_webview_window(LABEL);
    save_character_settings_orchestrated(
        window.as_ref(),
        &settings,
        &previous,
        |s| save(&root, s),
        |fps| {
            let _ = app.emit("character-settings", json!({ "fps_limit": fps }));
            Ok(())
        },
    )?;

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

#[tauri::command]
pub fn character_model_info(name: String) -> Result<ModelInfo, String> {
    let root = crate::storage::data_root()?;
    read_model(&root, &name).map(|(_, info)| info)
}

#[tauri::command]
pub fn character_model_load(name: String) -> Result<tauri::ipc::Response, String> {
    let root = crate::storage::data_root()?;
    if !app_enabled(&root) {
        return Err("Персонаж выключен в настройках".into());
    }
    read_model(&root, &name).map(|(bytes, _)| tauri::ipc::Response::new(bytes))
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
        assert_eq!(app_theme(&root), "neyra");
        assert!(!root.join(SETTINGS_FILE).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn overlay_theme_reads_only_the_theme_field() {
        let root = temp_root();
        fs::create_dir_all(root.join("settings")).unwrap();
        fs::write(
            root.join("settings/app.json"),
            r#"{"theme":"dark","device_id":"x","permissions":{"apps":["secret"]}}"#,
        )
        .unwrap();
        assert_eq!(app_theme(&root), "dark");
        fs::write(root.join("settings/app.json"), r#"{"theme":"purple"}"#).unwrap();
        assert_eq!(app_theme(&root), "neyra");
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

    fn glb(json: &str) -> Vec<u8> {
        let mut body = json.as_bytes().to_vec();
        while body.len() & 3 != 0 {
            body.push(b' ');
        }
        let total = 12 + 8 + body.len();
        let mut out = b"glTF".to_vec();
        out.extend(2u32.to_le_bytes());
        out.extend((total as u32).to_le_bytes());
        out.extend((body.len() as u32).to_le_bytes());
        out.extend(b"JSON");
        out.extend(body);
        out
    }

    #[test]
    fn vrm1_licence_block_is_read() {
        let bytes = glb(
            r#"{"extensions":{"VRMC_vrm":{"meta":{"name":"Test","authors":["Ann"],"licenseUrl":"https://vrm.dev/licenses/1.0/","avatarPermission":"everyone","allowRedistribution":true}}}}"#,
        );
        let info = parse_vrm_info(&bytes).unwrap();
        assert_eq!(info.spec, "1.0");
        assert_eq!(info.title, "Test");
        assert_eq!(info.authors, vec!["Ann"]);
        assert_eq!(info.redistribution, "allowed");
        let closed =
            glb(r#"{"extensions":{"VRMC_vrm":{"meta":{"name":"X","allowRedistribution":false}}}}"#);
        assert_eq!(
            parse_vrm_info(&closed).unwrap().redistribution,
            "not_allowed"
        );
        let silent = glb(r#"{"extensions":{"VRMC_vrm":{"meta":{"name":"X"}}}}"#);
        assert_eq!(parse_vrm_info(&silent).unwrap().redistribution, "unknown");
    }

    #[test]
    fn vrm0_licence_name_decides_redistribution() {
        for (name, expected) in [
            ("CC0", "allowed"),
            ("Redistribution_Prohibited", "not_allowed"),
            ("Other", "unknown"),
        ] {
            let bytes = glb(&format!(
                r#"{{"extensions":{{"VRM":{{"meta":{{"title":"Old","author":"Bob","licenseName":"{name}"}}}}}}}}"#
            ));
            let info = parse_vrm_info(&bytes).unwrap();
            assert_eq!((info.spec, info.redistribution), ("0.x", expected));
            assert_eq!(info.authors, vec!["Bob"]);
        }
    }

    #[test]
    fn broken_or_non_vrm_files_are_refused() {
        assert!(parse_vrm_info(b"").is_err());
        assert!(parse_vrm_info(b"not a model at all, just text").is_err());
        assert!(parse_vrm_info(&glb(r#"{"asset":{"version":"2.0"}}"#)).is_err());
        assert!(parse_vrm_info(&glb(r#"{"extensions":{}}"#)).is_err());
        let mut truncated = glb(r#"{"extensions":{"VRM":{"meta":{}}}}"#);
        truncated.truncate(30);
        assert!(parse_vrm_info(&truncated).is_err());
        let mut wrong_length = glb(r#"{"extensions":{"VRM":{"meta":{}}}}"#);
        wrong_length[8] ^= 1;
        assert!(parse_vrm_info(&wrong_length).is_err());
    }

    #[test]
    fn model_loading_rejects_traversal_missing_and_oversize() {
        let root = temp_root();
        assert!(read_model(&root, "../settings/app.json").is_err());
        assert!(read_model(&root, "missing.vrm").is_err());
        fs::write(
            root.join("character/ok.vrm"),
            glb(r#"{"extensions":{"VRM":{"meta":{}}}}"#),
        )
        .unwrap();
        assert!(read_model(&root, "ok.vrm").is_ok());
        fs::write(root.join("character/text.vrm"), b"hello").unwrap();
        assert!(read_model(&root, "text.vrm").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    fn wav16(samples: &[i16], rate: u32) -> Vec<u8> {
        let mut out = b"RIFF".to_vec();
        out.extend((36 + samples.len() as u32 * 2).to_le_bytes());
        out.extend(b"WAVEfmt ");
        out.extend(16u32.to_le_bytes());
        out.extend(1u16.to_le_bytes());
        out.extend(1u16.to_le_bytes());
        out.extend(rate.to_le_bytes());
        out.extend((rate * 2).to_le_bytes());
        out.extend(2u16.to_le_bytes());
        out.extend(16u16.to_le_bytes());
        out.extend(b"data");
        out.extend((samples.len() as u32 * 2).to_le_bytes());
        for s in samples {
            out.extend(s.to_le_bytes());
        }
        out
    }

    #[test]
    fn mouth_follows_loudness_in_20ms_frames() {
        let mut samples = vec![0i16; 320];
        samples.extend((0..320).map(|i| if i % 2 == 0 { 12000 } else { -12000 }));
        let levels = mouth_levels(&wav16(&samples, 16000));
        assert_eq!(levels.len(), 2);
        assert_eq!(levels[0], 0);
        assert!(levels[1] > 100);
    }

    #[test]
    fn mouth_levels_ignore_unsupported_audio() {
        assert!(mouth_levels(b"").is_empty());
        assert!(
            mouth_levels(b"RIFFxxxxWAVE-not-really-a-wav-file-at-all-padding-padding").is_empty()
        );
        let mut float_wav = wav16(&[1, 2, 3], 16000);
        float_wav[20] = 3;
        assert!(mouth_levels(&float_wav).is_empty());
    }

    #[derive(Default)]
    struct MockWindowActions {
        always_on_top: std::cell::Cell<Option<bool>>,
        click_through: std::cell::Cell<Option<bool>>,
        closed: std::cell::Cell<bool>,
        fail_always_on_top: std::cell::Cell<bool>,
        fail_click_through: std::cell::Cell<bool>,
        fail_close: std::cell::Cell<bool>,
        fail_always_on_top_after_calls: std::cell::Cell<usize>,
        always_on_top_calls: std::cell::Cell<usize>,
    }

    impl WindowActions for MockWindowActions {
        fn set_always_on_top(&self, always_on_top: bool) -> Result<(), String> {
            let calls = self.always_on_top_calls.get() + 1;
            self.always_on_top_calls.set(calls);
            let fail_after = self.fail_always_on_top_after_calls.get();
            if self.fail_always_on_top.get() || (fail_after > 0 && calls > fail_after) {
                return Err("mock platform rejected always-on-top".into());
            }
            self.always_on_top.set(Some(always_on_top));
            Ok(())
        }

        fn set_ignore_cursor_events(&self, ignore: bool) -> Result<(), String> {
            if self.fail_click_through.get() {
                return Err("mock platform rejected click-through".into());
            }
            self.click_through.set(Some(ignore));
            Ok(())
        }

        fn close(&self) -> Result<(), String> {
            if self.fail_close.get() {
                return Err("mock platform rejected close".into());
            }
            self.closed.set(true);
            Ok(())
        }
    }

    #[test]
    fn character_settings_default_values_contract() {
        let default_settings = CharacterSettings::default();
        assert_eq!(default_settings.schema_version, 1);
        assert!(default_settings.always_on_top);
        assert!(default_settings.click_through);
        assert!(default_settings.pause_fullscreen);
        assert!(default_settings.pause_battery);
        assert_eq!(default_settings.fps_limit, 30);
        assert!(default_settings.model.is_none());
    }

    #[test]
    fn apply_window_properties_sets_both_flags_and_allows_dynamic_updates() {
        let window = MockWindowActions::default();
        let mut settings = CharacterSettings {
            always_on_top: true,
            click_through: false,
            ..Default::default()
        };

        apply_window_properties(&window, &settings, None).expect("initial apply should succeed");
        assert_eq!(window.always_on_top.get(), Some(true));
        assert_eq!(window.click_through.get(), Some(false));

        let previous = settings.clone();
        settings.always_on_top = false;
        settings.click_through = true;
        apply_window_properties(&window, &settings, Some(&previous))
            .expect("dynamic apply should succeed");
        assert_eq!(window.always_on_top.get(), Some(false));
        assert_eq!(window.click_through.get(), Some(true));
    }

    #[test]
    fn apply_window_properties_propagates_always_on_top_failure() {
        let window = MockWindowActions::default();
        window.fail_always_on_top.set(true);
        let settings = CharacterSettings::default();

        let err = apply_window_properties(&window, &settings, None).unwrap_err();
        assert!(err.contains("rejected always-on-top"));
        assert_eq!(window.click_through.get(), None);
    }

    #[test]
    fn apply_window_properties_propagates_click_through_failure_and_rolls_back() {
        let window = MockWindowActions::default();
        let previous = CharacterSettings {
            always_on_top: false,
            click_through: false,
            ..Default::default()
        };
        window.always_on_top.set(Some(false));
        window.click_through.set(Some(false));
        window.fail_click_through.set(true);

        let target = CharacterSettings {
            always_on_top: true,
            click_through: true,
            ..Default::default()
        };
        let err = apply_window_properties(&window, &target, Some(&previous)).unwrap_err();
        assert!(err.contains("rejected click-through"));
        assert_eq!(window.always_on_top.get(), Some(false));
        assert!(!window.closed.get());
    }

    #[test]
    fn apply_window_properties_closes_window_when_click_through_and_rollback_both_fail() {
        let window = MockWindowActions::default();
        let previous = CharacterSettings {
            always_on_top: false,
            click_through: false,
            ..Default::default()
        };
        window.always_on_top.set(Some(false));
        window.click_through.set(Some(false));
        window.fail_always_on_top_after_calls.set(1);
        window.fail_click_through.set(true);

        let target = CharacterSettings {
            always_on_top: true,
            click_through: true,
            ..Default::default()
        };
        let err = apply_window_properties(&window, &target, Some(&previous)).unwrap_err();
        assert!(err.contains("rejected click-through"));
        assert!(err.contains("окно закрыто"));
        assert!(window.closed.get());
    }

    #[test]
    fn orchestration_succeeds_without_window() {
        let target = CharacterSettings {
            fps_limit: 45,
            ..Default::default()
        };
        let previous = CharacterSettings::default();
        let mut wrote = false;
        let mut emitted_fps = None;
        let no_window: Option<&MockWindowActions> = None;
        save_character_settings_orchestrated(
            no_window,
            &target,
            &previous,
            |_| {
                wrote = true;
                Ok(())
            },
            |fps| {
                emitted_fps = Some(fps);
                Ok(())
            },
        )
        .expect("should succeed without window");
        assert!(wrote);
        assert_eq!(emitted_fps, Some(45));
    }

    #[test]
    fn orchestration_succeeds_with_window_updating_flags_writing_and_emitting() {
        let window = MockWindowActions::default();
        let previous = CharacterSettings {
            always_on_top: false,
            click_through: false,
            fps_limit: 30,
            ..Default::default()
        };
        let target = CharacterSettings {
            always_on_top: true,
            click_through: true,
            fps_limit: 60,
            ..Default::default()
        };
        let mut wrote = false;
        let mut emitted_fps = None;
        save_character_settings_orchestrated(
            Some(&window),
            &target,
            &previous,
            |s| {
                assert_eq!(s.fps_limit, 60);
                wrote = true;
                Ok(())
            },
            |fps| {
                emitted_fps = Some(fps);
                Ok(())
            },
        )
        .expect("orchestrated save should succeed");
        assert!(wrote);
        assert_eq!(emitted_fps, Some(60));
        assert_eq!(window.always_on_top.get(), Some(true));
        assert_eq!(window.click_through.get(), Some(true));
        assert!(!window.closed.get());
    }

    #[test]
    fn orchestration_propagates_platform_failure_without_writing_file() {
        let window = MockWindowActions::default();
        window.fail_always_on_top.set(true);
        let previous = CharacterSettings::default();
        let target = CharacterSettings {
            always_on_top: true,
            click_through: true,
            ..Default::default()
        };
        let mut wrote = false;
        let err = save_character_settings_orchestrated(
            Some(&window),
            &target,
            &previous,
            |_| {
                wrote = true;
                Ok(())
            },
            |_| Ok(()),
        )
        .unwrap_err();
        assert!(err.contains("rejected always-on-top"));
        assert!(!wrote, "write must never happen when platform apply fails");
    }

    #[test]
    fn orchestration_rolls_back_window_when_write_fails() {
        let window = MockWindowActions::default();
        let previous = CharacterSettings {
            always_on_top: false,
            click_through: false,
            ..Default::default()
        };
        let target = CharacterSettings {
            always_on_top: true,
            click_through: true,
            ..Default::default()
        };
        let err = save_character_settings_orchestrated(
            Some(&window),
            &target,
            &previous,
            |_| Err("atomic write failed: out of disk space".into()),
            |_| Ok(()),
        )
        .unwrap_err();
        assert_eq!(err, "atomic write failed: out of disk space");
        assert_eq!(
            window.always_on_top.get(),
            Some(false),
            "always_on_top must roll back to previous"
        );
        assert_eq!(
            window.click_through.get(),
            Some(false),
            "click_through must roll back to previous"
        );
        assert!(
            !window.closed.get(),
            "window should remain open when rollback succeeds"
        );
    }

    #[test]
    fn orchestration_closes_window_when_write_and_rollback_both_fail() {
        let window = MockWindowActions::default();
        let previous = CharacterSettings {
            always_on_top: false,
            click_through: false,
            ..Default::default()
        };
        let target = CharacterSettings {
            always_on_top: true,
            click_through: true,
            ..Default::default()
        };
        window.fail_always_on_top_after_calls.set(1);

        let err = save_character_settings_orchestrated(
            Some(&window),
            &target,
            &previous,
            |_| Err("disk write error".into()),
            |_| Ok(()),
        )
        .unwrap_err();
        assert!(err.contains("disk write error"));
        assert!(err.contains("окно закрыто"));
        assert!(
            window.closed.get(),
            "window must be closed when rollback fails after write failure"
        );
    }

    #[test]
    fn load_corrupted_settings_fails_and_preserves_error() {
        let tmp = std::env::temp_dir().join(format!(
            "neyra-test-corrupt-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(tmp.join("settings")).unwrap();
        let path = tmp.join(SETTINGS_FILE);
        std::fs::write(&path, b"{\"schema_version\": 1, invalid_json: true").unwrap();

        let err = load(&tmp).unwrap_err();
        assert!(err.contains("Повреждены настройки персонажа"));
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("invalid_json"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn renderer_resolution_contract_without_false_guarantees() {
        // When overlay is closed, runtime rendering status is unknown
        assert_eq!(resolve_renderer_status(false, false), "unknown");
        assert_eq!(resolve_renderer_status(false, true), "unknown");
        // When overlay is open: model configured indicates intent, empty indicates fallback placeholder
        assert_eq!(resolve_renderer_status(true, true), "configured");
        assert_eq!(resolve_renderer_status(true, false), "fallback");
    }
}
