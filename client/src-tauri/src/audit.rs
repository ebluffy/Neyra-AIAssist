use crate::{policy::now_ms, storage::atomic_write};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tauri::Manager;

const MAX_AUDIT_BYTES: u64 = 2 * 1024 * 1024;
const CORRUPT_MAX_FILES: usize = 8;
const CORRUPT_MAX_BYTES: u64 = 8 * 1024 * 1024;
const CORRUPT_MAX_AGE_DAYS: u32 = 30;

pub fn start_pruning(
    app: tauri::AppHandle,
    root: std::path::PathBuf,
    initial_days: u32,
) -> std::io::Result<()> {
    if let Err(error) = prune_on_start(&root, initial_days) {
        crate::logs::log(
            &root,
            "warn",
            &format!("audit startup prune failed: {error}"),
        );
    }
    std::thread::Builder::new()
        .name("audit-prune".into())
        .spawn(move || {
            pruning_loop(Duration::from_secs(24 * 60 * 60), None, || {
                prune_tick(&app, &root, initial_days);
            })
        })?;
    Ok(())
}

fn pruning_loop<F>(period: Duration, ticks: Option<usize>, mut tick: F)
where
    F: FnMut(),
{
    let mut completed = 0;
    loop {
        std::thread::sleep(period);
        tick();
        completed += 1;
        if ticks.is_some_and(|limit| completed >= limit) {
            return;
        }
    }
}

fn prune_tick(app: &tauri::AppHandle, root: &Path, initial_days: u32) {
    let Some(state) = app.try_state::<crate::Desktop>() else {
        crate::logs::log(
            root,
            "warn",
            "periodic audit prune skipped: state unavailable",
        );
        return;
    };
    prune_tick_with(root, &state.audit_lock, &state.settings, initial_days);
}

fn prune_tick_with(
    root: &Path,
    audit_lock: &std::sync::Mutex<()>,
    settings: &std::sync::Mutex<crate::storage::Settings>,
    initial_days: u32,
) {
    let _guard = match audit_lock.lock() {
        Ok(guard) => guard,
        Err(_) => {
            crate::logs::log(
                root,
                "warn",
                "periodic audit prune skipped: audit lock poisoned",
            );
            return;
        }
    };
    let days = match settings.lock() {
        Ok(settings) => settings.audit_days,
        Err(_) => {
            crate::logs::log(
                root,
                "warn",
                "periodic audit prune skipped: settings lock poisoned",
            );
            initial_days
        }
    };
    prune_tick_for_root(root, days);
}

fn preserve_corrupt(path: &Path, root: &Path, reason: &str) -> Result<(), String> {
    let mut corrupt = path.with_file_name("actions.json.corrupt");
    if corrupt.exists() {
        corrupt = path.with_file_name(format!("actions.json.{}.corrupt", now_ms()));
    }
    std::fs::rename(path, &corrupt)
        .map_err(|e| format!("Не удалось сохранить повреждённый журнал: {e}"))?;
    crate::logs::log(
        root,
        "warn",
        &format!("corrupt audit journal moved aside: category={reason}"),
    );
    Ok(())
}

