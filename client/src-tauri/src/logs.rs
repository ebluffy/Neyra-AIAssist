use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

pub(crate) const MAX_BYTES: u64 = 256 * 1024;
pub(crate) const KEEP: usize = 3;

/// Small local client log with rotation. Callers pass event codes and file names only: no tokens, arguments or output.
pub fn log(root: &Path, level: &str, message: &str) {
    let dir = root.join("logs");
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join("client.log");
    rotate(&path, |n| path.with_extension(format!("log.{n}")));
    let clean: String = message
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(300)
        .collect();
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "{} {} {}", crate::policy::now_ms(), level, clean);
    }
}

pub(crate) fn rotate(path: &Path, rotated: impl Fn(usize) -> PathBuf) -> bool {
    if fs::metadata(path).map(|m| m.len()).unwrap_or(0) < MAX_BYTES {
        return true;
    }
    let _ = fs::remove_file(rotated(KEEP));
    for n in (1..KEEP).rev() {
        let _ = fs::rename(rotated(n), rotated(n + 1));
    }
    fs::rename(path, rotated(1)).is_ok()
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

    #[test]
    fn shared_rotation_preserves_order_and_custom_names() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        let path = root.join("perf.jsonl");
        let rotated = |n| root.join(format!("perf.jsonl.{n}"));
        fs::write(&path, vec![b'x'; MAX_BYTES as usize - 1]).unwrap();
        for n in 1..=KEEP {
            fs::write(rotated(n), n.to_string()).unwrap();
        }

        assert!(rotate(&path, rotated));
        assert!(path.exists());
        assert_eq!(fs::read_to_string(rotated(1)).unwrap(), "1");

        fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"x")
            .unwrap();
        assert!(rotate(&path, rotated));
        assert!(!path.exists());
        assert_eq!(fs::metadata(rotated(1)).unwrap().len(), MAX_BYTES);
        assert_eq!(fs::read_to_string(rotated(2)).unwrap(), "1");
        assert_eq!(fs::read_to_string(rotated(3)).unwrap(), "2");
        assert_eq!(fs::read_dir(&root).unwrap().count(), KEEP);

        fs::write(&path, vec![b'x'; MAX_BYTES as usize]).unwrap();
        assert!(!rotate(&path, |_| root.join("missing-parent/perf.jsonl.1")));
        assert_eq!(fs::metadata(&path).unwrap().len(), MAX_BYTES);
        fs::remove_dir_all(root).unwrap();
    }
}
