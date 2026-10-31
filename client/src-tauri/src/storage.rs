use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    thread,
    time::Duration,
};
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub url: String,
    pub session_id: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Permissions {
    pub enabled: bool,
    pub apps: Vec<String>,
    pub allow_web: bool,
    pub web_domains: Vec<String>,
    pub system: bool,
}
impl Default for Permissions {
    fn default() -> Self {
        Self {
            enabled: false,
            apps: vec![],
            allow_web: true,
            web_domains: vec![],
            system: true,
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub schema_version: u32,
    pub device_id: String,
    pub device_name: String,
    pub profiles: Vec<Profile>,
    pub permissions: Permissions,
    pub theme: String,
    #[serde(default = "default_graphics")]
    pub graphics_mode: String,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            schema_version: 1,
            device_id: Uuid::new_v4().to_string(),
            device_name: "Мой ПК".into(),
            profiles: vec![],
            permissions: Permissions::default(),
            theme: "dark".into(),
            graphics_mode: default_graphics(),
        }
    }
}

fn default_graphics() -> String {
    "auto".into()
}

pub fn data_root() -> Result<PathBuf, String> {
    let documents = dirs::document_dir().or_else(|| dirs::home_dir().map(|p| p.join("Documents")));
    let root = if cfg!(target_os = "windows") {
        documents.map(|p| p.join("Neyra"))
    } else {
        documents
            .filter(|p| p.exists())
            .map(|p| p.join("Neyra"))
            .or_else(|| dirs::data_local_dir().map(|p| p.join("neyra")))
    };
    root.ok_or_else(|| "Не найдена папка пользовательских данных".into())
}

pub fn initialize(root: &Path) -> Result<Settings, String> {
    for dir in [
        "settings",
        "commands",
        "permissions",
        "logs",
        "audit",
        "character",
        "models",
        "cache",
    ] {
        fs::create_dir_all(root.join(dir)).map_err(|_| "Не удалось создать папку Neyra")?;
    }
    let path = root.join("settings/app.json");
    if path.exists() {
        let settings: Settings =
            serde_json::from_slice(&fs::read(&path).map_err(|_| "Не удалось прочитать настройки")?)
                .map_err(|_| "Повреждены настройки. Исходный файл сохранён")?;
        if settings.schema_version != 1 {
            return Err("Несовместимая версия настроек".into());
        }
        Ok(settings)
    } else {
        let settings = Settings::default();
        save(root, &settings)?;
        Ok(settings)
    }
}

pub fn save(root: &Path, settings: &Settings) -> Result<(), String> {
    atomic_write(
        &root.join("settings/app.json"),
        &serde_json::to_vec_pretty(settings).map_err(|_| "Не удалось сериализовать настройки")?,
    )
}

pub fn atomic_write(path: &Path, data: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    fs::write(&tmp, data).map_err(|_| "Не удалось записать настройки")?;
    let mut ok = false;
    for _ in 0..5 {
        // Replace atomically; Windows uses MoveFileExW with REPLACE_EXISTING.
        if replace(&tmp, path).is_ok() {
            ok = true;
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    if !ok {
        let _ = fs::remove_file(tmp);
        return Err("Не удалось заменить настройки; повторите сохранение".into());
    }
    Ok(())
}
#[cfg(not(windows))]
fn replace(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::rename(from, to)
}
#[cfg(windows)]
fn replace(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
    }
    let f: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let t: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe { MoveFileExW(f.as_ptr(), t.as_ptr(), 0x1 | 0x8) } == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

pub fn secret(profile: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new("site.owyx.neyra", profile)
        .map_err(|_| "Системное хранилище секретов недоступно".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn settings_never_contain_token() {
        let value = serde_json::to_string(&Settings::default()).unwrap();
        assert!(!value.contains("token"));
    }
    #[test]
    fn initialize_and_replace_preserve_identity() {
        let root = std::env::temp_dir().join(Uuid::new_v4().to_string());
        let s = initialize(&root).unwrap();
        save(&root, &s).unwrap();
        assert_eq!(initialize(&root).unwrap().device_id, s.device_id);
        fs::remove_dir_all(root).unwrap();
    }
}
