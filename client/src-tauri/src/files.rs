use crate::policy::secret_path;
use crate::redact::{bounded_text, redact};
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

pub const READ_LIMIT: usize = 48 * 1024;
pub const WRITE_LIMIT: usize = 256 * 1024;
const LIST_LIMIT: usize = 200;
const SEARCH_VISITS: usize = 5000;
const SEARCH_RESULTS: usize = 50;
const SEARCH_DEPTH: usize = 8;
const SEARCH_FILE_LIMIT: u64 = 1024 * 1024;
const SEARCH_TIME: Duration = Duration::from_secs(5);

/// Canonical allowed roots plus subtrees that stay closed even inside a root
/// (the Neyra data folder: settings, permissions and audit must not be model-writable).
pub struct Scope {
    roots: Vec<PathBuf>,
    deny: Vec<PathBuf>,
}

impl Scope {
    pub fn new(roots: &[String], data_root: &Path) -> Self {
        let roots = roots
            .iter()
            .filter_map(|r| fs::canonicalize(r).ok())
            .filter(|r| r.is_dir())
            .collect();
        let mut deny = vec![data_root.to_path_buf()];
        if let Ok(real) = fs::canonicalize(data_root) {
            deny.push(real);
        }
        Self { roots, deny }
    }

    pub fn first_root(&self) -> Option<&Path> {
        self.roots.first().map(PathBuf::as_path)
    }

    fn allowed(&self, real: &Path) -> Result<(), String> {
        if secret_path(real) {
            return Err("Доступ к секретам запрещён".into());
        }
        if self.deny.iter().any(|d| real.starts_with(d)) {
            return Err("Служебная папка Neyra закрыта для инструментов".into());
        }
        if !self.roots.iter().any(|r| real.starts_with(r)) {
            return Err("Путь вне разрешённых папок".into());
        }
        Ok(())
    }

    /// Existing path with every symlink/junction resolved; both the requested
    /// and the real path must pass the deny-list.
    pub fn existing(&self, raw: &str) -> Result<PathBuf, String> {
        let lexical = checked_raw(raw)?;
        let real = fs::canonicalize(&lexical).map_err(|_| "Путь не найден")?;
        self.allowed(&real)?;
        Ok(real)
    }

    /// The directory entry itself (final component not followed): canonical parent + name.
    pub fn entry(&self, raw: &str) -> Result<PathBuf, String> {
        let lexical = checked_raw(raw)?;
        let name = plain_name(&lexical)?;
        let parent = lexical.parent().ok_or("Неверный путь")?;
        let real_parent = fs::canonicalize(parent).map_err(|_| "Папка не найдена")?;
        let path = real_parent.join(name);
        self.allowed(&path)?;
        Ok(path)
    }

    /// A path that must not exist yet, inside a resolved parent.
    pub fn fresh(&self, raw: &str) -> Result<PathBuf, String> {
        let path = self.entry(raw)?;
        if fs::symlink_metadata(&path).is_ok() {
            return Err("Такой путь уже существует".into());
        }
        Ok(path)
    }

    fn is_protected_container(&self, path: &Path) -> bool {
        self.roots.iter().any(|r| r.starts_with(path))
            || self.deny.iter().any(|d| d.starts_with(path))
    }
}

fn checked_raw(raw: &str) -> Result<PathBuf, String> {
    if raw.is_empty() || raw.len() > 4096 || raw.contains('\0') {
        return Err("Неверный путь".into());
    }
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err("Нужен абсолютный путь".into());
    }
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("Путь не должен содержать ..".into());
    }
    if secret_path(&path) {
        return Err("Доступ к секретам запрещён".into());
    }
    Ok(path)
}

fn plain_name(path: &Path) -> Result<&std::ffi::OsStr, String> {
    let name = match path.components().next_back() {
        Some(Component::Normal(name)) => name,
        _ => return Err("Неверное имя".into()),
    };
    let text = name.to_string_lossy();
    if text.len() > 255 || text.trim().is_empty() {
        return Err("Неверное имя".into());
    }
    if cfg!(windows) {
        let stem = text.split('.').next().unwrap_or("").to_ascii_uppercase();
        let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || ((stem.starts_with("COM") || stem.starts_with("LPT"))
                && stem.len() == 4
                && stem.as_bytes()[3].is_ascii_digit());
        if reserved || text.contains(':') || text.ends_with(['.', ' ']) {
            return Err("Неверное имя файла для Windows".into());
        }
    }
    Ok(name)
}

