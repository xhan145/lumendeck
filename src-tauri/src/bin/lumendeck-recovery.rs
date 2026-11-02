#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

use std::env;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const POLL_INTERVAL: Duration = Duration::from_secs(2);
const HEARTBEAT_STALE_AFTER: Duration = Duration::from_secs(12);

#[derive(Debug)]
struct Config {
    parent_pid: u32,
    heartbeat: PathBuf,
    log_path: PathBuf,
    shell_mode: bool,
}

fn unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn log_line(path: &Path, message: &str) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{} {}", unix_ms(), message);
    }
}

fn parse_args() -> Result<Config, String> {
    let mut parent_pid = None;
    let mut heartbeat = None;
    let mut log_path = None;
    let mut shell_mode = false;

    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--parent-pid" => {
                let value = args.next().ok_or("Missing --parent-pid value")?;
                parent_pid = Some(value.parse::<u32>().map_err(|_| "Invalid parent pid")?);
            }
            "--heartbeat" => {
                heartbeat = Some(PathBuf::from(args.next().ok_or("Missing --heartbeat value")?));
            }
            "--log" => {
                log_path = Some(PathBuf::from(args.next().ok_or("Missing --log value")?));
            }
            "--shell-mode" => shell_mode = true,
            _ => return Err(format!("Unknown argument: {arg}")),
        }
    }

    Ok(Config {
        parent_pid: parent_pid.ok_or("Missing --parent-pid")?,
        heartbeat: heartbeat.ok_or("Missing --heartbeat")?,
        log_path: log_path.ok_or("Missing --log")?,
        shell_mode,
    })
}

#[cfg(target_os = "windows")]
fn process_alive(pid: u32) -> bool {
    let filter = format!("PID eq {pid}");
    let output = Command::new("tasklist")
        .args(["/FI", &filter, "/NH"])
        .output();

    match output {
        Ok(output) => {
            let text = String::from_utf8_lossy(&output.stdout);
            text.contains(&pid.to_string()) && !text.contains("No tasks are running")
        }
        Err(_) => true,
    }
}

#[cfg(not(target_os = "windows"))]
fn process_alive(pid: u32) -> bool {
    PathBuf::from(format!("/proc/{pid}")).exists()
}

fn heartbeat_fresh(path: &Path) -> bool {
    let modified = match fs::metadata(path).and_then(|meta| meta.modified()) {
        Ok(value) => value,
        Err(_) => return false,
    };

    SystemTime::now()
        .duration_since(modified)
        .map(|age| age <= HEARTBEAT_STALE_AFTER)
        .unwrap_or(true)
}

#[cfg(target_os = "windows")]
fn launch_explorer(log_path: &Path) {
    match Command::new("explorer.exe").spawn() {
        Ok(_) => log_line(log_path, "fallback explorer launch requested"),
        Err(error) => log_line(log_path, &format!("fallback explorer launch failed: {error}")),
    }
}

#[cfg(not(target_os = "windows"))]
fn launch_explorer(_log_path: &Path) {}

fn main() {
    let config = match parse_args() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("lumendeck-recovery: {error}");
            std::process::exit(2);
        }
    };

    log_line(
        &config.log_path,
        &format!(
            "watchdog started parent={} shell_mode={}",
            config.parent_pid, config.shell_mode
        ),
    );

    let mut stale_ticks = 0u32;

    loop {
        let alive = process_alive(config.parent_pid);
        let heartbeat_ok = heartbeat_fresh(&config.heartbeat);

        if !alive {
            log_line(&config.log_path, "parent process exited");
            if config.shell_mode {
                launch_explorer(&config.log_path);
            }
            break;
        }

        if heartbeat_ok {
            stale_ticks = 0;
        } else {
            stale_ticks = stale_ticks.saturating_add(1);
            if stale_ticks == 1 {
                log_line(&config.log_path, "heartbeat became stale");
            }
        }

        // A stale heartbeat alone does not kill or replace LumenDeck. The watchdog
        // only records it. Process-exit fallback is reserved for explicit shell mode.
        thread::sleep(POLL_INTERVAL);
    }

    log_line(&config.log_path, "watchdog stopped");
}
