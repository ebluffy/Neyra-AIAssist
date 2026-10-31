use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    thread,
    time::Duration,
};
use uuid::Uuid;

pub const SETTINGS_VERSION: u32 = 2;
pub const PERMISSIONS_VERSION: u32 = 1;
const MAX_CONFIG_BYTES: u64 = 1024 * 1024;
const KEPT_QUARANTINE: usize = 5;
pub const DIRECTORIES: [&str; 10] = [
    "settings",
    "commands",
    "permissions",
    "logs",
    "audit",
    "character",
    "models",
    "cache",
    "wakeword",
    "chats",
];

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub url: String,
    pub session_id: String,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(default, deny_unknown_fields)]
pub struct Permissions {
    pub enabled: bool,
    pub apps: Vec<String>,
    pub allow_web: bool,
    pub web_domains: Vec<String>,
    pub system: bool,
    /// Contour 3: console commands (every call needs a confirmation card).
    pub shell: bool,
    /// Contour 3: files inside `fs_roots` only.
    pub files: bool,
    pub fs_roots: Vec<String>,
    /// Contour 4: screenshots; `screen_auto` skips the card for screenshots only.
    pub screen: bool,
    pub screen_auto: bool,
    /// Contour 4: mouse and keyboard (every sequence needs a confirmation card).
    pub input: bool,
}
impl Default for Permissions {
    fn default() -> Self {
        Self {
            enabled: false,
            apps: vec![],
            allow_web: true,
            web_domains: vec![],
            system: true,
            shell: false,
            files: false,
            fs_roots: vec![],
            screen: false,
            screen_auto: false,
            input: false,
        }
    }
}

