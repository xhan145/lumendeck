// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Auto-start the bundled render bridge sidecar on port 8787.
            // The shell plugin terminates it when the app exits.
            let handle = app.handle().clone();
            if let Ok(cmd) = handle.shell().sidecar("lumendeck-bridge") {
                if let Ok((mut rx, _child)) = cmd.args(["--port", "8787"]).spawn() {
                    tauri::async_runtime::spawn(async move {
                        while let Some(event) = rx.recv().await {
                            if let CommandEvent::Stderr(line) | CommandEvent::Stdout(line) = event {
                                // Drain output so the sidecar pipe never blocks.
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
