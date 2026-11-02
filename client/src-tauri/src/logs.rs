use std::{fs, io::Write, path::Path};

const MAX_BYTES: u64 = 256 * 1024;
const KEEP: usize = 3;

/// Never persist panic payloads: even an unlabelled or not-yet-stored token may be in them.
pub fn crash(root: &Path) {
    if fs::create_dir_all(root.join("logs")).is_err() {
        return;
    }
    let _ = crate::storage::atomic_write(&root.join("logs/crash.log"), b"client_panic\n");
}

pub fn install_crash_hook(root: std::path::PathBuf) {
    std::panic::set_hook(Box::new(move |_| crash(&root)));
}

/// Small local client log with rotation. Callers pass event codes and file names only: no tokens, arguments or output.
pub fn log(root: &Path, level: &str, message: &str) {
    let dir = root.join("logs");
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join("client.log");
    rotate(&path);
    let clean: String = crate::redact::redact(message)
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(300)
        .collect();
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(
            file,
            "{} {} {}",
            crate::policy::now_ms(),
            crate::redact::redact(level),
            clean
        );
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
    fn crash_hook_child() {
        let Some(root) = std::env::var_os("NEYRA_TEST_CRASH_ROOT") else {
            return;
        };
        install_crash_hook(root.into());
        panic!("unlabelled secret: crash-only-token-49");
    }

    #[test]
    fn crash_hook_does_not_write_panic_payload() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "logs::tests::crash_hook_child", "--nocapture"])
            .env("NEYRA_TEST_CRASH_ROOT", &root)
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(!String::from_utf8_lossy(&output.stderr).contains("crash-only-token-49"));
        assert!(!String::from_utf8_lossy(&output.stdout).contains("crash-only-token-49"));
        assert_eq!(
            fs::read(root.join("logs/crash.log")).unwrap(),
            b"client_panic\n"
        );
        fs::remove_dir_all(root).unwrap();
    }

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
