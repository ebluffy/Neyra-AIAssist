use std::{fs, io::Write, path::Path};

const MAX_BYTES: u64 = 256 * 1024;
const KEEP: usize = 3;

/// Small local client log with rotation. Callers pass event codes and file names only: no tokens, arguments or output.
pub fn log(root: &Path, level: &str, message: &str) {
    let dir = root.join("logs");
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join("client.log");
    rotate(&path);
    let clean: String = message
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(300)
        .collect();
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "{} {} {}", crate::policy::now_ms(), level, clean);
    }
}

fn rotate(path: &Path) {
    if fs::metadata(path).map(|m| m.len()).unwrap_or(0) < MAX_BYTES {
        return;
    }
    let numbered = |n: usize| path.with_extension(format!("log.{n}"));
    let _ = fs::remove_file(numbered(KEEP));
    for n in (1..KEEP).rev() {
        let _ = fs::rename(numbered(n), numbered(n + 1));
    }
    let _ = fs::rename(path, numbered(1));
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rotates_and_keeps_a_bounded_history() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        for _ in 0..1200 {
            log(&root, "info", &"x".repeat(250));
        }
        let files = fs::read_dir(root.join("logs")).unwrap().count();
        assert!((2..=KEEP + 1).contains(&files), "{files}");
        log(&root, "warn", "line\nbreak");
        let text = fs::read_to_string(root.join("logs/client.log")).unwrap();
        assert!(text.lines().last().unwrap().ends_with("warn line break"));
        fs::remove_dir_all(root).unwrap();
    }
}
