use crate::files::{self, Scope};
#[cfg(not(windows))]
use crate::policy::available_program;
use crate::policy::{checked_file, child_environment, web_url, ToolCall};
use crate::storage::Permissions;
use serde_json::{json, Value};
use std::{
    path::Path,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

#[cfg(not(windows))]
fn bounded(mut command: Command, cancel: &AtomicBool) -> Result<String, String> {
    use std::{
        os::unix::process::CommandExt,
        time::{Duration, Instant},
    };
    command.process_group(0);
    child_environment(&mut command);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut process = command.spawn().map_err(|_| "Программа недоступна")?;
    let stdout = process.stdout.take().ok_or("Нет потока результата")?;
    let reader = std::thread::spawn(move || {
        use std::io::Read;
        let mut out = Vec::new();
        let _ = stdout.take(8192).read_to_end(&mut out);
        out
    });
    let started = Instant::now();
    loop {
        if cancel.load(Ordering::SeqCst) || started.elapsed() > Duration::from_secs(5) {
            // All descendants of an OS helper belong to this private process group.
            unsafe {
                libc::kill(-(process.id() as i32), libc::SIGKILL);
            }
            let _ = process.kill();
            let _ = process.wait();
            return Err("Действие остановлено".into());
        }
        if let Ok(Some(status)) = process.try_wait() {
            let out = reader.join().map_err(|_| "Ошибка результата")?;
            return if status.success() {
                Ok(String::from_utf8_lossy(&out).into())
            } else {
                Err("Команда ОС завершилась с ошибкой".into())
            };
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

pub fn execute(
    call: &ToolCall,
    cancel: Arc<AtomicBool>,
    permissions: &Permissions,
    data_root: &Path,
) -> Result<Value, String> {
    if cancel.load(Ordering::SeqCst) {
        return Err("Действие остановлено".into());
    }
    let arg = |key: &str| {
        call.arguments
            .get(key)
            .and_then(Value::as_str)
            .ok_or_else(|| "Неверный параметр".to_string())
    };
    let opt = |key: &str| call.arguments.get(key).and_then(Value::as_str);
    let scope = || Scope::new(&permissions.fs_roots, data_root);
    match call.tool.as_str() {
        "client.shell_exec" => {
            let args = call.arguments.as_object().ok_or("Неверные параметры")?;
            let plan = crate::shell::plan(args, &scope())?;
            crate::shell::run(&plan, &cancel)
        }
        "client.fs_list" => files::list(&scope(), arg("path")?),
        "client.fs_read" => files::read(
            &scope(),
            arg("path")?,
            call.arguments
                .get("offset")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            call.arguments
                .get("max_bytes")
                .and_then(Value::as_u64)
                .map_or(files::READ_LIMIT, |n| n as usize),
        ),
        "client.fs_search" => {
            files::search(&scope(), arg("path")?, opt("name"), opt("content"), &cancel)
        }
        "client.fs_write" => files::write(&scope(), arg("path")?, arg("content")?, arg("mode")?),
        "client.fs_mkdir" => files::make_dir(&scope(), arg("path")?),
        "client.fs_move" => files::move_entry(&scope(), arg("from")?, arg("to")?),
        "client.open_url" | "client.search_web" => {
            let url = if call.tool == "client.search_web" {
                let mut u = url::Url::parse("https://www.google.com/search")
                    .map_err(|_| "Неверный адрес поиска")?;
                u.query_pairs_mut().append_pair("q", arg("query")?);
                u
            } else {
                web_url(arg("url")?)?
            };
            open_url(url.as_str())?;
            Ok(json!({"status":"ok"}))
        }
        "client.open_app" => {
            let path = checked_file(arg("path")?)?;
            let mut command = Command::new(path);
            child_environment(&mut command);
            command
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            // Spawn a detached application, not an agent-owned shell tree. Stop cancels pending calls, not already opened apps.
            let mut child = command
                .spawn()
                .map_err(|_| "Приложение не удалось открыть")?;
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            Ok(json!({"status":"ok"}))
        }
        "client.list_apps" => Ok(
            json!({"status":"ok","applications":discover_apps().into_iter().take(40).collect::<Vec<_>>()}),
        ),
        "client.list_windows" => list_windows(&cancel),
        "client.close_window" => {
            close_window(arg("window")?, &cancel)?;
            Ok(json!({"status":"ok"}))
        }
        "client.focus_window" => {
            focus_window(arg("window")?, &cancel)?;
            Ok(json!({"status":"ok"}))
        }
        "client.media" | "client.volume" => {
            system_action(&call.tool, arg("action")?, &cancel)?;
            Ok(json!({"status":"ok"}))
        }
        _ => Err("Инструмент недоступен".into()),
    }
}
#[cfg(not(windows))]
fn open_url(url: &str) -> Result<(), String> {
    let opener = available_program("xdg-open").ok_or("xdg-open не установлен")?;
    let mut c = Command::new(opener);
    c.arg(url);
    child_environment(&mut c);
    let mut p = c
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Не удалось открыть браузер")?;
    std::thread::spawn(move || {
        let _ = p.wait();
    });
    Ok(())
}
#[cfg(windows)]
fn open_url(url: &str) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteW(
            hwnd: isize,
            op: *const u16,
            file: *const u16,
            param: *const u16,
            dir: *const u16,
            show: i32,
        ) -> isize;
    }
    let wide: Vec<u16> = std::ffi::OsStr::new(url)
        .encode_wide()
        .chain(Some(0))
        .collect();
    let result = unsafe {
        ShellExecuteW(
            0,
            std::ptr::null(),
            wide.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
        )
    };
    if result <= 32 {
        Err("Не удалось открыть браузер".into())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn list_windows(cancel: &AtomicBool) -> Result<Value, String> {
    if std::env::var("XDG_SESSION_TYPE").unwrap_or_default() == "wayland" {
        return Err("Окна Wayland пока недоступны".into());
    }
    let mut c = Command::new("wmctrl");
    c.arg("-l");
    let text = bounded(c, cancel)?;
    let items: Vec<_> = text
        .lines()
        .take(64)
        .filter_map(|line| {
            let parts: Vec<_> = line.split_whitespace().collect();
            if parts.len() < 4 {
                return None;
            }
            Some(json!({"id":parts[0],"title":parts[3..].join(" ")}))
        })
        .collect();
    Ok(json!({"status":"ok","windows":items}))
}
#[cfg(not(windows))]
fn focus_window(id: &str, cancel: &AtomicBool) -> Result<(), String> {
    if !id.starts_with("0x") || id.len() > 12 || u64::from_str_radix(&id[2..], 16).is_err() {
        return Err("Неверное окно".into());
    }
    let list = list_windows(cancel)?;
    if !list["windows"]
        .as_array()
        .is_some_and(|a| a.iter().any(|w| w["id"] == id))
    {
        return Err("Окно не найдено".into());
    }
    let mut c = Command::new("wmctrl");
    c.args(["-ia", id]);
    bounded(c, cancel)?;
    Ok(())
}
#[cfg(not(windows))]
fn system_action(tool: &str, action: &str, cancel: &AtomicBool) -> Result<(), String> {
    let mut c = if tool == "client.media" {
        let verb = match action {
            "play_pause" => "play-pause",
            "next" => "next",
            "previous" => "previous",
            _ => return Err("Неизвестное действие".into()),
        };
        let mut c = Command::new("playerctl");
        c.arg(verb);
        c
    } else {
        let mut c = Command::new("pactl");
        match action {
            "up" => {
                c.args(["set-sink-volume", "@DEFAULT_SINK@", "+5%"]);
            }
            "down" => {
                c.args(["set-sink-volume", "@DEFAULT_SINK@", "-5%"]);
            }
            "mute" => {
                c.args(["set-sink-mute", "@DEFAULT_SINK@", "toggle"]);
            }
            _ => return Err("Неизвестное действие".into()),
        };
        c
    };
    c.env("LC_ALL", "C");
    bounded(c, cancel)?;
    Ok(())
}

#[cfg(windows)]
mod win {
    use super::*;
    #[link(name = "user32")]
    extern "system" {
        fn EnumWindows(cb: extern "system" fn(isize, isize) -> i32, param: isize) -> i32;
        fn IsWindowVisible(w: isize) -> i32;
        fn GetWindowTextW(w: isize, text: *mut u16, max: i32) -> i32;
        fn SetForegroundWindow(w: isize) -> i32;
        fn ShowWindow(w: isize, cmd: i32) -> i32;
        fn GetForegroundWindow() -> isize;
        fn SendMessageTimeoutW(
            w: isize,
            msg: u32,
            wparam: usize,
            lparam: isize,
            flags: u32,
            timeout: u32,
            result: *mut usize,
        ) -> isize;
    }
    extern "system" fn collect(w: isize, param: isize) -> i32 {
        let mut buffer = [0u16; 256];
        let n = unsafe { GetWindowTextW(w, buffer.as_mut_ptr(), 256) };
        if n > 0 && unsafe { IsWindowVisible(w) } != 0 {
            let rows = unsafe { &mut *(param as *mut Vec<Value>) };
            if rows.len() < 64 {
                rows.push(json!({"id":w.to_string(),"title":String::from_utf16_lossy(&buffer[..n as usize])}));
            }
        }
        1
    }
    pub fn windows() -> Value {
        let mut rows = Vec::<Value>::new();
        unsafe { EnumWindows(collect, &mut rows as *mut _ as isize) };
        json!({"status":"ok","windows":rows})
    }
    pub fn focus(id: &str) -> Result<(), String> {
        if !windows()["windows"]
            .as_array()
            .is_some_and(|a| a.iter().any(|w| w["id"] == id))
        {
            return Err("Окно не найдено".into());
        }
        let w = id.parse::<isize>().map_err(|_| "Неверное окно")?;
        unsafe { ShowWindow(w, 9) };
        if unsafe { SetForegroundWindow(w) } == 0 {
            Err("ОС не разрешила сменить фокус".into())
        } else {
            Ok(())
        }
    }
    pub fn media(tool: &str, action: &str) -> Result<(), String> {
        let cmd = match (tool, action) {
            ("client.media", "play_pause") => 14,
            ("client.media", "next") => 11,
            ("client.media", "previous") => 12,
            ("client.volume", "up") => 10,
            ("client.volume", "down") => 9,
            ("client.volume", "mute") => 8,
            _ => return Err("Неизвестное действие".into()),
        };
        let mut result = 0usize;
        if unsafe {
            SendMessageTimeoutW(
                GetForegroundWindow(),
                0x0319,
                0,
                (cmd << 16) as isize,
                2,
                2000,
                &mut result,
            )
        } == 0
        {
            return Err("Окно не ответило".into());
        }
        Ok(())
    }
}
#[cfg(windows)]
fn list_windows(_: &AtomicBool) -> Result<Value, String> {
    Ok(win::windows())
}
#[cfg(windows)]
fn focus_window(id: &str, _: &AtomicBool) -> Result<(), String> {
    win::focus(id)
}
#[cfg(windows)]
fn system_action(tool: &str, action: &str, _: &AtomicBool) -> Result<(), String> {
    win::media(tool, action)
}

pub fn discover_apps() -> Vec<String> {
    let mut found = std::collections::HashSet::new();
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            if let Ok(entries) = std::fs::read_dir(dir) {
                for entry in entries.flatten().take(500) {
                    let path = entry.path();
                    if !path.is_file() {
                        continue;
                    }
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        if entry
                            .metadata()
                            .map(|m| m.permissions().mode() & 0o111 == 0)
                            .unwrap_or(true)
                        {
                            continue;
                        }
                    }
                    #[cfg(windows)]
                    {
                        if path
                            .extension()
                            .is_none_or(|e| e.to_string_lossy().to_lowercase() != "exe")
                        {
                            continue;
                        }
                    }
                    if let Ok(real) = path.canonicalize() {
                        if !crate::policy::secret_path(&real) {
                            found.insert(real.to_string_lossy().into_owned());
                        }
                    }
                }
            }
        }
    }
    discover_platform_apps(&mut found);
    let mut items: Vec<_> = found.into_iter().collect();
    items.sort();
    items.truncate(1000);
    items
}

#[cfg(not(windows))]
fn discover_platform_apps(found: &mut std::collections::HashSet<String>) {
    let mut dirs = vec![
        std::path::PathBuf::from("/usr/share/applications"),
        std::path::PathBuf::from("/usr/local/share/applications"),
    ];
    if let Some(data) = dirs::data_local_dir() {
        dirs.push(data.join("applications"));
    }
    for dir in dirs {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten().take(500) {
                if entry.path().extension().is_none_or(|e| e != "desktop") {
                    continue;
                }
                if let Ok(text) = std::fs::read_to_string(entry.path()) {
                    for line in text.lines().filter_map(|s| s.strip_prefix("Exec=")) {
                        if let Some(path) = desktop_executable(line) {
                            found.insert(path);
                        }
                    }
                }
            }
        }
    }
}
#[cfg(not(windows))]
fn desktop_executable(line: &str) -> Option<String> {
    let tokens = shlex::split(line)?;
    let first = tokens.first()?;
    if matches!(first.as_str(), "sh" | "bash" | "env") {
        return None;
    }
    let path = if std::path::Path::new(first).is_absolute() {
        std::path::PathBuf::from(first)
    } else {
        available_program(first)?
    };
    let path = path.canonicalize().ok()?;
    if !path.is_file() || crate::policy::secret_path(&path) {
        return None;
    }
    Some(path.to_string_lossy().into_owned())
}
#[cfg(windows)]
fn discover_platform_apps(found: &mut std::collections::HashSet<String>) {
    use winreg::{
        enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE},
        RegKey,
    };
    for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        let key = RegKey::predef(hive);
        if let Ok(apps) = key.open_subkey("SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths")
        {
            for name in apps.enum_keys().flatten().take(500) {
                if let Ok(app) = apps.open_subkey(name) {
                    if let Ok(value) = app.get_value::<String, _>("") {
                        let path = std::path::PathBuf::from(value.trim_matches('"'));
                        if path.is_file() && !crate::policy::secret_path(&path) {
                            found.insert(path.to_string_lossy().into_owned());
                        }
                    }
                }
            }
        }
    }
}