fn cleanup_corrupt(root: &Path, days: u32) {
    let audit_dir = root.join("audit");
    let now = now_ms();
    let max_age = u64::from(days.clamp(1, 365).min(CORRUPT_MAX_AGE_DAYS)) * 24 * 60 * 60 * 1000;
    let entries = match std::fs::read_dir(&audit_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(_) => {
            crate::logs::log(
                root,
                "warn",
                "audit corrupt cleanup failed: category=read_dir",
            );
            return;
        }
    };
    let mut scan_errors = 0;
    let mut remove_errors = 0;
    let mut files: Vec<(PathBuf, u64, u64)> = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                scan_errors += 1;
                continue;
            }
        };
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !(name == "actions.json.corrupt"
            || (name.starts_with("actions.json.") && name.ends_with(".corrupt")))
        {
            continue;
        }
        let info = entry.metadata().and_then(|metadata| {
            let modified = metadata.modified()?;
            Ok((metadata.len(), modified))
        });
        match info {
            Ok((size, modified)) => {
                let modified = modified
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                files.push((path, modified, size));
            }
            Err(_) => scan_errors += 1,
        }
    }
    files.sort_by_key(|(_, modified, _)| *modified);
    let mut total = files.iter().map(|(_, _, size)| *size).sum::<u64>();
    for (index, (path, modified, size)) in files.iter().enumerate() {
        let expired = now.saturating_sub(*modified) > max_age;
        let over_count = files.len().saturating_sub(index) > CORRUPT_MAX_FILES;
        let over_size = total > CORRUPT_MAX_BYTES;
        if expired || over_count || over_size {
            match std::fs::remove_file(path) {
                Ok(()) => total = total.saturating_sub(*size),
                Err(_) => remove_errors += 1,
            }
        }
    }
    if scan_errors > 0 || remove_errors > 0 {
        crate::logs::log(root, "warn", &format!(
            "audit corrupt cleanup failed: category=io scan_errors={scan_errors} remove_errors={remove_errors}"
        ));
    }
}

fn prune_tick_for_root(root: &Path, days: u32) {
    if let Err(error) = prune(root, days) {
        crate::logs::log(
            root,
            "warn",
            &format!("periodic audit prune failed: {error}"),
        );
    }
}

fn prune_on_start(root: &Path, days: u32) -> Result<(), String> {
    prune(root, days)
}