/// User-chosen root: an existing folder in the user's own space, never a system or secret area.
pub fn validate_root(raw: &str, data_root: &Path) -> Result<PathBuf, String> {
    let lexical = checked_raw(raw)?;
    let real = fs::canonicalize(&lexical).map_err(|_| "Папка не найдена")?;
    if !real.is_dir() {
        return Err("Нужна папка".into());
    }
    if real.parent().is_none() || secret_path(&real) {
        return Err("Эту папку нельзя разрешить".into());
    }
    let inside_data = [
        data_root.to_path_buf(),
        fs::canonicalize(data_root).unwrap_or_default(),
    ]
    .iter()
    .any(|d| !d.as_os_str().is_empty() && real.starts_with(d));
    if inside_data {
        return Err("Служебную папку Neyra нельзя разрешить".into());
    }
    let user_space = user_spaces().iter().any(|base| real.starts_with(base));
    if !user_space {
        return Err("Разрешены только папки пользователя и съёмные диски".into());
    }
    Ok(real)
}

fn user_spaces() -> Vec<PathBuf> {
    let mut bases: Vec<PathBuf> = dirs::home_dir().into_iter().collect();
    if cfg!(target_os = "linux") {
        bases.extend(["/media", "/mnt", "/run/media"].map(PathBuf::from));
    }
    if cfg!(windows) {
        // Other drive letters are user data drives; the system drive is limited to the profile.
        let system = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
        for letter in b'D'..=b'Z' {
            let drive = format!("{}:\\", letter as char);
            if !drive.eq_ignore_ascii_case(&format!("{system}\\")) {
                bases.push(PathBuf::from(&drive));
            }
        }
    }
    bases
        .into_iter()
        .filter_map(|b| fs::canonicalize(&b).ok())
        .collect()
}

fn reject_hardlinked(meta: &fs::Metadata) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.is_file() && meta.nlink() > 1 {
            return Err("Файлы с жёсткими ссылками закрыты для инструментов".into());
        }
    }
    let _ = meta;
    Ok(())
}

fn open_nofollow(path: &Path, options: &mut fs::OpenOptions) -> Result<fs::File, String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    options.open(path).map_err(|_| "Файл недоступен".into())
}

fn kind(meta: &fs::Metadata) -> &'static str {
    if meta.file_type().is_symlink() {
        "link"
    } else if meta.is_dir() {
        "dir"
    } else if meta.is_file() {
        "file"
    } else {
        "other"
    }
}

pub fn list(scope: &Scope, raw: &str) -> Result<Value, String> {
    let dir = scope.existing(raw)?;
    if !dir.is_dir() {
        return Err("Нужна папка".into());
    }
    let mut rows = Vec::new();
    let mut hidden = 0usize;
    let mut total = 0usize;
    for entry in fs::read_dir(&dir)
        .map_err(|_| "Папка недоступна")?
        .flatten()
    {
        total += 1;
        if total > 10_000 {
            break;
        }
        let path = entry.path();
        if secret_path(&path) || scope.allowed(&path).is_err() {
            hidden += 1;
            continue;
        }
        if rows.len() >= LIST_LIMIT {
            continue;
        }
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        rows.push(json!({
            "name": redact(&entry.file_name().to_string_lossy()),
            "kind": kind(&meta),
            "size": if meta.is_file() { meta.len() } else { 0 },
        }));
    }
    rows.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    Ok(json!({
        "status": "ok",
        "path": dir.to_string_lossy(),
        "entries": rows,
        "truncated": total > LIST_LIMIT + hidden,
        "hidden": hidden,
    }))
}

fn looks_binary(sample: &[u8]) -> bool {
    sample.contains(&0)
}

pub fn read(scope: &Scope, raw: &str, offset: u64, max_bytes: usize) -> Result<Value, String> {
    let path = scope.existing(raw)?;
    let meta = fs::metadata(&path).map_err(|_| "Файл недоступен")?;
    if !meta.is_file() {
        return Err("Нужен обычный файл".into());
    }
    reject_hardlinked(&meta)?;
    let limit = max_bytes.clamp(1, READ_LIMIT);
    let mut file = open_nofollow(&path, fs::OpenOptions::new().read(true))?;
    file.seek(SeekFrom::Start(offset.min(meta.len())))
        .map_err(|_| "Файл недоступен")?;
    let mut buffer = Vec::with_capacity(limit + 1);
    file.take(limit as u64 + 1)
        .read_to_end(&mut buffer)
        .map_err(|_| "Файл недоступен")?;
    if looks_binary(&buffer[..buffer.len().min(8192)]) {
        return Err("Двоичный файл не читается как текст".into());
    }
    let (text, truncated) = bounded_text(&buffer, limit);
    Ok(json!({
        "status": "ok",
        "path": path.to_string_lossy(),
        "size": meta.len(),
        "offset": offset.min(meta.len()),
        "text": text,
        "truncated": truncated,
    }))
}

