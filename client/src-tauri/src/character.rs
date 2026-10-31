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
    watch_cursor(app.clone());
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
    let _ = app.emit(
        "character-settings",
        json!({ "fps_limit": settings.fps_limit }),
    );
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
}