/// In-memory and IPC shape. On disk it is split: `settings/app.json` and `permissions/permissions.json`.
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
    #[serde(default = "default_audit_days")]
    pub audit_days: u32,
    /// Optional 3D character overlay (§3b.6). Off by default; no 3D engine while false.
    #[serde(default)]
    pub character_enabled: bool,
    #[serde(default)]
    pub voice: crate::voice::VoiceSettings,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            schema_version: SETTINGS_VERSION,
            device_id: Uuid::new_v4().to_string(),
            device_name: "Мой ПК".into(),
            profiles: vec![],
            permissions: Permissions::default(),
            theme: "neyra".into(),
            graphics_mode: default_graphics(),
            audit_days: default_audit_days(),
            character_enabled: false,
            voice: crate::voice::VoiceSettings::default(),
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SettingsFile {
    schema_version: u32,
    device_id: String,
    device_name: String,
    profiles: Vec<Profile>,
    theme: String,
    #[serde(default = "default_graphics")]
    graphics_mode: String,
    #[serde(default = "default_audit_days")]
    audit_days: u32,
    #[serde(default)]
    character_enabled: bool,
    #[serde(default)]
    voice: crate::voice::VoiceSettings,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PermissionsFile {
    schema_version: u32,
    permissions: Permissions,
}

/// What happened to a damaged or unreadable config file. Shown to the user, never silent.
#[derive(Clone, Serialize, Debug, PartialEq)]
pub struct Recovery {
    pub file: String,
    pub reason: String,
    pub quarantined: Option<String>,
    pub restored: String,
}

fn default_graphics() -> String {
    "auto".into()
}
fn default_audit_days() -> u32 {
    30
}

fn pointer_path() -> Option<PathBuf> {
    dirs::config_dir().map(|p| p.join("neyra").join("data-location.json"))
}

fn default_root() -> Result<PathBuf, String> {
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

/// The chosen folder survives updates: only a tiny pointer file lives outside the data folder.
pub fn data_root() -> Result<PathBuf, String> {
    if let Some(path) = pointer_path() {
        if let Some(chosen) = read_pointer(&path) {
            return Ok(chosen);
        }
    }
    default_root()
}

fn read_pointer(path: &Path) -> Option<PathBuf> {
    let bytes = read_limited(path, 4096).ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    let chosen = PathBuf::from(value["data_root"].as_str()?);
    (chosen.is_absolute() && chosen.is_dir()).then_some(chosen)
}

/// Copies the current data folder to `target` (never deletes the old one) and remembers the new location.
/// `Ok(true)` means `target` already held Neyra settings, so nothing was copied over them.
pub fn move_data_root(current: &Path, target: &Path) -> Result<bool, String> {
    let (target, reused) = stage_data_root(current, target, false)?;
    let pointer = pointer_path().ok_or("Нет папки настроек ОС")?;
    fs::create_dir_all(pointer.parent().ok_or("Нет папки настроек ОС")?)
        .map_err(|_| "Не удалось сохранить расположение")?;
    atomic_write(
        &pointer,
        &serde_json::to_vec_pretty(&json!({"schema_version":1,"data_root":target}))
            .map_err(|_| "Не удалось сохранить расположение")?,
    )?;
    Ok(reused)
}

/// Replaces an existing Neyra folder with a copy of `current` (the previous tree is renamed beside it) and remembers the location.
pub fn overwrite_data_root(current: &Path, target: &Path) -> Result<(), String> {
    let (target, reused) = stage_data_root(current, target, true)?;
    if reused {
        return Err("Не удалось заменить папку данных".into());
    }
    let pointer = pointer_path().ok_or("Нет папки настроек ОС")?;
    fs::create_dir_all(pointer.parent().ok_or("Нет папки настроек ОС")?)
        .map_err(|_| "Не удалось сохранить расположение")?;
    atomic_write(
        &pointer,
        &serde_json::to_vec_pretty(&json!({"schema_version":1,"data_root":target}))
            .map_err(|_| "Не удалось сохранить расположение")?,
    )?;
    Ok(())
}

/// Whether `target` already contains Neyra settings. Does not copy and does not write the pointer.
pub fn peek_data_move(current: &Path, target: &Path) -> Result<bool, String> {
    if !target.is_absolute() {
        return Err("Нужен абсолютный путь".into());
    }
    let current = fs::canonicalize(current).map_err(|_| "Текущая папка данных недоступна")?;
    if !target.exists() {
        let parent = target
            .parent()
            .filter(|path| path.exists())
            .ok_or("Выбранная папка недоступна")?;
        let parent = fs::canonicalize(parent).map_err(|_| "Выбранная папка недоступна")?;
        let name = target.file_name().ok_or("Выбранная папка недоступна")?;
        let hypothetical = parent.join(name);
        if hypothetical == current
            || hypothetical.starts_with(&current)
            || current.starts_with(&hypothetical)
        {
            return Err(
                "Папка не должна быть вложена в текущую папку данных или содержать её".into(),
            );
        }
        return Ok(false);
    }
    let target = fs::canonicalize(target).map_err(|_| "Выбранная папка недоступна")?;
    if target == current {
        return Err("Это уже текущая папка данных".into());
    }
    if target.starts_with(&current) || current.starts_with(&target) {
        return Err("Папка не должна быть вложена в текущую папку данных или содержать её".into());
    }
    Ok(target.join("settings/app.json").is_file())
}

/// Prepares `target` without touching the OS pointer. Returns whether an existing Neyra folder was kept as-is.
fn stage_data_root(
    current: &Path,
    target: &Path,
    overwrite: bool,
) -> Result<(PathBuf, bool), String> {
    if !target.is_absolute() {
        return Err("Нужен абсолютный путь".into());
    }
    let current = fs::canonicalize(current).map_err(|_| "Текущая папка данных недоступна")?;
    fs::create_dir_all(target).map_err(|_| "Не удалось создать выбранную папку")?;
    let target = fs::canonicalize(target).map_err(|_| "Выбранная папка недоступна")?;
    if target == current {
        return Err("Это уже текущая папка данных".into());
    }
    if target.starts_with(&current) || current.starts_with(&target) {
        return Err("Папка не должна быть вложена в текущую папку данных или содержать её".into());
    }
    let reused = target.join("settings/app.json").exists();
    if reused && overwrite {
        replace_with_incoming(&current, &target)?;
    } else if !reused {
        copy_tree(&current, &target, 0)?;
    }
    for dir in DIRECTORIES {
        fs::create_dir_all(target.join(dir)).map_err(|_| "Не удалось подготовить папку Neyra")?;
    }
    Ok((target, reused && !overwrite))
}

/// Copies `current` beside `target`, then swaps the finished copy into place.
/// A failed copy never moves `target`. If the final rename fails, `target` is put back.
fn replace_with_incoming(current: &Path, target: &Path) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or("Не удалось отложить прежнюю папку Neyra")?;
    let name = target
        .file_name()
        .ok_or("Не удалось отложить прежнюю папку Neyra")?;
    let stamp = now_ms();
    let label = name.to_string_lossy();
    let incoming = parent.join(format!("{label}.incoming-{stamp}"));
    let previous = parent.join(format!("{label}.previous-{stamp}"));
    if let Err(err) = copy_aside(current, &incoming) {
        let _ = fs::remove_dir_all(&incoming);
        return Err(err);
    }
    if let Err(err) = replace_with_incoming_swap(target, &incoming, &previous) {
        let _ = fs::remove_dir_all(&incoming);
        return Err(err);
    }
    Ok(())
}

fn replace_with_incoming_swap(
    target: &Path,
    incoming: &Path,
    previous: &Path,
) -> Result<(), String> {
    if fs::rename(target, previous).is_err() {
        return Err("Не удалось отложить прежнюю папку Neyra".into());
    }
    if fs::rename(incoming, target).is_err() {
        return match put_previous_back(target, previous) {
            Ok(()) => Err("Не удалось заменить папку данных".into()),
            Err(left) => Err(format!("Не удалось заменить папку данных. {left}")),
        };
    }
    Ok(())
}

fn copy_aside(current: &Path, incoming: &Path) -> Result<(), String> {
    if incoming.exists() {
        fs::remove_dir_all(incoming).map_err(|_| "Не удалось скопировать данные")?;
    }
    fs::create_dir_all(incoming).map_err(|_| "Не удалось скопировать данные")?;
    copy_tree(current, incoming, 0)?;
    for dir in DIRECTORIES {
        fs::create_dir_all(incoming.join(dir)).map_err(|_| "Не удалось подготовить папку Neyra")?;
    }
    Ok(())
}

fn put_previous_back(target: &Path, previous: &Path) -> Result<(), String> {
    if !previous.exists() {
        return Ok(());
    }
    if target.exists() {
        return Err(format!("Прежние данные остались в {}.", previous.display()));
    }
    fs::rename(previous, target)
        .map_err(|_| format!("Прежние данные остались в {}.", previous.display()))
}

fn copy_tree(from: &Path, to: &Path, depth: usize) -> Result<(), String> {
    if depth > 6 {
        return Err("Слишком глубокая структура папки данных".into());
    }
    for entry in fs::read_dir(from).map_err(|_| "Не удалось прочитать папку данных")?
    {
        let entry = entry.map_err(|_| "Не удалось прочитать папку данных")?;
        let kind = entry
            .file_type()
            .map_err(|_| "Не удалось прочитать папку данных")?;
        let name = entry.file_name();
        // Symlinks and special files are never followed or copied.
        if kind.is_dir() {
            fs::create_dir_all(to.join(&name)).map_err(|_| "Не удалось скопировать данные")?;
            copy_tree(&entry.path(), &to.join(&name), depth + 1)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), to.join(&name)).map_err(|_| "Не удалось скопировать данные")?;
        }
    }
    Ok(())
}