pub fn search(
    scope: &Scope,
    raw: &str,
    name: Option<&str>,
    content: Option<&str>,
    cancel: &AtomicBool,
) -> Result<Value, String> {
    let start = scope.existing(raw)?;
    if !start.is_dir() {
        return Err("Нужна папка".into());
    }
    let name = name.map(str::to_lowercase).filter(|s| !s.is_empty());
    let content = content.filter(|s| !s.is_empty());
    if name.is_none() && content.is_none() {
        return Err("Укажите имя или текст для поиска".into());
    }
    let started = Instant::now();
    let mut stack = vec![(start, 0usize)];
    let mut visits = 0usize;
    let mut results = Vec::new();
    let mut complete = true;
    'walk: while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            visits += 1;
            if cancel.load(Ordering::SeqCst) {
                return Err("Действие остановлено".into());
            }
            if visits > SEARCH_VISITS
                || started.elapsed() > SEARCH_TIME
                || results.len() >= SEARCH_RESULTS
            {
                complete = false;
                break 'walk;
            }
            let path = entry.path();
            // Never follow links while walking; deny-listed subtrees are skipped entirely.
            let Ok(meta) = fs::symlink_metadata(&path) else {
                continue;
            };
            if scope.allowed(&path).is_err() {
                continue;
            }
            if meta.is_dir() && depth + 1 < SEARCH_DEPTH {
                stack.push((path.clone(), depth + 1));
            }
            let file_name = entry.file_name().to_string_lossy().to_lowercase();
            if name
                .as_ref()
                .is_some_and(|n| !file_name.contains(n.as_str()))
            {
                continue;
            }
            match content {
                None => results.push(json!({"path": path.to_string_lossy(), "kind": kind(&meta)})),
                Some(needle) if meta.is_file() && meta.len() <= SEARCH_FILE_LIMIT => {
                    if let Some((line, snippet)) = find_in_file(&path, &meta, needle) {
                        results.push(json!({"path": path.to_string_lossy(), "line": line, "snippet": snippet}));
                    }
                }
                Some(_) => {}
            }
        }
    }
    Ok(json!({"status": "ok", "results": results, "complete": complete}))
}

fn find_in_file(path: &Path, meta: &fs::Metadata, needle: &str) -> Option<(usize, String)> {
    reject_hardlinked(meta).ok()?;
    let mut bytes = Vec::new();
    open_nofollow(path, fs::OpenOptions::new().read(true))
        .ok()?
        .take(SEARCH_FILE_LIMIT)
        .read_to_end(&mut bytes)
        .ok()?;
    if looks_binary(&bytes[..bytes.len().min(8192)]) {
        return None;
    }
    let text = String::from_utf8_lossy(&bytes);
    let lowered = needle.to_lowercase();
    text.lines().enumerate().find_map(|(i, line)| {
        line.to_lowercase().contains(&lowered).then(|| {
            let snippet: String = line.chars().take(200).collect();
            (i + 1, redact(&snippet))
        })
    })
}

pub fn write(scope: &Scope, raw: &str, content: &str, mode: &str) -> Result<Value, String> {
    if content.len() > WRITE_LIMIT {
        return Err("Слишком большой текст для записи".into());
    }
    let mut options = fs::OpenOptions::new();
    let path = match mode {
        "create" => {
            options.write(true).create_new(true);
            scope.fresh(raw)?
        }
        "overwrite" | "append" => {
            let path = scope.entry(raw)?;
            let meta = fs::symlink_metadata(&path).map_err(|_| "Файл не найден")?;
            if !meta.file_type().is_file() {
                return Err("Запись возможна только в обычный файл".into());
            }
            reject_hardlinked(&meta)?;
            if mode == "append" {
                options.append(true);
            } else {
                options.write(true).truncate(true);
            }
            path
        }
        _ => return Err("Неизвестный режим записи".into()),
    };
    let mut file = open_nofollow(&path, &mut options)?;
    file.write_all(content.as_bytes())
        .and_then(|_| file.flush())
        .map_err(|_| "Не удалось записать файл")?;
    Ok(json!({"status": "ok", "path": path.to_string_lossy(), "bytes": content.len()}))
}

