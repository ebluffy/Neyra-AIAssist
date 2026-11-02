use crate::{policy::now_ms, storage::atomic_write};
use serde_json::{json, Value};
use std::{path::Path, time::Duration};
use tauri::Manager;

pub fn start_pruning(
    app: tauri::AppHandle,
    root: std::path::PathBuf,
    initial_days: u32,
) -> std::io::Result<()> {
    prune_on_start(&root, initial_days).map_err(std::io::Error::other)?;
    std::thread::Builder::new()
        .name("audit-prune".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_secs(24 * 60 * 60));
            if let Some(state) = app.try_state::<crate::Desktop>() {
                if let Ok(_guard) = state.audit_lock.lock() {
                    let days = state
                        .settings
                        .lock()
                        .map(|s| s.audit_days)
                        .unwrap_or(initial_days);
                    let _ = prune(&root, days);
                }
            }
        })?;
    Ok(())
}

fn prune_on_start(root: &Path, days: u32) -> Result<(), String> {
    prune(root, days)
}

pub fn recent(root: &Path, days: u32) -> Result<Vec<Value>, String> {
    let path = root.join("audit/actions.json");
    if !path.exists() {
        return Ok(vec![]);
    }
    let metadata = std::fs::metadata(&path).map_err(|_| "Журнал недоступен")?;
    if metadata.len() > 2 * 1024 * 1024 {
        return Err("Журнал превышает лимит".into());
    }
    let rows: Vec<Value> = match std::fs::read(path)
        .ok()
        .and_then(|data| serde_json::from_slice(&data).ok())
    {
        Some(rows) => rows,
        None => return Ok(vec![]),
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
    atomic_write(
        &root.join("audit/actions.json"),
        &serde_json::to_vec(&recent(root, days)?).map_err(|_| "Журнал недоступен")?,
    )
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
    fn malformed_audit_file_is_ignored_and_replaced_atomically() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(root.join("audit")).unwrap();
        std::fs::write(root.join("audit/actions.json"), b"not json").unwrap();

        assert!(recent(&root, 30).unwrap().is_empty());
        append(&root, "client.open_url", "ok", false, 30).unwrap();

        let rows = recent(&root, 30).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["tool"], "client.open_url");
        assert!(std::fs::read_dir(root.join("audit"))
            .unwrap()
            .all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp")));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn startup_pruning_removes_expired_rows() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(root.join("audit")).unwrap();
        std::fs::write(
            root.join("audit/actions.json"),
            serde_json::to_vec(&vec![json!({"ts": 1, "tool": "old"})]).unwrap(),
        )
        .unwrap();

        prune_on_start(&root, 30).unwrap();

        assert!(recent(&root, 30).unwrap().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
}
