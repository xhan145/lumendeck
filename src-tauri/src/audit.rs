use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedActionAudit {
    pub timestamp: String,
    pub action_id: String,
    pub source: String,
    pub capability: String,
    pub risk: String,
    pub decision: String,
    pub ok: bool,
}

fn audit_path() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join("LumenDeck").join("logs").join("actions.jsonl")
}

#[tauri::command]
pub fn append_action_audit(entry: PersistedActionAudit) -> Result<(), String> {
    let path = audit_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let line = serde_json::to_string(&entry).map_err(|error| error.to_string())?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| error.to_string())?;

    writeln!(file, "{line}").map_err(|error| error.to_string())
}

#[tauri::command]
pub fn action_audit_path() -> String {
    audit_path().display().to_string()
}
