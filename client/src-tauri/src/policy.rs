use crate::storage::Permissions;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolCall {
    pub call_id: String,
    pub device_id: String,
    pub session_id: String,
    pub tool: String,
    pub arguments: Value,
    pub deadline_ms: u64,
}
#[derive(PartialEq, Debug)]
pub enum Decision {
    Safe,
    Confirm,
}

pub fn secret_path(path: &Path) -> bool {
    path.components().any(|part| {
        let s = part.as_os_str().to_string_lossy().to_lowercase();
        s == ".ssh"
            || s == ".gnupg"
            || s == "keychains"
            || s == "keyrings"
            || s == "login data"
            || s == "cookies"
            || s == ".mozilla"
            || s == "google"
            || s == "chromium"
            || s == "microsoftedge"
            || s == "wallets"
            || s == "kwalletd"
            || s == ".env"
            || s.starts_with(".env.")
            || s.ends_with(".pem")
            || s.ends_with(".key")
    })
}

pub fn checked_file(path: &str) -> Result<PathBuf, String> {
    let path = std::fs::canonicalize(path).map_err(|_| "Файл недоступен")?;
    if secret_path(&path) {
        return Err("Доступ к секретам запрещён".into());
    }
    Ok(path)
}

pub fn web_url(value: &str) -> Result<url::Url, String> {
    if value.len() > 2048 {
        return Err("Ссылка слишком длинная".into());
    }
    let url = url::Url::parse(value).map_err(|_| "Неверная ссылка")?;
    if !matches!(url.scheme(), "https" | "http")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Разрешены только веб-ссылки без credentials".into());
    }
    Ok(url)
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn validate(
    call: &ToolCall,
    permissions: &Permissions,
    device: &str,
    session: &str,
    seen: &mut HashMap<String, u64>,
) -> Result<Decision, String> {
    if uuid::Uuid::parse_str(&call.call_id).is_err()
        || call.device_id != device
        || call.session_id != session
        || call.deadline_ms <= now_ms()
        || call.deadline_ms > now_ms() + 31000
    {
        return Err("Вызов устарел или адресован другому ПК".into());
    }
    seen.retain(|_, deadline| *deadline > now_ms());
    if seen.contains_key(&call.call_id) {
        return Err("Повторный вызов отклонён".into());
    }
    if seen.len() >= 2048 {
        return Err("Лимит сессии: переподключитесь".into());
    }
    seen.insert(call.call_id.clone(), call.deadline_ms);
    if !permissions.enabled {
        return Err("Доступ к ПК выключен".into());
    }
    let args = call.arguments.as_object().ok_or("Неверные параметры")?;
    let keys: Vec<&str> = match call.tool.as_str() {
        "client.open_url" => vec!["url"],
        "client.search_web" => vec!["query"],
        "client.open_app" => vec!["path"],
        "client.focus_window" | "client.close_window" => vec!["window"],
        "client.media" => vec!["action"],
        "client.volume" => vec!["action"],
        "client.list_windows" | "client.list_apps" => vec![],
        _ => return Err("Инструмент недоступен".into()),
    };
    if args.keys().any(|k| !keys.contains(&k.as_str())) || args.len() != keys.len() {
        return Err("Неверные параметры инструмента".into());
    }
    match call.tool.as_str() {
        "client.open_url" if permissions.allow_web => {
            let url = web_url(
                args.get("url")
                    .and_then(Value::as_str)
                    .ok_or("Неверная ссылка")?,
            )?;
            if permissions
                .web_domains
                .iter()
                .any(|domain| Some(domain.as_str()) == url.host_str())
            {
                Ok(Decision::Safe)
            } else {
                Ok(Decision::Confirm)
            }
        }
        "client.search_web" if permissions.allow_web => {
            let q = args
                .get("query")
                .and_then(Value::as_str)
                .ok_or("Неверный запрос")?;
            if q.len() > 500 || q.trim().is_empty() {
                return Err("Неверный запрос".into());
            }
            Ok(Decision::Safe)
        }
        "client.close_window" if permissions.system => Ok(Decision::Confirm),
        "client.list_apps" if permissions.system => Ok(Decision::Safe),
        "client.open_app" if permissions.system => {
            let path = checked_file(
                args.get("path")
                    .and_then(Value::as_str)
                    .ok_or("Неверный путь")?,
            )?;
            if !path.is_file() {
                return Err("Нужен исполняемый файл".into());
            }
            if permissions
                .apps
                .iter()
                .any(|p| std::fs::canonicalize(p).ok().as_ref() == Some(&path))
            {
                Ok(Decision::Safe)
            } else {
                Ok(Decision::Confirm)
            }
        }
        "client.list_windows" | "client.focus_window" | "client.media" | "client.volume"
            if permissions.system =>
        {
            Ok(Decision::Safe)
        }
        _ => Err("Контур выключен".into()),
    }
}

#[cfg(target_os = "linux")]
fn restored_path(
    current: Option<std::ffi::OsString>,
    original: Option<std::ffi::OsString>,
    mount: &Path,
) -> Option<std::ffi::OsString> {
    if original.is_some() {
        return original;
    }
    let value = current?;
    if value.is_empty() {
        return Some(value);
    }
    let kept: Vec<_> = std::env::split_paths(&value)
        .filter(|p| !p.starts_with(mount) && !p.to_string_lossy().contains("/tmp/.mount_"))
        .collect();
    if kept.is_empty() {
        None
    } else {
        std::env::join_paths(kept).ok()
    }
}