pub fn read_limited(path: &Path, max: u64) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(|_| "Файл недоступен")?;
    let mut data = Vec::new();
    file.take(max + 1)
        .read_to_end(&mut data)
        .map_err(|_| "Файл недоступен")?;
    if data.len() as u64 > max {
        return Err("Файл слишком большой".into());
    }
    Ok(data)
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

pub fn create_directories(root: &Path) -> Result<(), String> {
    for dir in DIRECTORIES {
        fs::create_dir_all(root.join(dir)).map_err(|_| "Не удалось создать папку Neyra")?;
    }
    // License research docs are best-effort; never block app start (OneDrive/permissions).
    if let Err(err) = seed_character_docs(root) {
        eprintln!("Neyra: character docs seed skipped: {err}");
    }
    Ok(())
}

fn seed_character_docs(root: &Path) -> Result<(), String> {
    // Step-0 license research only; no binary .vrm bundled (ship/owner may deepen).
    let licenses = root.join("character/LICENSES.md");
    if !licenses.exists() {
        atomic_write(
            &licenses,
            include_str!("../../character/LICENSES.md").as_bytes(),
        )?;
    }
    let readme = root.join("character/README.txt");
    if !readme.exists() {
        atomic_write(
            &readme,
            include_str!("../../character/README.txt").as_bytes(),
        )?;
    }
    Ok(())
}

#[cfg(target_os = "linux")]
pub fn graphics_mode(root: &Path) -> String {
    read_limited(&root.join("settings/app.json"), MAX_CONFIG_BYTES)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v["graphics_mode"].as_str().map(str::to_owned))
        .unwrap_or_else(default_graphics)
}

fn quarantine(path: &Path, reason: &str) -> Option<String> {
    let name = path.file_name()?.to_string_lossy().into_owned();
    let target = path.with_file_name(format!("{name}.{reason}-{}", now_ms()));
    fs::rename(path, &target).ok()?;
    if let Some(dir) = path.parent() {
        let prefix = format!("{name}.");
        let mut old: Vec<_> = fs::read_dir(dir)
            .ok()?
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| {
                n.starts_with(&prefix)
                    && (n[prefix.len()..].starts_with("corrupt-")
                        || n[prefix.len()..].starts_with("unsupported-"))
            })
            .collect();
        old.sort();
        while old.len() > KEPT_QUARANTINE {
            let _ = fs::remove_file(dir.join(old.remove(0)));
        }
    }
    target.file_name().map(|n| n.to_string_lossy().into_owned())
}

fn salvage_device_id(bytes: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(bytes);
    let rest = &text[text.find("\"device_id\"")? + 11..];
    let start = rest.find('"')? + 1;
    let candidate = rest[start..].split('"').next()?;
    Uuid::parse_str(candidate).ok().map(|u| u.to_string())
}

enum Loaded<T> {
    Missing,
    Ok(T),
    Bad(String),
}

fn load_file<T>(
    path: &Path,
    version: u32,
    migrate: impl Fn(Value, u32) -> Result<Value, String>,
    parse: impl Fn(Value) -> Result<T, String>,
) -> Result<Loaded<T>, String> {
    if !path.exists() {
        return Ok(Loaded::Missing);
    }
    let bytes = match read_limited(path, MAX_CONFIG_BYTES) {
        Ok(bytes) => bytes,
        Err(e) if e == "Файл слишком большой" => {
            return Ok(Loaded::Bad("too_large".into()))
        }
        Err(_) => return Err("Не удалось прочитать файл настроек".into()),
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return Ok(Loaded::Bad("corrupt".into()));
    };
    let found = value["schema_version"].as_u64().unwrap_or(0) as u32;
    if found > version {
        return Ok(Loaded::Bad("unsupported".into()));
    }
    match migrate(value, found).and_then(parse) {
        Ok(loaded) => Ok(Loaded::Ok(loaded)),
        Err(_) => Ok(Loaded::Bad("corrupt".into())),
    }
}

fn migrate_settings(mut value: Value, found: u32) -> Result<Value, String> {
    let object = value.as_object_mut().ok_or("bad")?;
    if found <= 1 {
        // v1 kept permissions inside app.json; they now live in permissions/permissions.json.
        let permissions = object.remove("permissions");
        if let Some(permissions) = permissions {
            object.insert("legacy_permissions".into(), permissions);
        }
        object.insert("schema_version".into(), json!(SETTINGS_VERSION));
    }
    Ok(value)
}

fn recover<T>(
    path: &Path,
    label: &str,
    loaded: Loaded<T>,
    backup: impl Fn(&Path) -> Option<T>,
    recoveries: &mut Vec<Recovery>,
) -> Option<T> {
    match loaded {
        Loaded::Ok(value) => Some(value),
        Loaded::Missing => None,
        Loaded::Bad(why) => {
            let quarantined = quarantine(
                path,
                if why == "unsupported" {
                    "unsupported"
                } else {
                    "corrupt"
                },
            );
            let restored = backup(&path.with_extension("json.bak"));
            recoveries.push(Recovery {
                file: label.into(),
                reason: why,
                quarantined,
                restored: if restored.is_some() {
                    "backup"
                } else {
                    "defaults"
                }
                .into(),
            });
            restored
        }
    }
}

