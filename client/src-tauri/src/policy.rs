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
    // Match profile/storage locations, not bare browser brand names (AR-5):
    // /opt/google/chrome and chrome.exe stay allowed; User Data / .config profiles do not.
    let normalized = path.to_string_lossy().replace('\\', "/").to_lowercase();
    let markers = [
        "/.ssh/",
        "/.gnupg/",
        "/.aws/",
        "/.kube/",
        "/.config/gcloud/",
        "/keychains/",
        "/keyrings/",
        "/kwalletd/",
        "/wallets/",
        "/login data",
        "/cookies",
        "/.mozilla/",
        "/appdata/roaming/mozilla/",
        "/.config/google-chrome/",
        "/.config/chromium/",
        "/.config/microsoft-edge/",
        "/appdata/local/google/chrome/user data",
        "/appdata/local/microsoft/edge/user data",
        "/appdata/local/chromium/user data",
        "/appdata/roaming/google/chrome/",
    ];
    if markers.iter().any(|m| normalized.contains(m)) {
        return true;
    }
    path.components().any(|part| {
        let s = part.as_os_str().to_string_lossy().to_lowercase();
        s == ".ssh"
            || s == ".gnupg"
            || s == ".aws"
            || s == ".kube"
            || s == "keychains"
            || s == "keyrings"
            || s == "login data"
            || s == "cookies"
            || s == ".mozilla"
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
    if value.len() > 2048 || value.chars().any(char::is_control) {
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

/// Loopback, private-network and IP-literal hosts never skip the card, even if allowlisted:
/// a page on the LAN (router, NAS, dev server) is a different trust zone than the web.
pub fn local_host(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Ipv4(_)) | Some(url::Host::Ipv6(_)) => true,
        Some(url::Host::Domain(d)) => {
            let d = d.trim_end_matches('.').to_ascii_lowercase();
            d == "localhost"
                || !d.contains('.')
                || [
                    ".localhost",
                    ".local",
                    ".lan",
                    ".home",
                    ".internal",
                    ".intranet",
                    ".corp",
                ]
                .iter()
                .any(|s| d.ends_with(s))
        }
        None => true,
    }
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
    data_root: &Path,
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
    let (required, optional): (&[&str], &[&str]) = match call.tool.as_str() {
        "client.open_url" => (&["url"], &[]),
        "client.search_web" => (&["query"], &[]),
        "client.open_app" => (&["path"], &[]),
        "client.focus_window" | "client.close_window" => (&["window"], &[]),
        "client.media" => (&["action"], &[]),
        "client.volume" => (&["action"], &[]),
        "client.list_windows" | "client.list_apps" => (&[], &[]),
        "client.shell_exec" => (&["program"], &["args", "cwd", "env", "timeout_ms"]),
        "client.fs_list" => (&["path"], &[]),
        "client.fs_read" => (&["path"], &["offset", "max_bytes"]),
        "client.fs_search" => (&["path"], &["name", "content"]),
        "client.fs_write" => (&["path", "content", "mode"], &[]),
        "client.fs_mkdir" => (&["path"], &[]),
        "client.fs_move" => (&["from", "to"], &[]),
        "client.screenshot" => (&[], &["window"]),
        "client.input" => (&["steps"], &["screenshot_id"]),
        _ => return Err("Инструмент недоступен".into()),
    };
    if args
        .keys()
        .any(|k| !required.contains(&k.as_str()) && !optional.contains(&k.as_str()))
        || required.iter().any(|k| !args.contains_key(*k))
    {
        return Err("Неверные параметры инструмента".into());
    }
    let text = |key: &str| {
        args.get(key)
            .and_then(Value::as_str)
            .ok_or_else(|| "Неверный параметр".to_string())
    };
    let scope = || crate::files::Scope::new(&permissions.fs_roots, data_root);
    match call.tool.as_str() {
        "client.shell_exec" if permissions.shell => {
            // Arbitrary CLI is never "safe" by deny-list alone (§3b.9).
            crate::shell::plan(args, &scope())?;
            Ok(Decision::Confirm)
        }
        "client.fs_list" | "client.fs_read" | "client.fs_search" if permissions.files => {
            scope().existing(text("path")?)?;
            for key in ["offset", "max_bytes"] {
                if args.get(key).is_some_and(|v| v.as_u64().is_none()) {
                    return Err("Неверный параметр".into());
                }
            }
            for key in ["name", "content"] {
                if args
                    .get(key)
                    .is_some_and(|v| v.as_str().is_none_or(|s| s.len() > 200))
                {
                    return Err("Неверный параметр поиска".into());
                }
            }
            Ok(Decision::Safe)
        }
        "client.fs_write" if permissions.files => {
            let scope = scope();
            if text("content")?.len() > crate::files::WRITE_LIMIT {
                return Err("Слишком большой текст для записи".into());
            }
            match text("mode")? {
                "create" => scope.fresh(text("path")?)?,
                "overwrite" | "append" => scope.entry(text("path")?)?,
                _ => return Err("Неизвестный режим записи".into()),
            };
            Ok(Decision::Confirm)
        }
        "client.fs_mkdir" if permissions.files => {
            scope().fresh(text("path")?)?;
            Ok(Decision::Confirm)
        }
        "client.fs_move" if permissions.files => {
            let scope = scope();
            scope.entry(text("from")?)?;
            scope.fresh(text("to")?)?;
            Ok(Decision::Confirm)
        }
        "client.screenshot" if permissions.screen => {
            if args
                .get("window")
                .is_some_and(|w| w.as_str().is_none_or(|s| s.len() > 24))
            {
                return Err("Неверное окно".into());
            }
            Ok(if permissions.screen_auto {
                Decision::Safe
            } else {
                Decision::Confirm
            })
        }
        "client.input" if permissions.input => {
            crate::screen::parse(args)?;
            Ok(Decision::Confirm)
        }
        "client.open_url" if permissions.allow_web => {
            let url = web_url(
                args.get("url")
                    .and_then(Value::as_str)
                    .ok_or("Неверная ссылка")?,
            )?;
            if !local_host(&url)
                && permissions
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
    if p.shell {
        tools.push("client.shell_exec".into());
    }
    if p.files && !p.fs_roots.is_empty() {
        tools.extend(
            [
                "client.fs_list",
                "client.fs_read",
                "client.fs_search",
                "client.fs_write",
                "client.fs_mkdir",
                "client.fs_move",
            ]
            .map(String::from),
        );
    }
    // Only real backends are declared: no backend or no portal means no tool (§3b.7).
    if p.screen && crate::screen::screen_available() {
        tools.push("client.screenshot".into());
    }
    if p.input && crate::screen::input_available() {
        tools.push("client.input".into());
    }
    tools
}

/// Human-readable, exact description shown on the confirmation card.
pub fn preview(call: &ToolCall, permissions: &Permissions, data_root: &Path) -> String {
    let args = call.arguments.as_object();
    let get = |k: &str| {
        args.and_then(|a| a.get(k))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    match call.tool.as_str() {
        "client.shell_exec" => args
            .and_then(|a| {
                crate::shell::plan(
                    a,
                    &crate::files::Scope::new(&permissions.fs_roots, data_root),
                )
                .ok()
            })
            .map(|p| crate::shell::preview(&p))
            .unwrap_or_else(|| "Команда не прошла проверку".into()),
        "client.fs_write" => {
            let content = get("content");
            let head: String = content.chars().take(600).collect();
            let more = if content.chars().count() > 600 {
                "\n…"
            } else {
                ""
            };
            let mode = match get("mode").as_str() {
                "create" => "создать файл",
                "append" => "дописать в конец",
                _ => "перезаписать файл",
            };
            format!(
                "Запись: {mode}\nФайл: {}\nРазмер: {} байт\n---\n{head}{more}",
                get("path"),
                content.len()
            )
        }
        "client.fs_mkdir" => format!("Создать папку: {}", get("path")),
        "client.fs_move" => format!("Переместить:\n{}\n→ {}", get("from"), get("to")),
        "client.screenshot" => {
            let w = get("window");
            if w.is_empty() {
                "Снимок всего экрана (окна Neyra на время снимка скрываются)".into()
            } else {
                format!("Снимок окна {w}")
            }
        }
        "client.input" => args
            .and_then(|a| crate::screen::parse(a).ok())
            .map(|(_, steps)| crate::screen::preview(&steps))
            .unwrap_or_else(|| "Действия не прошли проверку".into()),
        "client.open_url" => format!("Открыть ссылку: {}", get("url")),
        "client.open_app" => format!("Запустить программу: {}", get("path")),
        "client.close_window" => format!("Закрыть окно {}", get("window")),
        _ => serde_json::to_string_pretty(&call.arguments).unwrap_or_default(),
    }
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
            "/home/me/.config/google-chrome/Default",
            "/home/me/.aws/credentials",
            "/home/me/.kube/config",
            "/home/me/.gnupg/pubring.kbx",
            "C:/Users/me/AppData/Local/Google/Chrome/User Data/Default",
            "C:/Users/me/AppData/Roaming/Mozilla/Firefox/Profiles/x.default",
        ] {
            assert!(secret_path(Path::new(p)), "{p}");
        }
    }

    #[test]
    fn browser_binaries_are_not_secret_paths() {
        for p in [
            "/opt/google/chrome/chrome",
            "/usr/lib/chromium/chromium",
            "C:/Program Files/Google/Chrome/Application/chrome.exe",
            "C:/Program Files/Chromium/Application/chrome.exe",
        ] {
            assert!(!secret_path(Path::new(p)), "{p}");
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
        let root = Path::new("/nonexistent-neyra");
        assert_eq!(
            validate(&call, &p, root, "d", "s", &mut seen).unwrap(),
            Decision::Safe
        );
        assert!(validate(&call, &p, root, "d", "s", &mut seen).is_err());
    }

    fn call(tool: &str, arguments: Value) -> ToolCall {
        ToolCall {
            call_id: uuid::Uuid::new_v4().to_string(),
            device_id: "d".into(),
            session_id: "s".into(),
            tool: tool.into(),
            arguments,
            deadline_ms: now_ms() + 10000,
        }
    }
    fn check(p: &Permissions, root: &Path, c: &ToolCall) -> Result<Decision, String> {
        validate(c, p, root, "d", "s", &mut HashMap::new())
    }

    #[test]
    fn powerful_contours_are_off_by_default_and_not_declared() {
        let p = Permissions {
            enabled: true,
            ..Default::default()
        };
        let caps = capabilities(&p);
        for tool in [
            "client.shell_exec",
            "client.fs_read",
            "client.fs_write",
            "client.screenshot",
            "client.input",
        ] {
            assert!(
                !caps.iter().any(|t| t == tool),
                "{tool} declared by default"
            );
        }
        let root = Path::new("/nonexistent-neyra");
        for c in [
            call("client.shell_exec", serde_json::json!({"program":"sh"})),
            call("client.fs_read", serde_json::json!({"path":"/tmp/x"})),
            call("client.screenshot", serde_json::json!({})),
            call(
                "client.input",
                serde_json::json!({"steps":[{"op":"key","keys":"enter"}]}),
            ),
        ] {
            assert!(check(&p, root, &c).is_err(), "{} allowed while off", c.tool);
        }
    }

    #[test]
    fn files_without_roots_are_not_declared() {
        let p = Permissions {
            enabled: true,
            files: true,
            ..Default::default()
        };
        assert!(!capabilities(&p).iter().any(|t| t.starts_with("client.fs_")));
    }

    #[test]
    fn dangerous_actions_always_need_a_card() {
        let base = std::fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("neyra-pol-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(base.join("work")).unwrap();
        std::fs::write(base.join("work/a.txt"), "a").unwrap();
        let p = Permissions {
            enabled: true,
            shell: true,
            files: true,
            screen: true,
            input: true,
            fs_roots: vec![base.join("work").to_string_lossy().into_owned()],
            ..Default::default()
        };
        let data = base.join("data");
        let w = |r: &str| base.join("work").join(r).to_string_lossy().into_owned();
        let confirm = [
            call(
                "client.shell_exec",
                serde_json::json!({"program":"sh","args":["-c","true"]}),
            ),
            call(
                "client.fs_write",
                serde_json::json!({"path":w("b.txt"),"content":"x","mode":"create"}),
            ),
            call("client.fs_mkdir", serde_json::json!({"path":w("d")})),
            call(
                "client.fs_move",
                serde_json::json!({"from":w("a.txt"),"to":w("c.txt")}),
            ),
            call("client.screenshot", serde_json::json!({})),
            call(
                "client.input",
                serde_json::json!({"steps":[{"op":"key","keys":"ctrl+s"}]}),
            ),
        ];
        for c in confirm {
            assert_eq!(check(&p, &data, &c), Ok(Decision::Confirm), "{}", c.tool);
        }
        assert_eq!(
            check(
                &p,
                &data,
                &call("client.fs_read", serde_json::json!({"path":w("a.txt")}))
            ),
            Ok(Decision::Safe)
        );
        let auto = Permissions {
            screen_auto: true,
            ..p.clone()
        };
        assert_eq!(
            check(
                &auto,
                &data,
                &call("client.screenshot", serde_json::json!({}))
            ),
            Ok(Decision::Safe)
        );
        // Unknown extra arguments are refused: the server cannot smuggle options.
        assert!(check(
            &p,
            &data,
            &call(
                "client.fs_read",
                serde_json::json!({"path":w("a.txt"),"follow":true})
            )
        )
        .is_err());
        assert!(check(
            &p,
            &data,
            &call("client.fs_read", serde_json::json!({"path":"/etc/passwd"}))
        )
        .is_err());
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn browser_rejects_unsafe_schemes_and_cards_local_hosts() {
        for u in [
            "data:text/html,<script>alert(1)</script>",
            "chrome://settings",
            "about:blank",
            "vbscript:msgbox",
            "ftp://example.com",
            "https://example.com/\nheader",
        ] {
            assert!(web_url(u).is_err(), "{u}");
        }
        let p = Permissions {
            enabled: true,
            allow_web: true,
            web_domains: vec![
                "localhost".into(),
                "router.lan".into(),
                "example.com".into(),
            ],
            ..Default::default()
        };
        let root = Path::new("/nonexistent-neyra");
        for u in [
            "http://localhost:8080/",
            "http://router.lan/",
            "http://192.168.1.1/",
            "http://[::1]/",
        ] {
            let c = call("client.open_url", serde_json::json!({"url":u}));
            assert_eq!(check(&p, root, &c), Ok(Decision::Confirm), "{u}");
        }
        let c = call(
            "client.open_url",
            serde_json::json!({"url":"https://example.com/a"}),
        );
        assert_eq!(check(&p, root, &c), Ok(Decision::Safe));
    }
}
