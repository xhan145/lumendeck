// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
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