pub fn make_dir(scope: &Scope, raw: &str) -> Result<Value, String> {
    let path = scope.fresh(raw)?;
    fs::create_dir(&path).map_err(|_| "Не удалось создать папку")?;
    Ok(json!({"status": "ok", "path": path.to_string_lossy()}))
}

pub fn move_entry(scope: &Scope, from: &str, to: &str) -> Result<Value, String> {
    let source = scope.entry(from)?;
    fs::symlink_metadata(&source).map_err(|_| "Исходный путь не найден")?;
    if scope.is_protected_container(&source) {
        return Err("Нельзя перемещать разрешённую или служебную папку".into());
    }
    let target = scope.fresh(to)?;
    if target.starts_with(&source) {
        return Err("Нельзя переместить папку внутрь себя".into());
    }
    fs::rename(&source, &target)
        .map_err(|_| "Не удалось переместить (другой диск или нет доступа)")?;
    Ok(json!({"status": "ok", "from": source.to_string_lossy(), "to": target.to_string_lossy()}))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Sandbox {
        base: PathBuf,
        root: PathBuf,
        data: PathBuf,
    }
    impl Sandbox {
        fn new() -> Self {
            let base = fs::canonicalize(std::env::temp_dir())
                .unwrap()
                .join(format!("neyra-fs-{}", uuid::Uuid::new_v4()));
            let root = base.join("work");
            let data = root.join("Neyra");
            fs::create_dir_all(data.join("settings")).unwrap();
            fs::write(data.join("settings/app.json"), "{}").unwrap();
            fs::create_dir_all(base.join("outside")).unwrap();
            fs::write(base.join("outside/secret.txt"), "outside").unwrap();
            let marker = format!("{}{}", "abcdef", "123456");
            fs::write(root.join("note.txt"), format!("hello\nAPI_KEY={marker}\n")).unwrap();
            Self { base, root, data }
        }
        fn scope(&self) -> Scope {
            Scope::new(&[self.root.to_string_lossy().into_owned()], &self.data)
        }
        fn p(&self, rel: &str) -> String {
            self.root.join(rel).to_string_lossy().into_owned()
        }
    }
    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    #[test]
    fn read_inside_root_is_redacted() {
        let s = Sandbox::new();
        let out = read(&s.scope(), &s.p("note.txt"), 0, 1024).unwrap();
        let text = out["text"].as_str().unwrap();
        assert!(text.contains("hello"));
        let marker = format!("{}{}", "abcdef", "123456");
        assert!(!text.contains(&marker));
    }

    #[test]
    fn traversal_and_relative_paths_are_rejected() {
        let s = Sandbox::new();
        let scope = s.scope();
        let escape = format!("{}/../outside/secret.txt", s.root.to_string_lossy());
        assert!(read(&scope, &escape, 0, 100).is_err());
        assert!(read(&scope, "note.txt", 0, 100).is_err());
        assert!(read(
            &scope,
            &s.base.join("outside/secret.txt").to_string_lossy(),
            0,
            100
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escape_and_symlink_to_secret_are_rejected() {
        let s = Sandbox::new();
        let scope = s.scope();
        std::os::unix::fs::symlink(s.base.join("outside"), s.root.join("link")).unwrap();
        assert!(read(&scope, &s.p("link/secret.txt"), 0, 100).is_err());
        fs::create_dir_all(s.base.join("outside/.ssh")).unwrap();
        fs::write(s.base.join("outside/.ssh/id_ed25519"), "key").unwrap();
        std::os::unix::fs::symlink(
            s.base.join("outside/.ssh/id_ed25519"),
            s.root.join("innocent.txt"),
        )
        .unwrap();
        assert!(read(&scope, &s.p("innocent.txt"), 0, 100).is_err());
        // Writing through a symlink is refused even when the target is inside the root.
        std::os::unix::fs::symlink(s.root.join("note.txt"), s.root.join("alias.txt")).unwrap();
        assert!(write(&scope, &s.p("alias.txt"), "x", "overwrite").is_err());
        assert_eq!(
            fs::read_to_string(s.root.join("note.txt"))
                .unwrap()
                .lines()
                .next(),
            Some("hello")
        );
    }

    #[cfg(unix)]
    #[test]
    fn hardlinked_files_are_refused() {
        let s = Sandbox::new();
        fs::hard_link(s.base.join("outside/secret.txt"), s.root.join("hard.txt")).unwrap();
        assert!(read(&s.scope(), &s.p("hard.txt"), 0, 100).is_err());
        assert!(write(&s.scope(), &s.p("hard.txt"), "x", "overwrite").is_err());
    }

    #[test]
    fn neyra_data_folder_is_closed_even_inside_root() {
        let s = Sandbox::new();
        let scope = s.scope();
        assert!(read(&scope, &s.p("Neyra/settings/app.json"), 0, 100).is_err());
        assert!(write(
            &scope,
            &s.p("Neyra/settings/app.json"),
            "{\"permissions\":{}}",
            "overwrite"
        )
        .is_err());
        assert!(move_entry(&scope, &s.p("Neyra"), &s.p("moved")).is_err());
        let listed = list(&scope, &s.root.to_string_lossy()).unwrap();
        assert!(!listed.to_string().contains("\"Neyra\""));
    }

    #[test]
    fn secret_names_are_rejected_inside_root() {
        let s = Sandbox::new();
        fs::write(s.root.join(".env"), "TOKEN=x").unwrap();
        let scope = s.scope();
        assert!(read(&scope, &s.p(".env"), 0, 100).is_err());
        assert!(write(&scope, &s.p("id.pem"), "x", "create").is_err());
        let found = search(
            &scope,
            &s.root.to_string_lossy(),
            Some("env"),
            None,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert!(found["results"].as_array().unwrap().is_empty());
    }

    #[test]
    fn write_modes_and_limits() {
        let s = Sandbox::new();
        let scope = s.scope();
        write(&scope, &s.p("new.txt"), "a", "create").unwrap();
        assert!(write(&scope, &s.p("new.txt"), "b", "create").is_err());
        write(&scope, &s.p("new.txt"), "b", "append").unwrap();
        assert_eq!(fs::read_to_string(s.root.join("new.txt")).unwrap(), "ab");
        assert!(write(&scope, &s.p("missing.txt"), "x", "overwrite").is_err());
        assert!(write(
            &scope,
            &s.p("big.txt"),
            &"x".repeat(WRITE_LIMIT + 1),
            "create"
        )
        .is_err());
        assert!(write(&scope, &s.p("x.txt"), "x", "delete").is_err());
    }

    #[test]
    fn binary_files_are_not_returned() {
        let s = Sandbox::new();
        fs::write(s.root.join("blob.bin"), [0u8, 1, 2, 3]).unwrap();
        assert!(read(&s.scope(), &s.p("blob.bin"), 0, 100).is_err());
    }

    #[test]
    fn move_rules() {
        let s = Sandbox::new();
        let scope = s.scope();
        fs::create_dir_all(s.root.join("dir/sub")).unwrap();
        assert!(move_entry(&scope, &s.p("dir"), &s.p("dir/sub/inner")).is_err());
        assert!(move_entry(
            &scope,
            &s.p("note.txt"),
            &s.base.join("outside/note.txt").to_string_lossy()
        )
        .is_err());
        assert!(move_entry(
            &scope,
            &s.root.to_string_lossy(),
            &s.base.join("x").to_string_lossy()
        )
        .is_err());
        move_entry(&scope, &s.p("note.txt"), &s.p("dir/note.txt")).unwrap();
        assert!(s.root.join("dir/note.txt").exists());
    }

    #[test]
    fn search_is_bounded_and_finds_content() {
        let s = Sandbox::new();
        let scope = s.scope();
        let out = search(
            &scope,
            &s.root.to_string_lossy(),
            None,
            Some("HELLO"),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(out["results"][0]["line"], 1);
        let stopped = search(
            &scope,
            &s.root.to_string_lossy(),
            Some("note"),
            None,
            &AtomicBool::new(true),
        );
        assert!(stopped.is_err());
    }

    #[test]
    fn root_validation_rejects_system_and_data_folders() {
        let s = Sandbox::new();
        assert!(validate_root("/", &s.data).is_err());
        assert!(validate_root("relative", &s.data).is_err());
        assert!(validate_root(&s.data.to_string_lossy(), &s.data).is_err());
        if cfg!(target_os = "linux") {
            assert!(validate_root("/etc", &s.data).is_err());
        }
        if let Some(home) = dirs::home_dir() {
            if home.join(".ssh").is_dir() {
                assert!(validate_root(&home.join(".ssh").to_string_lossy(), &s.data).is_err());
            }
        }
    }
}