pub fn child_environment(command: &mut Command) {
    #[cfg(target_os = "linux")]
    {
        if let Some(appdir) = std::env::var_os("APPDIR") {
            let mount = PathBuf::from(appdir);
            for name in [
                "LD_LIBRARY_PATH",
                "LD_PRELOAD",
                "PATH",
                "GTK_PATH",
                "GTK_EXE_PREFIX",
                "GTK_DATA_PREFIX",
                "GIO_EXTRA_MODULES",
                "GIO_MODULE_DIR",
                "GI_TYPELIB_PATH",
                "GDK_PIXBUF_MODULE_FILE",
                "GSETTINGS_SCHEMA_DIR",
                "QT_PLUGIN_PATH",
                "PYTHONPATH",
                "XDG_DATA_DIRS",
            ] {
                let old = format!("OLD_{name}");
                match restored_path(std::env::var_os(name), std::env::var_os(&old), &mount) {
                    Some(value) => {
                        command.env(name, value);
                    }
                    None => {
                        command.env_remove(name);
                    }
                }
                command.env_remove(old);
            }
            for name in ["APPDIR", "APPIMAGE", "ARGV0", "OWD"] {
                command.env_remove(name);
            }
        }
        for (key, original) in [
            ("GDK_BACKEND", "NEYRA_ORIGINAL_GDK_BACKEND"),
            ("WEBKIT_DISABLE_DMABUF_RENDERER", "NEYRA_ORIGINAL_DMABUF"),
            ("__NV_DISABLE_EXPLICIT_SYNC", "NEYRA_ORIGINAL_EXPLICIT_SYNC"),
        ] {
            if std::env::var_os("NEYRA_GRAPHICS_APPLIED").is_some() {
                match std::env::var_os(original) {
                    Some(value) => {
                        command.env(key, value);
                    }
                    None => {
                        command.env_remove(key);
                    }
                }
            }
            command.env_remove(original);
        }
        command.env_remove("NEYRA_GRAPHICS_APPLIED");
    }
    #[cfg(not(target_os = "linux"))]
    let _ = command;
}

pub fn available_program(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|p| p.join(name))
            .find(|p| p.is_file())
    })
}

pub fn capabilities(p: &Permissions) -> Vec<String> {
    if !p.enabled {
        return vec![];
    }
    let mut tools = Vec::new();
    if p.system {
        tools.extend(["client.open_app".into(), "client.list_apps".into()]);
    }
    if p.allow_web {
        tools.extend(["client.open_url".into(), "client.search_web".into()]);
    }
    if p.system {
        if cfg!(windows)
            || (std::env::var("XDG_SESSION_TYPE").unwrap_or_default() != "wayland"
                && available_program("wmctrl").is_some())
        {
            tools.extend(["client.list_windows".into(), "client.focus_window".into()]);
        }
        if cfg!(windows) || available_program("playerctl").is_some() {
            tools.push("client.media".into());
        }
        if cfg!(windows) || available_program("pactl").is_some() {
            tools.push("client.volume".into());
        }
    }
    tools
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "linux")]
    #[test]
    fn appimage_restores_unset_empty_and_custom_values() {
        use std::ffi::OsString;
        let mount = Path::new("/tmp/.mount_test");
        assert_eq!(
            restored_path(Some(OsString::from("/tmp/.mount_test/lib")), None, mount),
            None
        );
        assert_eq!(
            restored_path(None, Some(OsString::new()), mount),
            Some(OsString::new())
        );
        assert_eq!(
            restored_path(None, Some(OsString::from("/my/lib")), mount),
            Some(OsString::from("/my/lib"))
        );
        assert_eq!(
            restored_path(
                Some(OsString::from("/tmp/.mount_test/lib:/my/lib")),
                None,
                mount
            ),
            Some(OsString::from("/my/lib"))
        );
    }
    #[test]
    fn reject_local_and_credential_urls() {
        for u in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "https://user:password@example.com",
        ] {
            assert!(web_url(u).is_err());
        }
    }
    #[test]
    fn secret_components_are_blocked() {
        for p in [
            "/home/me/.ssh/id_rsa",
            "C:/Users/me/.env.local",
            "/home/me/.mozilla/firefox/cookies.sqlite",
        ] {
            assert!(secret_path(Path::new(p)));
        }
    }
    #[test]
    fn disabled_means_no_capabilities() {
        assert!(capabilities(&Permissions::default()).is_empty());
    }
    #[test]
    fn cannot_replay_a_call() {
        let p = Permissions {
            enabled: true,
            allow_web: true,
            web_domains: vec!["example.com".into()],
            ..Default::default()
        };
        let call = ToolCall {
            call_id: uuid::Uuid::new_v4().to_string(),
            device_id: "d".into(),
            session_id: "s".into(),
            tool: "client.open_url".into(),
            arguments: serde_json::json!({"url":"https://example.com"}),
            deadline_ms: now_ms() + 10000,
        };
        let mut seen = HashMap::new();
        assert_eq!(
            validate(&call, &p, "d", "s", &mut seen).unwrap(),
            Decision::Safe
        );
        assert!(validate(&call, &p, "d", "s", &mut seen).is_err());
    }
}