pub fn initialize(root: &Path) -> Result<(Settings, Vec<Recovery>), String> {
    create_directories(root)?;
    let mut recoveries = Vec::new();
    let settings_path = root.join("settings/app.json");
    let permissions_path = root.join("permissions/permissions.json");
    let parse_settings = |value: Value| -> Result<(SettingsFile, Option<Permissions>), String> {
        let mut value = value;
        let legacy = value
            .as_object_mut()
            .and_then(|o| o.remove("legacy_permissions"))
            .map(serde_json::from_value::<Permissions>)
            .transpose()
            .map_err(|_| "bad permissions")?;
        let file: SettingsFile = serde_json::from_value(value).map_err(|_| "bad settings")?;
        validate_settings_file(&file)?;
        Ok((file, legacy))
    };
    let loaded = load_file(
        &settings_path,
        SETTINGS_VERSION,
        migrate_settings,
        parse_settings,
    )?;
    let was_legacy = matches!(&loaded, Loaded::Ok((_, Some(_))));
    let from_backup =
        |backup: &Path| match load_file(backup, SETTINGS_VERSION, migrate_settings, parse_settings)
        {
            Ok(Loaded::Ok(v)) => Some(v),
            _ => None,
        };
    let (mut file, legacy) = match recover(
        &settings_path,
        "settings/app.json",
        loaded,
        from_backup,
        &mut recoveries,
    ) {
        Some(value) => value,
        None => {
            let fresh = Settings::default();
            (
                SettingsFile {
                    schema_version: SETTINGS_VERSION,
                    device_id: fresh.device_id,
                    device_name: fresh.device_name,
                    profiles: vec![],
                    theme: fresh.theme,
                    graphics_mode: fresh.graphics_mode,
                    audit_days: fresh.audit_days,
                    character_enabled: false,
                    voice: fresh.voice.clone(),
                },
                None,
            )
        }
    };
    // A quarantined file still holds the device identity; keeping it avoids a "new" PC on the server.
    if let Some(recovery) = recoveries
        .iter()
        .find(|r| r.file == "settings/app.json" && r.restored == "defaults")
    {
        if let Some(name) = &recovery.quarantined {
            if let Ok(bytes) = read_limited(&root.join("settings").join(name), MAX_CONFIG_BYTES) {
                if let Some(id) = salvage_device_id(&bytes) {
                    file.device_id = id;
                }
            }
        }
    }

    let permissions_loaded = load_file(
        &permissions_path,
        PERMISSIONS_VERSION,
        |value, _| Ok(value),
        |value| {
            let file: PermissionsFile = serde_json::from_value(value).map_err(|_| "bad")?;
            validate_permissions(&file.permissions)?;
            Ok(file.permissions)
        },
    )?;
    let permissions = match recover(
        &permissions_path,
        "permissions/permissions.json",
        permissions_loaded,
        |backup| match load_file(
            backup,
            PERMISSIONS_VERSION,
            |value, _| Ok(value),
            |value| {
                let file: PermissionsFile = serde_json::from_value(value).map_err(|_| "bad")?;
                validate_permissions(&file.permissions)?;
                Ok(file.permissions)
            },
        ) {
            Ok(Loaded::Ok(p)) => Some(p),
            _ => None,
        },
        &mut recoveries,
    ) {
        Some(p) => p,
        // Never widen: a missing/damaged permissions file means everything is off.
        None => legacy.unwrap_or_default(),
    };
    let settings = Settings {
        schema_version: SETTINGS_VERSION,
        device_id: file.device_id,
        device_name: file.device_name,
        profiles: file.profiles,
        permissions,
        theme: file.theme,
        graphics_mode: file.graphics_mode,
        audit_days: file.audit_days,
        character_enabled: file.character_enabled,
        voice: file.voice,
    };
    if was_legacy || !settings_path.exists() || !permissions_path.exists() {
        if was_legacy {
            let _ = fs::copy(&settings_path, settings_path.with_extension("json.v1.bak"));
        }
        save(root, &settings)?;
    }
    Ok((settings, recoveries))
}

pub fn valid_theme(theme: &str) -> bool {
    matches!(theme, "neyra" | "dark" | "light")
}

fn validate_settings_file(file: &SettingsFile) -> Result<(), String> {
    Uuid::parse_str(&file.device_id).map_err(|_| "bad device")?;
    if file.profiles.len() > 12
        || file.device_name.trim().is_empty()
        || file.device_name.len() > 80
        || !valid_theme(&file.theme)
        || !(1..=365).contains(&file.audit_days)
    {
        return Err("bad settings".into());
    }
    Ok(())
}

fn validate_permissions(p: &Permissions) -> Result<(), String> {
    if p.apps.len() > 200 || p.web_domains.len() > 50 {
        return Err("bad permissions".into());
    }
    Ok(())
}

pub fn save(root: &Path, settings: &Settings) -> Result<(), String> {
    let permissions = PermissionsFile {
        schema_version: PERMISSIONS_VERSION,
        permissions: settings.permissions.clone(),
    };
    write_with_backup(
        &root.join("permissions/permissions.json"),
        &serde_json::to_vec_pretty(&permissions)
            .map_err(|_| "Не удалось сериализовать разрешения")?,
    )?;
    let file = SettingsFile {
        schema_version: SETTINGS_VERSION,
        device_id: settings.device_id.clone(),
        device_name: settings.device_name.clone(),
        profiles: settings.profiles.clone(),
        theme: settings.theme.clone(),
        graphics_mode: settings.graphics_mode.clone(),
        audit_days: settings.audit_days,
        character_enabled: settings.character_enabled,
        voice: settings.voice.clone(),
    };
    write_with_backup(
        &root.join("settings/app.json"),
        &serde_json::to_vec_pretty(&file).map_err(|_| "Не удалось сериализовать настройки")?,
    )
}

/// Keeps the previous valid file as `.bak` so a later damaged write can be undone automatically.
fn write_with_backup(path: &Path, data: &[u8]) -> Result<(), String> {
    if path.exists() {
        let _ = fs::copy(path, path.with_extension("json.bak"));
    }
    atomic_write(path, data)
}

