use crate::{policy::now_ms, storage::atomic_write};
use serde_json::{json, Value};
use std::{path::Path, time::Duration};
use tauri::Manager;

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
        .spawn(move || pruning_loop(app, root, initial_days, Duration::from_secs(24 * 60 * 60)))?;
    Ok(())
}

fn pruning_loop(
    app: tauri::AppHandle,
    root: std::path::PathBuf,
    initial_days: u32,
    period: Duration,
) {
    loop {
        std::thread::sleep(period);
        prune_tick(&app, &root, initial_days);
    }
}

#[cfg(test)]
fn run_pruning_ticks(root: &Path, days: u32, period: Duration, ticks: usize) {
    for _ in 0..ticks {
        std::thread::sleep(period);
        prune_tick_for_root(root, days);
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
    let _guard = match state.audit_lock.lock() {
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
    let days = match state.settings.lock() {
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
        &format!("corrupt audit journal moved aside: {reason}"),
    );
    Ok(())
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
    if metadata.len() > 2 * 1024 * 1024 {
        preserve_corrupt(&path, root, "journal exceeds 2 MiB")?;
        return Ok(vec![]);
    }
    let data = std::fs::read(&path).map_err(|e| format!("Журнал недоступен: {e}"))?;
    let rows: Vec<Value> = match serde_json::from_slice(&data) {
        Ok(rows) => rows,
        Err(error) => {
            preserve_corrupt(&path, root, &error.to_string())?;
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
    let path = root.join("audit/actions.json");
    let metadata = match std::fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Журнал недоступен: {error}")),
    };
    if metadata.len() > 2 * 1024 * 1024 {
        preserve_corrupt(&path, root, "journal exceeds 2 MiB")?;
        return Ok(());
    }
    let data = std::fs::read(&path).map_err(|e| format!("Журнал недоступен: {e}"))?;
    let current: Vec<Value> = match serde_json::from_slice(&data) {
        Ok(rows) => rows,
        Err(error) => {
            preserve_corrupt(&path, root, &error.to_string())?;
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
        std::fs::write(
            root.join("audit/actions.json"),
            br#"[{"time":1,"tool":"old"}]"#,
        )
        .unwrap();
        run_pruning_ticks(&root, 30, Duration::from_millis(1), 1);
        assert!(serde_json::from_slice::<Vec<Value>>(
            &std::fs::read(root.join("audit/actions.json")).unwrap()
        )
        .unwrap()
        .is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
}
