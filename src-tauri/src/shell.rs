use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub handle: String,
    pub process_id: u32,
    pub title: String,
    pub visible: bool,
}

#[cfg(target_os = "windows")]
mod platform {
    use super::WindowInfo;
    use std::process::Command;
    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM, WPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindow, GetWindowLongPtrW, GetWindowTextLengthW, GetWindowTextW,
        GetWindowThreadProcessId, IsWindow, IsWindowVisible, PostMessageW, SetForegroundWindow,
        ShowWindow, GWL_EXSTYLE, GW_OWNER, SW_MAXIMIZE, SW_MINIMIZE, SW_RESTORE,
        WM_CLOSE, WS_EX_TOOLWINDOW,
    };

    fn parse_handle(handle: &str) -> Result<HWND, String> {
        let raw = handle
            .parse::<usize>()
            .map_err(|_| "Invalid window handle".to_string())?;
        let hwnd = raw as HWND;
        if unsafe { IsWindow(hwnd) } == 0 {
            return Err("Window handle is no longer valid".to_string());
        }
        Ok(hwnd)
    }

    fn is_user_window(hwnd: HWND) -> bool {
        if unsafe { IsWindow(hwnd) } == 0 || unsafe { IsWindowVisible(hwnd) } == 0 {
            return false;
        }

        if !unsafe { GetWindow(hwnd, GW_OWNER) }.is_null() {
            return false;
        }

        let ex_style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } as u32;
        if ex_style & WS_EX_TOOLWINDOW != 0 {
            return false;
        }

        true
    }

    unsafe extern "system" fn enum_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
        if !is_user_window(hwnd) {
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

        let windows = &mut *(lparam as *mut Vec<WindowInfo>);
        windows.push(WindowInfo {
            handle: (hwnd as usize).to_string(),
            process_id,
            title,
            visible: true,
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

        windows.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
        Ok(windows)
    }

    pub fn focus_window(handle: String) -> Result<(), String> {
        let hwnd = parse_handle(&handle)?;
        unsafe { ShowWindow(hwnd, SW_RESTORE); }

        if unsafe { SetForegroundWindow(hwnd) } == 0 {
            return Err("Windows refused the foreground activation request".to_string());
        }
        Ok(())
    }

    pub fn show_window(handle: String, mode: i32) -> Result<(), String> {
        let hwnd = parse_handle(&handle)?;
        unsafe { ShowWindow(hwnd, mode); }
        Ok(())
    }

    pub fn minimize_window(handle: String) -> Result<(), String> {
        show_window(handle, SW_MINIMIZE)
    }

    pub fn maximize_window(handle: String) -> Result<(), String> {
        show_window(handle, SW_MAXIMIZE)
    }

    pub fn restore_window(handle: String) -> Result<(), String> {
        show_window(handle, SW_RESTORE)
    }

    pub fn close_window(handle: String) -> Result<(), String> {
        let hwnd = parse_handle(&handle)?;
        let posted = unsafe { PostMessageW(hwnd, WM_CLOSE, 0 as WPARAM, 0) };
        if posted == 0 {
            return Err("Failed to request window close".to_string());
        }
        Ok(())
    }

    pub fn is_window_alive(handle: String) -> Result<bool, String> {
        match handle.parse::<usize>() {
            Ok(raw) => Ok(unsafe { IsWindow(raw as HWND) } != 0),
            Err(_) => Ok(false),
        }
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

    fn unsupported<T>() -> Result<T, String> {
        Err("LumenDeck shell controls are currently Windows-only".to_string())
    }

    pub fn list_windows() -> Result<Vec<WindowInfo>, String> { unsupported() }
    pub fn focus_window(_handle: String) -> Result<(), String> { unsupported() }
    pub fn minimize_window(_handle: String) -> Result<(), String> { unsupported() }
    pub fn maximize_window(_handle: String) -> Result<(), String> { unsupported() }
    pub fn restore_window(_handle: String) -> Result<(), String> { unsupported() }
    pub fn close_window(_handle: String) -> Result<(), String> { unsupported() }
    pub fn is_window_alive(_handle: String) -> Result<bool, String> { unsupported() }
    pub fn launch_explorer() -> Result<(), String> {
        Err("Explorer recovery is only available on Windows".to_string())
    }
}

#[tauri::command]
pub fn list_windows() -> Result<Vec<WindowInfo>, String> { platform::list_windows() }

#[tauri::command]
pub fn focus_window(handle: String) -> Result<(), String> { platform::focus_window(handle) }

#[tauri::command]
pub fn minimize_window(handle: String) -> Result<(), String> { platform::minimize_window(handle) }

#[tauri::command]
pub fn maximize_window(handle: String) -> Result<(), String> { platform::maximize_window(handle) }

#[tauri::command]
pub fn restore_window(handle: String) -> Result<(), String> { platform::restore_window(handle) }

#[tauri::command]
pub fn close_window(handle: String) -> Result<(), String> { platform::close_window(handle) }

#[tauri::command]
pub fn is_window_alive(handle: String) -> Result<bool, String> { platform::is_window_alive(handle) }

#[tauri::command]
pub fn launch_explorer() -> Result<(), String> { platform::launch_explorer() }