pub fn recent(root: &Path, days: u32) -> Result<Vec<Value>, String> {
    let path = root.join("audit/actions.json");
    let metadata = match std::fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(error) => return Err(format!("Журнал недоступен: {error}")),
    };
    if metadata.len() > MAX_AUDIT_BYTES {
        preserve_corrupt(&path, root, "oversized")?;
        return Ok(vec![]);
    }
    let data = std::fs::read(&path).map_err(|e| format!("Журнал недоступен: {e}"))?;
    let rows: Vec<Value> = match serde_json::from_slice(&data) {
        Ok(rows) => rows,
        Err(_) => {
            preserve_corrupt(&path, root, "invalid_json")?;
            return Ok(vec![]);
        }
    };
    let cutoff = now_ms().saturating_sub(u64::from(days.clamp(1, 365)) * 24 * 60 * 60 * 1000);
    Ok(rows
        .into_iter()
        .filter(|r| r["time"].as_u64().unwrap_or_default() >= cutoff)
        .collect())
}
pub fn append(
    root: &Path,
    tool: &str,
    status: &str,
    confirmed: bool,
    days: u32,
) -> Result<(), String> {
    let mut rows = recent(root, days)?;
    // Content-free provenance: when/what/decision only — no args, paths, tokens or output.
    rows.push(json!({"time":now_ms(),"tool":tool,"status":status,"confirmed":confirmed,"origin":"host_bridge"}));
    if rows.len() > 2000 {
        rows.drain(..rows.len() - 2000);
    }
    atomic_write(
        &root.join("audit/actions.json"),
        &serde_json::to_vec(&rows).map_err(|_| "Журнал недоступен")?,
    )
}
pub fn prune(root: &Path, days: u32) -> Result<(), String> {
    cleanup_corrupt(root, days);
    let path = root.join("audit/actions.json");
    let metadata = match std::fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Журнал недоступен: {error}")),
    };
    if metadata.len() > MAX_AUDIT_BYTES {
        preserve_corrupt(&path, root, "oversized")?;
        return Ok(());
    }
    let data = std::fs::read(&path).map_err(|e| format!("Журнал недоступен: {e}"))?;
    let current: Vec<Value> = match serde_json::from_slice(&data) {
        Ok(rows) => rows,
        Err(_) => {
            preserve_corrupt(&path, root, "invalid_json")?;
            return Ok(());
        }
    };
    let cutoff = now_ms().saturating_sub(u64::from(days.clamp(1, 365)) * 24 * 60 * 60 * 1000);
    let rows: Vec<Value> = current
        .iter()
        .filter(|row| row["time"].as_u64().unwrap_or_default() >= cutoff)
        .cloned()
        .collect();
    if rows.len() != current.len() {
        atomic_write(
            &path,
            &serde_json::to_vec(&rows).map_err(|_| "Журнал недоступен")?,
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retention_removes_old_rows() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(root.join("audit")).unwrap();
        atomic_write(
            &root.join("audit/actions.json"),
            br#"[{"time":1,"tool":"old"}]"#,
        )
        .unwrap();
        append(&root, "client.open_url", "ok", false, 30).unwrap();
        let r = recent(&root, 30).unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0]["tool"], "client.open_url");
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn retention_days_are_configurable_and_clamped() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(root.join("audit")).unwrap();
        let three_days_ago = now_ms() - 3 * 24 * 60 * 60 * 1000;
        atomic_write(
            &root.join("audit/actions.json"),
            format!(r#"[{{"time":{three_days_ago},"tool":"client.open_url"}}]"#).as_bytes(),
        )
        .unwrap();
        assert_eq!(recent(&root, 7).unwrap().len(), 1);
        assert_eq!(recent(&root, 2).unwrap().len(), 0);
        assert_eq!(
            recent(&root, 0).unwrap().len(),
            0,
            "0 is clamped to 1 day, never keeps forever"
        );
        assert_eq!(
            recent(&root, u32::MAX).unwrap().len(),
            1,
            "huge values clamp to 365 days"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn malformed_audit_file_is_preserved_before_recovery() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(root.join("audit")).unwrap();
        std::fs::write(root.join("audit/actions.json"), b"not json").unwrap();

        assert!(recent(&root, 30).unwrap().is_empty());
        prune(&root, 30).unwrap();
        assert_eq!(
            std::fs::read(root.join("audit/actions.json.corrupt")).unwrap(),
            b"not json"
        );
        append(&root, "client.open_url", "ok", false, 30).unwrap();

        let rows = recent(&root, 30).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["tool"], "client.open_url");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn corrupt_cleanup_limits_file_count() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let audit = root.join("audit");
        std::fs::create_dir_all(&audit).unwrap();
        for index in 0..(CORRUPT_MAX_FILES + 2) {
            std::fs::write(
                audit.join(format!("actions.json.{index}.corrupt")),
                b"small",
            )
            .unwrap();
        }
        prune(&root, 30).unwrap();
        let remaining = std::fs::read_dir(&audit)
            .unwrap()
            .filter_map(Result::ok)
            .count();
        assert_eq!(remaining, CORRUPT_MAX_FILES);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn corrupt_cleanup_removes_expired_files_only() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let audit = root.join("audit");
        std::fs::create_dir_all(&audit).unwrap();
        let old = audit.join("actions.json.old.corrupt");
        let fresh = audit.join("actions.json.corrupt");
        let unrelated = audit.join("unrelated.corrupt");
        for path in [&old, &fresh, &unrelated] {
            std::fs::write(path, b"data").unwrap();
        }
        let expired = std::time::SystemTime::now() - Duration::from_secs(40 * 24 * 60 * 60);
        for path in [&old, &unrelated] {
            std::fs::File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_modified(expired)
                .unwrap();
        }
        prune(&root, 30).unwrap();
        assert!(!old.exists());
        assert!(fresh.exists());
        assert!(unrelated.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn corrupt_cleanup_limits_bytes_below_file_count_limit() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let audit = root.join("audit");
        std::fs::create_dir_all(&audit).unwrap();
        for index in 0..3 {
            std::fs::write(
                audit.join(format!("actions.json.{index}.corrupt")),
                vec![b'x'; 3 * 1024 * 1024],
            )
            .unwrap();
        }
        prune(&root, 30).unwrap();
        let sizes: Vec<u64> = std::fs::read_dir(&audit)
            .unwrap()
            .map(|entry| entry.unwrap().metadata().unwrap().len())
            .collect();
        assert_eq!(sizes.len(), 2);
        assert_eq!(sizes.iter().sum::<u64>(), 6 * 1024 * 1024);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn corrupt_cleanup_logs_read_dir_failure_without_paths() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("audit"), b"not a directory").unwrap();
        cleanup_corrupt(&root, 30);
        let log = std::fs::read_to_string(root.join("logs/client.log")).unwrap();
        assert_eq!(log.lines().count(), 1);
        assert!(log.contains("warn audit corrupt cleanup failed: category=read_dir"));
        assert!(!log.contains(root.to_str().unwrap()));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn corrupt_cleanup_aggregates_removal_failures_without_names() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let audit = root.join("audit");
        for index in 0..10 {
            std::fs::create_dir_all(audit.join(format!("actions.json.private-{index}.corrupt")))
                .unwrap();
        }
        cleanup_corrupt(&root, 30);
        let log = std::fs::read_to_string(root.join("logs/client.log")).unwrap();
        assert_eq!(log.lines().count(), 1);
        assert!(log.contains("scan_errors=0 remove_errors=2"));
        assert!(!log.contains("private"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_json_marker_is_not_written_to_client_log() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(root.join("audit")).unwrap();
        let marker = ["fleet", "test", "49"].join("-");
        std::fs::write(
            root.join("audit/actions.json"),
            format!("\"{marker}\"").as_bytes(),
        )
        .unwrap();
        let _ = recent(&root, 30);
        let _ = prune(&root, 30);
        let log = std::fs::read_to_string(root.join("logs/client.log")).unwrap_or_default();
        assert!(!log.contains(&marker));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_journal_is_not_treated_as_empty() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(root.join("audit")).unwrap();
        let path = root.join("audit/actions.json");
        std::fs::write(&path, br#"[{"time":1}]"#).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::read(&path).is_err() {
            assert!(recent(&root, 30).is_err());
            assert!(path.exists());
        }
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn oversized_audit_file_is_preserved_and_startup_continues() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(root.join("audit")).unwrap();
        let oversized = vec![b'x'; 2 * 1024 * 1024 + 1];
        std::fs::write(root.join("audit/actions.json"), &oversized).unwrap();

        assert!(prune_on_start(&root, 30).is_ok());
        assert_eq!(
            std::fs::read(root.join("audit/actions.json.corrupt")).unwrap(),
            oversized
        );
        append(&root, "client.open_url", "ok", false, 30).unwrap();
        assert_eq!(recent(&root, 30).unwrap().len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn read_error_is_not_treated_as_an_empty_journal() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(root.join("audit/actions.json")).unwrap();
        assert!(recent(&root, 30).is_err());
        assert!(prune(&root, 30).is_err());
        assert!(root.join("audit/actions.json").is_dir());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn startup_pruning_rewrites_only_expired_rows() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(root.join("audit")).unwrap();
        std::fs::write(
            root.join("audit/actions.json"),
            serde_json::to_vec(&vec![
                json!({"time": 1, "tool": "old"}),
                json!({"time": now_ms(), "tool": "fresh"}),
            ])
            .unwrap(),
        )
        .unwrap();

        prune_on_start(&root, 30).unwrap();

        let on_disk: Vec<Value> =
            serde_json::from_slice(&std::fs::read(root.join("audit/actions.json")).unwrap())
                .unwrap();
        assert_eq!(on_disk.len(), 1);
        assert_eq!(on_disk[0]["tool"], "fresh");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn periodic_tick_prunes_expired_rows() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(root.join("audit")).unwrap();
        let settings = std::sync::Mutex::new(crate::storage::Settings::default());
        let audit_lock = std::sync::Mutex::new(());
        settings.lock().unwrap().audit_days = 2;
        std::fs::write(
            root.join("audit/actions.json"),
            serde_json::to_vec(&vec![json!({
                "time": now_ms() - 3 * 24 * 60 * 60 * 1000,
                "tool": "old"
            })])
            .unwrap(),
        )
        .unwrap();
        pruning_loop(Duration::from_millis(1), Some(1), || {
            prune_tick_with(&root, &audit_lock, &settings, 30)
        });
        assert!(serde_json::from_slice::<Vec<Value>>(
            &std::fs::read(root.join("audit/actions.json")).unwrap()
        )
        .unwrap()
        .is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
}
