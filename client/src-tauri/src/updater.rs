use crate::storage::atomic_write;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    sync::{Mutex, OnceLock},
};
use tauri::Emitter;
use tauri_plugin_updater::{Update, UpdaterExt};
use url::Url;

const SETTINGS_FILE: &str = "settings/updater.json";
pub const PLACEHOLDER_PUBKEY: &str = "REPLACE_WITH_PRODUCTION_PUBKEY";
const STABLE_ENDPOINT: &str =
    "https://github.com/ebluffy/Neyra-AIAssist/releases/latest/download/latest.json";
const BETA_ENDPOINT: &str =
    "https://github.com/ebluffy/Neyra-AIAssist/releases/download/client-beta/latest.json";

static PENDING: OnceLock<Mutex<Option<Update>>> = OnceLock::new();

fn pending() -> &'static Mutex<Option<Update>> {
    PENDING.get_or_init(|| Mutex::new(None))
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(deny_unknown_fields)]
pub struct UpdaterSettings {
    pub schema_version: u32,
    pub channel: String,
    pub auto_check: bool,
}

impl Default for UpdaterSettings {
    fn default() -> Self {
        Self {
            schema_version: 1,
            channel: "beta".into(),
            auto_check: true,
        }
    }
}

pub fn endpoint(channel: &str) -> Result<Url, String> {
    let raw = match channel {
        "stable" => STABLE_ENDPOINT,
        "beta" => BETA_ENDPOINT,
        _ => return Err("Неизвестный канал обновлений".into()),
    };
    Url::parse(raw).map_err(|_| "Некорректный адрес обновлений".into())
}

pub fn validate(settings: &UpdaterSettings) -> Result<(), String> {
    if settings.schema_version != 1 {
        return Err("Несовместимая версия настроек обновлений".into());
    }
    endpoint(&settings.channel).map(|_| ())
}

pub fn load(root: &Path) -> Result<UpdaterSettings, String> {
    let path = root.join(SETTINGS_FILE);
    if !path.exists() {
        return Ok(UpdaterSettings::default());
    }
    let settings: UpdaterSettings = serde_json::from_slice(
        &fs::read(path).map_err(|_| "Не удалось прочитать настройки обновлений")?,
    )
    .map_err(|_| "Повреждены настройки обновлений. Исходный файл сохранён")?;
    validate(&settings)?;
    Ok(settings)
}

pub fn save(root: &Path, settings: &UpdaterSettings) -> Result<(), String> {
    validate(settings)?;
    fs::create_dir_all(root.join("settings")).map_err(|_| "Не удалось создать папку настроек")?;
    atomic_write(
        &root.join(SETTINGS_FILE),
        &serde_json::to_vec_pretty(settings).map_err(|_| "Не удалось сериализовать настройки")?,
    )
}

pub fn pubkey_configured(app: &tauri::AppHandle) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|v| v.get("pubkey"))
        .and_then(Value::as_str)
        .map(|key| !key.trim().is_empty() && key != PLACEHOLDER_PUBKEY)
        .unwrap_or(false)
}

fn install_kind() -> &'static str {
    if cfg!(windows) {
        "nsis"
    } else if std::env::var_os("APPIMAGE").is_some() {
        "appimage"
    } else {
        "package"
    }
}

fn state_value(app: &tauri::AppHandle, root: &Path) -> Result<Value, String> {
    let settings = load(root)?;
    let found = pending().lock().map_err(|_| "Внутренняя ошибка")?;
    Ok(json!({
        "settings": settings,
        "current_version": app.package_info().version.to_string(),
        "endpoint": endpoint(&settings.channel)?.as_str(),
        "key_configured": pubkey_configured(app),
        "install_kind": install_kind(),
        "pending_version": found.as_ref().map(|u| u.version.clone()),
    }))
}

#[tauri::command]
pub fn update_state(app: tauri::AppHandle) -> Result<Value, String> {
    state_value(&app, &crate::storage::data_root()?)
}

#[tauri::command]
pub fn update_save(app: tauri::AppHandle, settings: UpdaterSettings) -> Result<Value, String> {
    let root = crate::storage::data_root()?;
    save(&root, &settings)?;
    *pending().lock().map_err(|_| "Внутренняя ошибка")? = None;
    state_value(&app, &root)
}

