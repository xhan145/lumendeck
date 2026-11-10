use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::OnceLock;
use std::thread;
use std::time::Duration;

static RECOVERY_CHILD: OnceLock<Option<u32>> = OnceLock::new();

fn recovery_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join("LumenDeck").join("recovery")
}

pub fn heartbeat_path() -> PathBuf {
    recovery_dir().join("heartbeat")
}

pub fn watchdog_log_path() -> PathBuf {
    recovery_dir().join("watchdog.log")
}

fn sibling_watchdog_path() -> Result<PathBuf, String> {
    let current = std::env::current_exe().map_err(|error| error.to_string())?;
    let dir = current
        .parent()
        .ok_or_else(|| "Cannot resolve LumenDeck executable directory".to_string())?;

    #[cfg(target_os = "windows")]
    let name = "lumendeck-recovery.exe";
    #[cfg(not(target_os = "windows"))]
    let name = "lumendeck-recovery";

    Ok(dir.join(name))
}

fn spawn_watchdog(shell_mode: bool) -> Result<Child, String> {
    let watchdog = sibling_watchdog_path()?;
    if !watchdog.exists() {
        return Err(format!("Recovery watchdog not installed at {}", watchdog.display()));
    }

    let dir = recovery_dir();
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;

    let heartbeat = heartbeat_path();
    let log_path = watchdog_log_path();
    let pid = std::process::id();

    let mut command = Command::new(watchdog);
    command
        .arg("--parent-pid")
        .arg(pid.to_string())
        .arg("--heartbeat")
        .arg(&heartbeat)
        .arg("--log")
        .arg(&log_path);

    if shell_mode {
        command.arg("--shell-mode");
    }

    command.spawn().map_err(|error| error.to_string())
}

pub fn start_heartbeat() {
    let path = heartbeat_path();
    thread::spawn(move || loop {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(&path, b"alive\n");
        thread::sleep(Duration::from_secs(3));
    });
}

pub fn start_watchdog_if_available() {
    let shell_mode = std::env::var("LUMENDECK_SHELL_MODE")
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(false);

    match spawn_watchdog(shell_mode) {
        Ok(child) => {
            let _ = RECOVERY_CHILD.set(Some(child.id()));
        }
        Err(error) => {
            eprintln!("[recovery] {error}");
            let _ = RECOVERY_CHILD.set(None);
        }
    }
}

#[tauri::command]
pub fn recovery_status() -> serde_json::Value {
    serde_json::json!({
        "watchdogPid": RECOVERY_CHILD.get().copied().flatten(),
        "heartbeatPath": heartbeat_path().display().to_string(),
        "logPath": watchdog_log_path().display().to_string(),
        "shellMode": std::env::var("LUMENDECK_SHELL_MODE")
            .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
            .unwrap_or(false),
    })
}