pub fn atomic_write(path: &Path, data: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let tmp = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let mut file = fs::File::create(&tmp).map_err(|_| "Не удалось записать файл")?;
    if file.write_all(data).and_then(|_| file.sync_all()).is_err() {
        let _ = fs::remove_file(&tmp);
        return Err("Не удалось записать файл".into());
    }
    drop(file);
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
        return Err("Не удалось заменить файл; повторите сохранение".into());
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

const CHAT_VERSION: u32 = 1;
const MAX_CHAT_BYTES: u64 = 1024 * 1024;
const MAX_CHAT_THREADS: usize = 30;
const MAX_CHAT_MESSAGES: usize = 100;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u32>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedChat {
    pub id: String,
    pub title: String,
    pub session_id: String,
    pub updated: u64,
    pub messages: Vec<SavedMessage>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatFile {
    schema_version: u32,
    threads: Vec<SavedChat>,
}

fn chats_path(root: &Path) -> PathBuf {
    root.join("chats/threads.json")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatLoad {
    pub threads: Vec<SavedChat>,
    pub recovery: Option<Recovery>,
}

pub fn load_chats(root: &Path) -> Result<ChatLoad, String> {
    let path = chats_path(root);
    if !path.exists() {
        return Ok(ChatLoad {
            threads: Vec::new(),
            recovery: None,
        });
    }
    let data = match read_limited(&path, MAX_CHAT_BYTES) {
        Ok(data) => data,
        Err(reason) if reason == "Файл слишком большой" => {
            return Ok(quarantine_chats(&path))
        }
        Err(reason) => return Err(reason),
    };
    let parsed = serde_json::from_slice::<ChatFile>(&data)
        .ok()
        .and_then(|file| {
            if file.schema_version != CHAT_VERSION {
                return None;
            }
            validate_chats(&file.threads).ok()?;
            Some(file.threads)
        });
    match parsed {
        Some(threads) => Ok(ChatLoad {
            threads,
            recovery: None,
        }),
        None => Ok(quarantine_chats(&path)),
    }
}

fn quarantine_chats(path: &Path) -> ChatLoad {
    let quarantined = quarantine(path, "corrupt");
    ChatLoad {
        threads: Vec::new(),
        recovery: Some(Recovery {
            file: "chats/threads.json".into(),
            reason: "corrupt".into(),
            quarantined,
            restored: "empty".into(),
        }),
    }
}

pub fn save_chats(root: &Path, threads: &[SavedChat]) -> Result<(), String> {
    validate_chats(threads)?;
    let threads = fit_chat_bytes(threads);
    fs::create_dir_all(root.join("chats")).map_err(|_| "Не удалось создать папку чатов")?;
    let file = ChatFile {
        schema_version: CHAT_VERSION,
        threads,
    };
    atomic_write(
        &chats_path(root),
        &serde_json::to_vec_pretty(&file).map_err(|_| "Не удалось записать историю чатов")?,
    )
}

fn fit_chat_bytes(threads: &[SavedChat]) -> Vec<SavedChat> {
    let mut kept = threads.to_vec();
    loop {
        let bytes = serde_json::to_vec_pretty(&ChatFile {
            schema_version: CHAT_VERSION,
            threads: kept.clone(),
        })
        .unwrap_or_default();
        if (bytes.len() as u64) <= MAX_CHAT_BYTES || kept.is_empty() {
            return kept;
        }
        if kept.len() > 1 {
            kept.pop();
            continue;
        }
        if kept[0].messages.len() > 1 {
            let drop_n = (kept[0].messages.len() / 2).max(1);
            kept[0].messages.drain(0..drop_n);
            continue;
        }
        if kept[0].messages.is_empty() {
            kept.clear();
            continue;
        }
        let chars = kept[0].messages[0].content.chars().count();
        if chars > 200 {
            kept[0].messages[0].content = kept[0].messages[0]
                .content
                .chars()
                .take(chars / 2)
                .collect();
        } else {
            kept.clear();
        }
    }
}

fn validate_chats(threads: &[SavedChat]) -> Result<(), String> {
    if threads.len() > MAX_CHAT_THREADS {
        return Err("Слишком много чатов".into());
    }
    for thread in threads {
        if !plain_id(&thread.id)
            || !plain_id(&thread.session_id)
            || thread.title.chars().count() > 80
        {
            return Err("История чатов повреждена".into());
        }
        Uuid::parse_str(&thread.session_id).map_err(|_| "История чатов повреждена")?;
        if thread.messages.len() > MAX_CHAT_MESSAGES {
            return Err("Слишком длинный чат".into());
        }
        for message in &thread.messages {
            if !plain_id(&message.id)
                || !matches!(message.role.as_str(), "user" | "assistant")
                || !matches!(message.kind.as_str(), "text" | "voice")
                || message.content.chars().count() > 8000
                || message.duration_ms.is_some_and(|ms| ms > 120_000)
            {
                return Err("История чатов повреждена".into());
            }
        }
    }
    Ok(())
}

fn plain_id(value: &str) -> bool {
    (1..=80).contains(&value.chars().count())
        && !value.contains(['/', '\\'])
        && !value.contains("..")
}

#[cfg(test)]
mod tests {
    use super::*;
    fn temp() -> PathBuf {
        std::env::temp_dir().join(Uuid::new_v4().to_string())
    }
    #[test]
    fn chats_round_trip_and_reject_a_bad_file() {
        let root = temp();
        create_directories(&root).unwrap();
        assert!(load_chats(&root).unwrap().threads.is_empty());
        let thread = SavedChat {
            id: "thread-1".into(),
            title: "Привет".into(),
            session_id: Uuid::new_v4().to_string(),
            updated: 10,
            messages: vec![SavedMessage {
                id: "m1".into(),
                role: "user".into(),
                content: "секрет".into(),
                kind: "text".into(),
                duration_ms: None,
            }],
        };
        save_chats(&root, &[thread]).unwrap();
        let loaded = load_chats(&root).unwrap();
        assert!(loaded.recovery.is_none());
        assert_eq!(loaded.threads[0].messages[0].content, "секрет");
        assert!(!root
            .join("chats")
            .read_dir()
            .unwrap()
            .any(|e| { e.unwrap().file_name().to_string_lossy().contains(".tmp") }));
        fs::write(root.join("chats/threads.json"), br#"{"schema_version":1,"threads":[{"id":"x","title":"t","sessionId":"not-a-uuid","updated":1,"messages":[]}]}"#).unwrap();
        let broken = load_chats(&root).unwrap();
        assert!(broken.threads.is_empty());
        assert_eq!(broken.recovery.unwrap().file, "chats/threads.json");
        assert!(
            !root.join("chats/threads.json").exists(),
            "a bad file is quarantined"
        );
        save_chats(&root, &[]).unwrap();
        assert!(load_chats(&root).unwrap().recovery.is_none());
        fs::write(
            root.join("chats/threads.json"),
            br#"{"schema_version":1,"threads":[],"token":"secret"}"#,
        )
        .unwrap();
        assert!(load_chats(&root).unwrap().recovery.is_some());
        assert!(!root.join("chats/threads.json").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn save_trims_cyrillic_history_to_the_read_limit() {
        let root = temp();
        create_directories(&root).unwrap();
        let session = Uuid::new_v4().to_string();
        let mut threads = Vec::new();
        for index in 0..8 {
            let messages = (0..20)
                .map(|message| SavedMessage {
                    id: format!("m-{index}-{message}"),
                    role: "user".into(),
                    content: "я".repeat(4000),
                    kind: "text".into(),
                    duration_ms: None,
                })
                .collect();
            threads.push(SavedChat {
                id: format!("t-{index}"),
                title: "Чат".into(),
                session_id: session.clone(),
                updated: index,
                messages,
            });
        }
        save_chats(&root, &threads).unwrap();
        let bytes = fs::metadata(chats_path(&root)).unwrap().len();
        assert!(bytes <= MAX_CHAT_BYTES, "{bytes}");
        let loaded = load_chats(&root).unwrap();
        assert!(loaded.threads.len() < threads.len());
        assert!(loaded.threads.iter().any(|thread| thread
            .messages
            .iter()
            .any(|message| message.content.contains('я'))));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn settings_never_contain_token() {
        let value = serde_json::to_string(&Settings::default()).unwrap();
        assert!(!value.contains("token"));
    }
    #[test]
    fn settings_from_before_live_voice_still_load() {
        let mut old = serde_json::to_value(Settings::default()).unwrap();
        old.as_object_mut().unwrap().remove("voice");
        let s: Settings = serde_json::from_value(old).unwrap();
        assert_eq!(s.voice, crate::voice::VoiceSettings::default());
        assert_eq!(s.voice.mode, "ptt");
    }
    #[test]
    fn initialize_creates_every_directory_and_keeps_identity() {
        let root = temp();
        let (s, recovered) = initialize(&root).unwrap();
        assert!(recovered.is_empty());
        for dir in DIRECTORIES {
            assert!(root.join(dir).is_dir(), "{dir}");
        }
        assert!(root.join("wakeword").is_dir());
        save(&root, &s).unwrap();
        assert_eq!(initialize(&root).unwrap().0.device_id, s.device_id);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn permissions_live_in_their_own_versioned_file_and_no_token_on_disk() {
        let root = temp();
        let (mut s, _) = initialize(&root).unwrap();
        s.permissions.enabled = true;
        s.permissions.web_domains = vec!["example.com".into()];
        save(&root, &s).unwrap();
        let app = fs::read_to_string(root.join("settings/app.json")).unwrap();
        let perms = fs::read_to_string(root.join("permissions/permissions.json")).unwrap();
        assert!(!app.contains("permissions") && !app.contains("example.com"));
        assert!(perms.contains("\"schema_version\": 1") && perms.contains("example.com"));
        for text in [&app, &perms] {
            assert!(!text.to_lowercase().contains("token"));
        }
        assert!(initialize(&root).unwrap().0.permissions.enabled);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn v1_settings_migrate_without_losing_permissions_or_identity() {
        let root = temp();
        create_directories(&root).unwrap();
        let id = Uuid::new_v4().to_string();
        let legacy = json!({"schema_version":1,"device_id":id,"device_name":"Старый ПК","profiles":[],
            "permissions":{"enabled":true,"apps":[],"allow_web":true,"web_domains":["a.example"],"system":false},
            "theme":"light","graphics_mode":"x11"});
        fs::write(root.join("settings/app.json"), legacy.to_string()).unwrap();
        let (s, recovered) = initialize(&root).unwrap();
        assert!(recovered.is_empty());
        assert_eq!(
            (
                s.device_id.as_str(),
                s.theme.as_str(),
                s.graphics_mode.as_str()
            ),
            (id.as_str(), "light", "x11")
        );
        assert!(
            s.permissions.enabled
                && s.permissions.web_domains == ["a.example"]
                && !s.permissions.system
        );
        assert_eq!(s.schema_version, SETTINGS_VERSION);
        assert!(root.join("settings/app.json.v1.bak").exists());
        assert!(!fs::read_to_string(root.join("settings/app.json"))
            .unwrap()
            .contains("permissions"));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn corrupt_settings_restore_last_good_backup_and_report() {
        let root = temp();
        let (mut s, _) = initialize(&root).unwrap();
        s.device_name = "Первая версия".into();
        save(&root, &s).unwrap();
        s.device_name = "Вторая версия".into();
        save(&root, &s).unwrap();
        fs::write(root.join("settings/app.json"), b"{ not json").unwrap();
        let (restored, recovered) = initialize(&root).unwrap();
        assert_eq!(restored.device_name, "Первая версия");
        assert_eq!(restored.device_id, s.device_id);
        assert_eq!(recovered.len(), 1);
        assert_eq!(
            (recovered[0].reason.as_str(), recovered[0].restored.as_str()),
            ("corrupt", "backup")
        );
        let kept = recovered[0].quarantined.clone().unwrap();
        assert_eq!(
            fs::read(root.join("settings").join(kept)).unwrap(),
            b"{ not json"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn corrupt_without_backup_keeps_device_identity_and_never_widens_permissions() {
        let root = temp();
        create_directories(&root).unwrap();
        let id = Uuid::new_v4().to_string();
        fs::write(
            root.join("settings/app.json"),
            format!("{{\"schema_version\":2,\"device_id\":\"{id}\",\"device_name\":"),
        )
        .unwrap();
        fs::write(root.join("permissions/permissions.json"), b"garbage").unwrap();
        let (s, recovered) = initialize(&root).unwrap();
        assert_eq!(s.device_id, id);
        assert!(!s.permissions.enabled);
        assert_eq!(recovered.len(), 2);
        assert!(recovered
            .iter()
            .all(|r| r.restored == "defaults" && r.quarantined.is_some()));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn newer_schema_is_preserved_not_overwritten() {
        let root = temp();
        create_directories(&root).unwrap();
        let original = br#"{"schema_version":99,"future":true}"#;
        fs::write(root.join("settings/app.json"), original).unwrap();
        let (_, recovered) = initialize(&root).unwrap();
        assert_eq!(recovered[0].reason, "unsupported");
        let kept = recovered[0].quarantined.clone().unwrap();
        assert!(kept.contains("unsupported-"));
        assert_eq!(
            fs::read(root.join("settings").join(kept)).unwrap(),
            original
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn quarantine_history_is_bounded() {
        let root = temp();
        create_directories(&root).unwrap();
        for _ in 0..8 {
            fs::write(root.join("settings/app.json"), b"x").unwrap();
            initialize(&root).unwrap();
            std::thread::sleep(Duration::from_millis(3));
        }
        let count = fs::read_dir(root.join("settings"))
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".corrupt-"))
            .count();
        assert!(count <= KEPT_QUARANTINE, "{count}");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn oversized_config_is_treated_as_damaged() {
        let root = temp();
        create_directories(&root).unwrap();
        fs::write(root.join("settings/app.json"), vec![b' '; 1024 * 1024 + 10]).unwrap();
        let (_, recovered) = initialize(&root).unwrap();
        assert_eq!(recovered[0].reason, "too_large");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn atomic_write_replaces_without_leaving_temp_files() {
        let root = temp();
        fs::create_dir_all(&root).unwrap();
        let path = root.join("a.json");
        atomic_write(&path, b"one").unwrap();
        atomic_write(&path, b"two").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"two");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn moving_data_copies_without_deleting_and_rejects_nesting() {
        let from = temp();
        initialize(&from).unwrap();
        fs::write(from.join("commands/a.yaml"), "x").unwrap();
        let to = temp();
        let old_pointer = pointer_path();
        // Only the copy logic is exercised; the real pointer file is not written in tests.
        assert!(move_data_root(&from, &from.join("inner")).is_err());
        copy_tree(
            &from,
            &{
                fs::create_dir_all(&to).unwrap();
                to.clone()
            },
            0,
        )
        .unwrap();
        assert_eq!(fs::read(to.join("commands/a.yaml")).unwrap(), b"x");
        assert!(from.join("commands/a.yaml").exists());
        let _ = old_pointer;
        fs::remove_dir_all(from).unwrap();
        fs::remove_dir_all(to).unwrap();
    }
    #[test]
    fn staging_keeps_an_existing_neyra_folder() {
        let from = temp();
        initialize(&from).unwrap();
        fs::write(from.join("commands/new.yaml"), "new").unwrap();
        let to = temp();
        initialize(&to).unwrap();
        fs::write(to.join("commands/old.yaml"), "old").unwrap();
        let (_, reused) = stage_data_root(&from, &to, false).unwrap();
        assert!(reused);
        assert_eq!(fs::read(to.join("commands/old.yaml")).unwrap(), b"old");
        assert!(!to.join("commands/new.yaml").exists());
        let empty = temp();
        let (_, reused) = stage_data_root(&from, &empty, false).unwrap();
        assert!(!reused);
        assert_eq!(fs::read(empty.join("commands/new.yaml")).unwrap(), b"new");
        fs::remove_dir_all(from).unwrap();
        fs::remove_dir_all(to).unwrap();
        fs::remove_dir_all(empty).unwrap();
    }
    #[test]
    fn overwrite_parks_the_existing_folder_and_copies_the_current_one() {
        let from = temp();
        initialize(&from).unwrap();
        fs::write(from.join("commands/new.yaml"), "new").unwrap();
        let parent = temp();
        let to = parent.join("Neyra");
        initialize(&to).unwrap();
        fs::write(to.join("commands/old.yaml"), "old").unwrap();
        assert!(peek_data_move(&from, &to).unwrap());
        let (_, reused) = stage_data_root(&from, &to, true).unwrap();
        assert!(!reused);
        assert_eq!(fs::read(to.join("commands/new.yaml")).unwrap(), b"new");
        assert!(!to.join("commands/old.yaml").exists());
        assert!(from.join("commands/new.yaml").exists());
        let parked = fs::read_dir(&parent).unwrap().flatten().any(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("Neyra.previous-")
                && entry.path().join("commands/old.yaml").is_file()
        });
        assert!(parked);
        let leftover = fs::read_dir(&parent)
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().contains(".incoming-"));
        assert!(!leftover);
        fs::remove_dir_all(from).unwrap();
        fs::remove_dir_all(parent).unwrap();
    }
    #[test]
    fn overwrite_of_a_too_deep_tree_leaves_the_old_folder() {
        let from = temp();
        initialize(&from).unwrap();
        let mut deep = from.join("commands");
        for name in ["l1", "l2", "l3", "l4", "l5", "l6"] {
            deep = deep.join(name);
        }
        fs::create_dir_all(&deep).unwrap();
        fs::write(deep.join("too-deep.txt"), "x").unwrap();
        let parent = temp();
        let to = parent.join("Neyra");
        initialize(&to).unwrap();
        fs::write(to.join("commands/old.yaml"), "old").unwrap();
        let err = stage_data_root(&from, &to, true).unwrap_err();
        assert!(err.contains("глубокая"));
        assert_eq!(fs::read(to.join("commands/old.yaml")).unwrap(), b"old");
        assert!(!fs::read_dir(&parent).unwrap().flatten().any(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.contains(".incoming-") || name.contains(".previous-")
        }));
        fs::remove_dir_all(from).unwrap();
        fs::remove_dir_all(parent).unwrap();
    }
    #[test]
    fn failed_swap_puts_the_previous_folder_back() {
        let parent = temp();
        let target = parent.join("Neyra");
        fs::create_dir_all(target.join("commands")).unwrap();
        fs::write(target.join("commands/old.yaml"), "old").unwrap();
        let incoming = parent.join("Neyra.incoming-missing");
        let previous = parent.join("Neyra.previous-test");
        let err = replace_with_incoming_swap(&target, &incoming, &previous).unwrap_err();
        assert_eq!(err, "Не удалось заменить папку данных");
        assert_eq!(fs::read(target.join("commands/old.yaml")).unwrap(), b"old");
        assert!(!previous.exists());
        fs::remove_dir_all(parent).unwrap();
    }
    #[test]
    fn stuck_previous_folder_is_named_in_the_error() {
        let parent = temp();
        let target = parent.join("Neyra");
        fs::create_dir_all(target.join("commands")).unwrap();
        fs::write(target.join("commands/kept.yaml"), "kept").unwrap();
        let previous = parent.join("Neyra.previous-stuck");
        fs::create_dir_all(previous.join("commands")).unwrap();
        fs::write(previous.join("commands/old.yaml"), "old").unwrap();
        let err = put_previous_back(&target, &previous).unwrap_err();
        assert!(err.contains(&previous.display().to_string()));
        assert_eq!(
            fs::read(previous.join("commands/old.yaml")).unwrap(),
            b"old"
        );
        assert_eq!(
            fs::read(target.join("commands/kept.yaml")).unwrap(),
            b"kept"
        );
        fs::remove_dir_all(parent).unwrap();
    }
    #[test]
    fn pointer_must_be_an_existing_absolute_directory() {
        let root = temp();
        fs::create_dir_all(&root).unwrap();
        let pointer = root.join("p.json");
        fs::write(&pointer, json!({"data_root":root}).to_string()).unwrap();
        assert_eq!(read_pointer(&pointer), Some(root.clone()));
        fs::write(&pointer, json!({"data_root":"relative/dir"}).to_string()).unwrap();
        assert_eq!(read_pointer(&pointer), None);
        fs::write(
            &pointer,
            json!({"data_root":root.join("missing")}).to_string(),
        )
        .unwrap();
        assert_eq!(read_pointer(&pointer), None);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn initialize_seeds_character_license_research() {
        let root = temp();
        initialize(&root).unwrap();
        let licenses = fs::read_to_string(root.join("character/LICENSES.md")).unwrap();
        assert!(licenses.contains("Desktop Mate"));
        assert!(licenses.contains("Нет"));
        assert!(root.join("wakeword").is_dir());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn old_settings_without_character_enabled_default_false() {
        let json = r#"{"schema_version":1,"device_id":"00000000-0000-4000-8000-000000000001","device_name":"ПК","profiles":[],"permissions":{"enabled":false,"apps":[],"allow_web":true,"web_domains":[],"system":true},"theme":"dark","graphics_mode":"auto"}"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert!(!settings.character_enabled);
        let root = temp();
        create_directories(&root).unwrap();
        fs::write(root.join("settings/app.json"), json).unwrap();
        let (migrated, recovered) = initialize(&root).unwrap();
        assert!(recovered.is_empty() && !migrated.character_enabled);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn character_flag_survives_save_and_reload() {
        let root = temp();
        let (mut s, _) = initialize(&root).unwrap();
        s.character_enabled = true;
        save(&root, &s).unwrap();
        assert!(initialize(&root).unwrap().0.character_enabled);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn initialize_survives_readonly_character_dir() {
        use std::os::unix::fs::PermissionsExt;
        let root = temp();
        fs::create_dir_all(root.join("character")).unwrap();
        let mut perms = fs::metadata(root.join("character")).unwrap().permissions();
        perms.set_mode(0o555);
        fs::set_permissions(root.join("character"), perms).unwrap();
        let result = initialize(&root);
        let mut perms = fs::metadata(root.join("character")).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(root.join("character"), perms).unwrap();
        assert!(result.is_ok(), "seed failure must not abort initialize");
        let _ = fs::remove_dir_all(&root);
    }
}
