// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod recovery;
mod shell;

use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            shell::list_windows,
            shell::focus_window,
            shell::minimize_window,
            shell::maximize_window,
            shell::restore_window,
            shell::close_window,
            shell::is_window_alive,
            shell::launch_explorer,
            recovery::recovery_status
        ])
        .setup(|app| {
            recovery::start_heartbeat();
            recovery::start_watchdog_if_available();

            // Auto-start the bundled render bridge sidecar on port 8787.
            let handle = app.handle().clone();
            if let Ok(cmd) = handle.shell().sidecar("lumendeck-bridge") {
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
