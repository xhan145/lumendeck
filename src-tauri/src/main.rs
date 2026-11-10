// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;
#[cfg(target_os = "windows")]
use std::process::Command;

mod files;

#[cfg(target_os = "windows")]
#[link(name = "kernel32")]
extern "system" {
    fn GetWindowsDirectoryW(buffer: *mut u16, size: u32) -> u32;
}

#[cfg(target_os = "windows")]
fn windows_root() -> Result<std::path::PathBuf, String> {
    use std::os::windows::ffi::OsStringExt;

    // Ask Windows itself instead of trusting PATH or the working directory.
    let mut buffer = vec![0u16; 512];
    loop {
        let size = unsafe { GetWindowsDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) };
        if size == 0 {
            return Err(format!("Cannot locate the Windows directory: {}", std::io::Error::last_os_error()));
        }
        if size as usize >= buffer.len() {
            buffer.resize(size as usize + 1, 0);
            continue;
        }
        return Ok(std::path::PathBuf::from(
            std::ffi::OsString::from_wide(&buffer[..size as usize]),
        ));
    }
}

#[cfg(target_os = "windows")]
fn open_windows_system_app(relative: &str, label: &str) -> Result<(), String> {
    let executable = windows_root()?.join(relative);
    if !executable.is_file() {
        return Err(format!("The official {label} executable is missing from the Windows system directory."));
    }
    Command::new(&executable)
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("Failed to open {label}: {err}"))
}

#[tauri::command]
fn open_explorer() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        open_windows_system_app("explorer.exe", "Windows Explorer")
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Windows Explorer recovery is only available on Windows.".into())
    }
}

#[tauri::command]
fn open_task_manager() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        open_windows_system_app("System32\\Taskmgr.exe", "Task Manager")
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Task Manager recovery is only available on Windows.".into())
    }
}

/// Find the optional packaged Python runtime without requiring a system
/// interpreter. Dev builds can run without resources/python.
fn bundled_python(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let resource_dir = app.path().resource_dir().ok()?;
    for rel in ["python/python.exe", "resources/python/python.exe"] {
        let candidate = resource_dir.join(rel);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            open_explorer,
            open_task_manager,
            files::files_locations,
            files::files_list,
            files::files_create_folder,
            files::files_rename,
            files::files_open,
            files::files_preview,
            files::files_preview_text,
        ])
        .setup(|app| {
            // Auto-start the bundled render bridge sidecar on port 8787.
            let handle = app.handle().clone();
            if let Ok(cmd) = handle.shell().sidecar("lumendeck-bridge") {
                let cmd = match bundled_python(&handle) {
                    Some(py) => cmd.env("LUMENDECK_PYTHON", py.to_string_lossy().to_string()),
                    None => cmd,
                };
                if let Ok((mut rx, child)) = cmd
                    .args(["--port", "8787"])
                    .env("LUMENDECK_PARENT_WATCH", "1")
                    .spawn()
                {
                    // Keep the child (and its stdin pipe) alive for the app's whole
                    // lifetime. If we dropped it, the stdin pipe would close and the
                    // sidecar's watchdog would exit immediately. On app exit/crash the
                    // OS closes this handle, the sidecar sees stdin EOF, and it stops —
                    // which also reaps PyInstaller's onefile grandchild.
                    std::mem::forget(child);
                    tauri::async_runtime::spawn(async move {
                        while let Some(event) = rx.recv().await {
                            if let CommandEvent::Stderr(line) | CommandEvent::Stdout(line) = event {
                                let _ = String::from_utf8(line);
                            }
                        }
                    });
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running LumenDeck");
}
