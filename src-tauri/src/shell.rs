use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub handle: u64,
    pub process_id: u32,
    pub title: String,
    pub visible: bool,
}

#[cfg(target_os = "windows")]
mod platform {
    use super::WindowInfo;
    use std::process::Command;
    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
        IsWindow, IsWindowVisible, SetForegroundWindow, ShowWindow, SW_RESTORE,
    };

    unsafe extern "system" fn enum_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let windows = &mut *(lparam as *mut Vec<WindowInfo>);

        if IsWindow(hwnd) == 0 {
            return 1;
        }

        let title_len = GetWindowTextLengthW(hwnd);
        if title_len <= 0 {
            return 1;
        }

        let mut title_buf = vec![0u16; title_len as usize + 1];
        let written = GetWindowTextW(hwnd, title_buf.as_mut_ptr(), title_buf.len() as i32);
        if written <= 0 {
            return 1;
        }

        let title = String::from_utf16_lossy(&title_buf[..written as usize])
            .trim()
            .to_string();
        if title.is_empty() {
            return 1;
        }

        let mut process_id = 0u32;
        GetWindowThreadProcessId(hwnd, &mut process_id);

        windows.push(WindowInfo {
            handle: hwnd as usize as u64,
            process_id,
            title,
            visible: IsWindowVisible(hwnd) != 0,
        });

        1
    }

    pub fn list_windows() -> Result<Vec<WindowInfo>, String> {
        let mut windows = Vec::<WindowInfo>::new();
        let ok = unsafe {
            EnumWindows(
                Some(enum_window),
                &mut windows as *mut Vec<WindowInfo> as LPARAM,
            )
        };

        if ok == 0 {
            return Err("EnumWindows failed".to_string());
        }

        windows.sort_by(|a, b| {
            b.visible
                .cmp(&a.visible)
                .then_with(|| a.title.to_lowercase().cmp(&b.title.to_lowercase()))
        });

        Ok(windows)
    }

    pub fn focus_window(handle: u64) -> Result<(), String> {
        let hwnd = handle as usize as HWND;

        if unsafe { IsWindow(hwnd) } == 0 {
            return Err("Window handle is no longer valid".to_string());
        }

        unsafe {
            ShowWindow(hwnd, SW_RESTORE);
        }

        if unsafe { SetForegroundWindow(hwnd) } == 0 {
            return Err("Windows refused the foreground activation request".to_string());
        }

        Ok(())
    }

    pub fn launch_explorer() -> Result<(), String> {
        Command::new("explorer.exe")
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("Failed to launch Explorer: {error}"))
    }
}

#[cfg(not(target_os = "windows"))]
mod platform {
    use super::WindowInfo;

    pub fn list_windows() -> Result<Vec<WindowInfo>, String> {
        Err("LumenDeck shell controls are currently Windows-only".to_string())
    }

    pub fn focus_window(_handle: u64) -> Result<(), String> {
        Err("LumenDeck shell controls are currently Windows-only".to_string())
    }

    pub fn launch_explorer() -> Result<(), String> {
        Err("Explorer recovery is only available on Windows".to_string())
    }
}

#[tauri::command]
pub fn list_windows() -> Result<Vec<WindowInfo>, String> {
    platform::list_windows()
}

#[tauri::command]
pub fn focus_window(handle: u64) -> Result<(), String> {
    platform::focus_window(handle)
}

#[tauri::command]
pub fn launch_explorer() -> Result<(), String> {
    platform::launch_explorer()
}