#[cfg(not(windows))]
pub fn session_unlocked() -> bool {
    let Ok(session) = std::env::var("XDG_SESSION_ID") else {
        return false;
    };
    if session.is_empty()
        || !session
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return false;
    }
    let mut command = Command::new("loginctl");
    command.args(["show-session", &session, "-p", "LockedHint", "--value"]);
    bounded(command, &AtomicBool::new(false)).is_ok_and(|s| s.trim() == "no")
}
#[cfg(windows)]
pub fn session_unlocked() -> bool {
    #[link(name = "user32")]
    extern "system" {
        fn OpenInputDesktop(flags: u32, inherit: i32, access: u32) -> isize;
        fn SwitchDesktop(desktop: isize) -> i32;
        fn CloseDesktop(desktop: isize) -> i32;
    }
    let desktop = unsafe { OpenInputDesktop(0, 0, 0x100) };
    if desktop == 0 {
        return false;
    }
    let unlocked = unsafe { SwitchDesktop(desktop) } != 0;
    unsafe { CloseDesktop(desktop) };
    unlocked
}

#[cfg(not(windows))]
fn close_window(id: &str, cancel: &AtomicBool) -> Result<(), String> {
    let list = list_windows(cancel)?;
    if !list["windows"]
        .as_array()
        .is_some_and(|a| a.iter().any(|w| w["id"] == id))
    {
        return Err("Окно не найдено".into());
    }
    let mut c = Command::new("wmctrl");
    c.args(["-ic", id]);
    bounded(c, cancel)?;
    Ok(())
}
#[cfg(windows)]
fn close_window(id: &str, _: &AtomicBool) -> Result<(), String> {
    #[link(name = "user32")]
    extern "system" {
        fn PostMessageW(w: isize, msg: u32, wparam: usize, lparam: isize) -> i32;
    }
    if !win::windows()["windows"]
        .as_array()
        .is_some_and(|a| a.iter().any(|w| w["id"] == id))
    {
        return Err("Окно не найдено".into());
    }
    let window = id.parse::<isize>().map_err(|_| "Неверное окно")?;
    if unsafe { PostMessageW(window, 0x0010, 0, 0) } == 0 {
        Err("ОС не разрешила закрыть окно".into())
    } else {
        Ok(())
    }
}