#[tauri::command]
pub async fn update_check(app: tauri::AppHandle) -> Result<Value, String> {
    let root = crate::storage::data_root()?;
    let settings = load(&root)?;
    if !pubkey_configured(&app) {
        return Err("В этой сборке не задан публичный ключ подписи. Обновление отключено".into());
    }
    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint(&settings.channel)?])
        .map_err(|_| "Некорректный адрес обновлений")?
        .build()
        .map_err(|_| "Не удалось подготовить проверку обновлений")?;
    let found = updater
        .check()
        .await
        .map_err(|_| "Не удалось проверить обновления. Проверьте сеть и повторите")?;
    let result = match &found {
        Some(update) => json!({
            "available": true,
            "version": update.version,
            "notes": update.body,
            "date": update.date.map(|d| d.to_string()),
        }),
        None => json!({"available": false}),
    };
    *pending().lock().map_err(|_| "Внутренняя ошибка")? = found;
    Ok(result)
}

#[tauri::command]
pub async fn update_install(app: tauri::AppHandle) -> Result<(), String> {
    let update = pending()
        .lock()
        .map_err(|_| "Внутренняя ошибка")?
        .take()
        .ok_or("Сначала проверьте обновления")?;
    let mut downloaded: u64 = 0;
    let progress = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = progress.emit(
                    "update-progress",
                    json!({"downloaded": downloaded, "total": total}),
                );
            },
            || {},
        )
        .await
        .map_err(|_| "Обновление не установлено: подпись или файл не прошли проверку")?;
    Ok(())
}

#[tauri::command]
pub fn update_restart(app: tauri::AppHandle) {
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    const CONFIG: &str = include_str!("../tauri.conf.json");
    const TEST_PUBKEY: &str = include_str!("../updater-test/test.key.pub");

    #[test]
    fn config_keeps_signature_checks_on_and_uses_https() {
        let config: Value = serde_json::from_str(CONFIG).unwrap();
        let updater = &config["plugins"]["updater"];
        assert_eq!(updater["requireSignedVersion"], true);
        for flag in [
            "dangerousInsecureTransportProtocol",
            "dangerousAcceptInvalidCerts",
            "dangerousAcceptInvalidHostnames",
            "allowDowngrades",
        ] {
            assert!(updater.get(flag).is_none(), "{flag} must stay unset");
        }
        for url in updater["endpoints"].as_array().unwrap() {
            assert!(url.as_str().unwrap().starts_with("https://"));
        }
        assert!(endpoint("stable").unwrap().as_str().starts_with("https://"));
        assert!(endpoint("beta").unwrap().as_str().starts_with("https://"));
    }

    #[test]
    fn shipped_config_never_trusts_the_committed_test_key() {
        let config: Value = serde_json::from_str(CONFIG).unwrap();
        let key = config["plugins"]["updater"]["pubkey"].as_str().unwrap();
        assert_ne!(key.trim(), TEST_PUBKEY.trim());
        assert_ne!(key, PLACEHOLDER_PUBKEY);
        assert_eq!(config["bundle"]["createUpdaterArtifacts"], false);
    }

    #[test]
    fn channels_use_different_endpoints_and_unknown_is_rejected() {
        assert_ne!(endpoint("stable").unwrap(), endpoint("beta").unwrap());
        assert!(endpoint("nightly").is_err());
        assert!(endpoint("https://evil.example/latest.json").is_err());
    }

    #[test]
    fn settings_default_to_beta_and_round_trip() {
        let root = std::env::temp_dir().join(Uuid::new_v4().to_string());
        assert_eq!(load(&root).unwrap().channel, "beta");
        let mut settings = UpdaterSettings {
            channel: "stable".into(),
            ..Default::default()
        };
        save(&root, &settings).unwrap();
        assert_eq!(load(&root).unwrap(), settings);
        settings.channel = "evil".into();
        assert!(save(&root, &settings).is_err());
        fs::write(root.join(SETTINGS_FILE), b"{broken").unwrap();
        assert!(load(&root).is_err());
        assert_eq!(fs::read(root.join(SETTINGS_FILE)).unwrap(), b"{broken");
        fs::remove_dir_all(root).unwrap();
    }
}
