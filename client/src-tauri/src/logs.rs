use std::{fs, io::Write, path::Path};

const MAX_BYTES: u64 = 256 * 1024;
const KEEP: usize = 3;

/// Never persist panic payloads: even an unlabelled or not-yet-stored token may be in them.
pub fn crash(root: &Path, location: &str) {
    if fs::create_dir_all(root.join("logs")).is_err() {
        return;
    }
    let path = root.join("logs/crash.log");
    rotate(&path);
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(
            file,
            "{} client_panic {}",
            crate::policy::now_ms(),
            crate::redact::redact(location)
        );
    }
}

pub fn install_crash_hook(root: std::path::PathBuf) {
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|location| format!("{}:{}", location.file(), location.line()));
        crash(&root, location.as_deref().unwrap_or("unknown"));
    }));
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

    fn assert_no_tokens(root: &Path, tokens: &[String]) {
        for entry in fs::read_dir(root).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                assert_no_tokens(&path, tokens);
                continue;
            }
            let bytes = fs::read(&path).unwrap();
            for token in tokens {
                let quoted = serde_json::to_string(token).unwrap();
                for form in [token.as_str(), &quoted[1..quoted.len() - 1]] {
                    assert!(
                        !bytes
                            .windows(form.len())
                            .any(|window| window == form.as_bytes()),
                        "token leaked into {}",
                        path.display()
                    );
                }
            }
        }
    }

    #[test]
    fn crash_hook_child() {
        let Some(root) = std::env::var_os("NEYRA_TEST_CRASH_ROOT") else {
            return;
        };
        install_crash_hook(root.into());
        let token = ["crash", "only", "token", "49"].join("-");
        panic!("unlabelled secret: {token}");
    }

    #[test]
    fn crash_hook_does_not_write_panic_payload() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let token = ["crash", "only", "token", "49"].join("-");
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "logs::tests::crash_hook_child", "--nocapture"])
            .env("NEYRA_TEST_CRASH_ROOT", &root)
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(!String::from_utf8_lossy(&output.stderr).contains(&token));
        assert!(!String::from_utf8_lossy(&output.stdout).contains(&token));
        let text = fs::read_to_string(root.join("logs/crash.log")).unwrap();
        assert_no_tokens(&root, &[token]);
        let fields: Vec<_> = text.split_whitespace().collect();
        assert_eq!(fields.len(), 3);
        assert!(fields[0].parse::<u64>().unwrap() > 0);
        assert_eq!(fields[1], "client_panic");
        let (file, line) = fields[2].rsplit_once(':').unwrap();
        assert!(file.ends_with("logs.rs"));
        assert!(line.parse::<u32>().unwrap() > 0);
        crash(&root, "test.rs:49");
        assert_eq!(
            fs::read_to_string(root.join("logs/crash.log"))
                .unwrap()
                .lines()
                .count(),
            2
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn log_writes_mask_bearer_and_registered_escaped_tokens() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let bearer = ["log", "unregistered", "49"].join("-");
        let mut token = ["log", "registered", "49"].join("-");
        token.push('"');
        token.push('\\');
        token.push('\n');
        token.push_str("tail");
        crate::redact::protect_token(&token);
        let json = serde_json::json!({"message": format!("Bearer {bearer}"), "value": token});
        log(&root, "info", &format!("Bearer {bearer}"));
        log(&root, "info", &json.to_string());
        log(&root, &token, &token);
        crash(&root, &format!("location {token}"));
        crash(&root, &json.to_string());
        let text = fs::read_to_string(root.join("logs/client.log")).unwrap();
        assert_eq!(text.lines().count(), 3);
        assert!(text.contains("info Bearer [REDACTED]"));
        assert!(text.contains("\"value\":\"[REDACTED]\""));
        assert!(text.contains("[REDACTED] [REDACTED]"));
        assert_no_tokens(&root, &[bearer, token]);
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
