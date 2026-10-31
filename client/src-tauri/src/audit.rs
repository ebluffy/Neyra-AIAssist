use crate::{policy::now_ms, storage::atomic_write};
use serde_json::{json, Value};
use std::path::Path;

pub fn recent(root: &Path, days: u32) -> Result<Vec<Value>, String> {
    let path = root.join("audit/actions.json");
    if !path.exists() {
        return Ok(vec![]);
    }
    let metadata = std::fs::metadata(&path).map_err(|_| "Журнал недоступен")?;
    if metadata.len() > 2 * 1024 * 1024 {
        return Err("Журнал превышает лимит".into());
    }
    let rows: Vec<Value> =
        serde_json::from_slice(&std::fs::read(path).map_err(|_| "Журнал недоступен")?)
            .map_err(|_| "Журнал повреждён")?;
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
}
