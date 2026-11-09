//! Read-first filesystem surface for LumenDeck Files.
//! Real Windows paths are never copied into a proprietary store. Directory
//! enumeration is bounded; all writes are explicit, single-item operations.
use std::fs;
use std::io::Read;
#[cfg(target_os = "windows")]
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri_plugin_opener::OpenerExt;

const MAX_ITEMS: usize = 800;
const MAX_PREVIEW_BYTES: u64 = 3 * 1024 * 1024;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileLocation {
    label: String,
    path: String,
    kind: &'static str,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    name: String,
    path: String,
    kind: &'static str,
    extension: String,
    is_directory: bool,
    is_symlink: bool,
    is_read_only: bool,
    size_bytes: Option<u64>,
    modified_ms: Option<u64>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryListing {
    path: String,
    parent: Option<String>,
    entries: Vec<FileEntry>,
    truncated: bool,
    skipped: usize,
}

fn display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn home_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Some(home) = std::env::var_os("USERPROFILE") {
            return PathBuf::from(home);
        }
    }
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn resolve_path(path: Option<String>) -> PathBuf {
    match path {
        Some(s) if !s.trim().is_empty() => PathBuf::from(s),
        _ => home_dir(),
    }
}

fn kind_of(path: &Path, directory: bool) -> (&'static str, String) {
    if directory {
        return ("folder", String::new());
    }
    let extension = path.extension().and_then(|v| v.to_str())
        .unwrap_or("").to_ascii_lowercase();
    let kind = match extension.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "tif" | "tiff" => "image",
        "wav" | "mp3" | "flac" | "ogg" | "aiff" | "m4a" | "mid" => "audio",
        "mp4" | "mov" | "mkv" | "webm" | "avi" => "video",
        "rs" | "ts" | "tsx" | "js" | "jsx" | "py" | "json" | "html"
        | "css" | "md" | "toml" | "yml" | "yaml" | "go" | "cpp" | "h" => "code",
        "pdf" | "txt" | "doc" | "docx" | "xls" | "xlsx" | "ppt"
        | "pptx" | "rtf" | "odt" => "document",
        _ => "file",
    };
    (kind, extension)
}

fn modified_ms(meta: &fs::Metadata) -> Option<u64> {
    meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()
        .and_then(|v| u64::try_from(v.as_millis()).ok())
}

fn entry_from(dir_entry: fs::DirEntry) -> Result<FileEntry, std::io::Error> {
    let path = dir_entry.path();
    // Follow only this entry's metadata; never recursively enumerate targets.
    let meta = dir_entry.metadata()?;
    let is_directory = meta.is_dir();
    let is_symlink = fs::symlink_metadata(&path)
        .map(|m| m.file_type().is_symlink()).unwrap_or(false);
    let (kind, extension) = kind_of(&path, is_directory);
    Ok(FileEntry {
        name: dir_entry.file_name().to_string_lossy().into_owned(),
        path: display(&path),
        kind,
        extension,
        is_directory,
        is_symlink,
        is_read_only: meta.permissions().readonly(),
        size_bytes: if is_directory { None } else { Some(meta.len()) },
        modified_ms: modified_ms(&meta),
    })
}

#[cfg(target_os = "windows")]
#[link(name = "kernel32")]
extern "system" {
    fn GetLogicalDrives() -> u32;
    fn MoveFileW(existing: *const u16, destination: *const u16) -> i32;
}

/// Common user places plus actual mounted drive letters (not synthetic demos).
#[tauri::command]
pub fn files_locations() -> Vec<FileLocation> {
    let home = home_dir();
    let mut places = vec![FileLocation {
        label: "Home".into(), path: display(&home), kind: "home",
    }];
    for label in ["Desktop", "Documents", "Downloads", "Pictures", "Music", "Videos"] {
        let path = home.join(label);
        if path.is_dir() {
            places.push(FileLocation {
                label: label.into(), path: display(&path), kind: "folder",
            });
        }
    }
    #[cfg(target_os = "windows")]
    {
        let drives = unsafe { GetLogicalDrives() };
        for i in 0..26u32 {
            if drives & (1u32 << i) != 0 {
                let letter = (b'A' + i as u8) as char;
                places.push(FileLocation {
                    label: format!("{letter}:"),
                    path: format!("{letter}:\\"),
                    kind: "drive",
                });
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    places.push(FileLocation {
        label: "Root".into(), path: "/".into(), kind: "drive",
    });
    places
}

/// Enumerate only the selected directory. No background disk crawl or indexing.
#[tauri::command]
pub async fn files_list(path: Option<String>) -> Result<DirectoryListing, String> {
    tauri::async_runtime::spawn_blocking(move || files_list_sync(path))
        .await
        .map_err(|error| format!("Directory reading task failed: {error}"))?
}

fn files_list_sync(path: Option<String>) -> Result<DirectoryListing, String> {
    let folder = resolve_path(path);
    let meta = fs::metadata(&folder).map_err(|e| format!("Cannot access folder: {e}"))?;
    if !meta.is_dir() {
        return Err("The path is not a directory.".into());
    }
    let iterator = fs::read_dir(&folder).map_err(|e| format!("Cannot read folder: {e}"))?;
    let mut entries = Vec::new();
    let mut skipped = 0;
    let mut truncated = false;
    for entry in iterator {
        if entries.len() >= MAX_ITEMS {
            truncated = true;
            break;
        }
        match entry.and_then(entry_from) {
            Ok(item) => entries.push(item),
            Err(_) => skipped += 1,
        }
    }
    entries.sort_unstable_by(|a, b| b.is_directory.cmp(&a.is_directory)
        .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(DirectoryListing {
        path: display(&folder),
        parent: folder.parent().filter(|p| *p != folder).map(display),
        entries,
        truncated,
        skipped,
    })
}

fn valid_name(name: &str) -> bool {
    if name.is_empty() || name.trim() != name || name == "." || name == ".."
        || name.ends_with('.') || name.chars().any(|c|
            c.is_control() || ['\\', '/', ':', '*', '?', '"', '<', '>', '|'].contains(&c)
        )
    { return false; }
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    !matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "COM1" | "COM2"
        | "COM3" | "COM4" | "COM5" | "COM6" | "COM7" | "COM8" | "COM9"
        | "LPT1" | "LPT2" | "LPT3" | "LPT4" | "LPT5" | "LPT6"
        | "LPT7" | "LPT8" | "LPT9")
}

/// Creates one folder, never overwrites an existing path.
#[tauri::command]
pub async fn files_create_folder(parent: String, name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || create_folder_sync(parent, name))
        .await
        .map_err(|error| format!("Create-folder task failed: {error}"))?
}

fn create_folder_sync(parent: String, name: String) -> Result<(), String> {
    if !valid_name(&name) { return Err("Choose a valid single folder name.".into()); }
    let directory = PathBuf::from(parent);
    if !directory.is_dir() { return Err("Parent folder is not accessible.".into()); }
    fs::create_dir(directory.join(name)).map_err(|e| format!("Could not create folder: {e}"))
}

/// Renames a single entry within its current directory. Never moves or deletes.
#[tauri::command]
pub async fn files_rename(path: String, new_name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || rename_sync(path, new_name))
        .await
        .map_err(|error| format!("Rename task failed: {error}"))?
}

fn rename_sync(path: String, new_name: String) -> Result<(), String> {
    if !valid_name(&new_name) { return Err("Choose a valid single file or folder name.".into()); }
    let source = PathBuf::from(path);
    let parent = source.parent().ok_or("Cannot rename a drive root.")?;
    if source.file_name().is_none() { return Err("Cannot rename a drive root.".into()); }
    fs::symlink_metadata(&source).map_err(|e| format!("Cannot access item: {e}"))?;
    let target = parent.join(new_name);
    if target == source { return Ok(()); }
    // symlink_metadata also sees dangling symlink destinations.
    if fs::symlink_metadata(&target).is_ok() {
        return Err("An item with that name already exists.".into());
    }
    // On Windows, MoveFileW fails if the target exists. Unlike a separate
    // exists() check followed by fs::rename, it cannot replace a file created
    // between the check and the rename.
    #[cfg(target_os = "windows")]
    {
        let from: Vec<u16> = source.as_os_str().encode_wide().chain([0]).collect();
        let to: Vec<u16> = target.as_os_str().encode_wide().chain([0]).collect();
        if unsafe { MoveFileW(from.as_ptr(), to.as_ptr()) } == 0 {
            return Err(format!("Could not rename item: {}", std::io::Error::last_os_error()));
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        fs::rename(&source, target).map_err(|e| format!("Could not rename item: {e}"))
    }
}

/// Explicit external opening uses the already-installed Tauri opener plugin.
/// Script/installer execution is intentionally unavailable in this first slice.
#[tauri::command]
pub fn files_open(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let source = PathBuf::from(path);
    if !fs::metadata(&source).map_err(|e| format!("Cannot access file: {e}"))?.is_file() {
        return Err("Select a file to open. Double-click folders to browse them.".into());
    }
    let ext = source.extension().and_then(|e| e.to_str())
        .unwrap_or("").to_ascii_lowercase();
    // An unknown/default Windows file association may EXECUTE a program
    // (.js can invoke Node, .py can invoke Python, and shortcuts are commands).
    // This first slice only passes common passive document/media formats to
    // the OS. The user may deliberately open other types via Explorer fallback.
    if !matches!(ext.as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "tif" | "tiff"
        | "wav" | "mp3" | "flac" | "ogg" | "aiff" | "m4a" | "mid"
        | "mp4" | "mov" | "mkv" | "webm" | "avi"
        | "txt" | "md" | "pdf" | "rtf" | "docx" | "xlsx" | "pptx"
        | "csv" | "log" | "json" | "toml" | "yaml" | "yml"
    ) {
        return Err(
            "This file type may launch code or an untrusted association. Open it explicitly through Windows Explorer.".into(),
        );
    }
    app.opener().open_path(display(&source), None::<&str>)
        .map_err(|e| format!("Windows could not open this file: {e}"))
}

/// Raster-only preview. Returns bytes for a single explicitly requested item
/// instead of enabling unrestricted WebView file:// or an asset-server scope.
#[tauri::command]
pub async fn files_preview(path: String) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || preview_sync(path))
        .await
        .map_err(|error| format!("Preview task failed: {error}"))?
}

fn preview_sync(path: String) -> Result<Vec<u8>, String> {
    let file = PathBuf::from(path);
    let ext = file.extension().and_then(|e| e.to_str())
        .unwrap_or("").to_ascii_lowercase();
    if !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp") {
        return Err("Only raster image previews are supported.".into());
    }
    let meta = fs::metadata(&file).map_err(|e| format!("Cannot preview file: {e}"))?;
    if !meta.is_file() || meta.len() > MAX_PREVIEW_BYTES {
        return Err("Preview unavailable for images over 3 MB.".into());
    }
    // Bound the actual read even if the file grows after the metadata check.
    let input = fs::File::open(file).map_err(|e| format!("Cannot read preview: {e}"))?;
    let mut data = Vec::new();
    input.take(MAX_PREVIEW_BYTES + 1)
        .read_to_end(&mut data).map_err(|e| format!("Cannot read preview: {e}"))?;
    if data.len() as u64 > MAX_PREVIEW_BYTES {
        return Err("Preview unavailable for images over 3 MB.".into());
    }
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::{kind_of, valid_name};
    use std::path::Path;
    #[test]
    fn rejects_traversal_and_windows_device_names() {
        for name in ["", ".", "..", "../folder", "a/b", "a\\b", "NUL.txt",
            "con", "COM1", "file.", "trailing ", "a:b"] {
            assert!(!valid_name(name), "accepted unsafe name: {name}");
        }
        assert!(valid_name("My Project"));
        assert!(valid_name("cover-final.png"));
    }
    #[test]
    fn detects_file_kinds_without_reading_contents() {
        assert_eq!(kind_of(Path::new("sample.WAV"), false).0, "audio");
        assert_eq!(kind_of(Path::new("cover.png"), false).0, "image");
        assert_eq!(kind_of(Path::new("folder"), true).0, "folder");
    }

    fn test_folder(name: &str) -> std::path::PathBuf {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let folder = std::env::temp_dir()
            .join(format!("lumendeck-files-test-{name}-{}-{nonce}", std::process::id()));
        std::fs::create_dir(&folder).unwrap();
        folder
    }

    #[test]
    fn directory_listing_reads_real_files_without_recursive_crawl() {
        let root = test_folder("listing");
        std::fs::write(root.join("song.wav"), b"hello").unwrap();
        std::fs::create_dir(root.join("Subfolder")).unwrap();
        std::fs::write(root.join("Subfolder").join("child.txt"), b"child").unwrap();

        let list = super::files_list_sync(Some(super::display(&root))).unwrap();
        assert_eq!(list.entries.len(), 2);
        assert_eq!(list.entries[0].name, "Subfolder");
        assert_eq!(list.entries[0].kind, "folder");
        assert_eq!(list.entries[1].kind, "audio");
        assert!(!list.truncated);

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn creates_folder_and_prevents_overwriting_existing_rename_target() {
        let root = test_folder("rename");
        let root_text = super::display(&root);
        super::create_folder_sync(root_text, "Created".into()).unwrap();
        assert!(root.join("Created").is_dir());
        assert!(super::create_folder_sync(super::display(&root), "../escape".into()).is_err());
        std::fs::write(root.join("source.txt"), b"source").unwrap();
        std::fs::write(root.join("existing.txt"), b"existing").unwrap();

        assert!(super::rename_sync(super::display(&root.join("source.txt")), "existing.txt".into()).is_err());
        assert_eq!(std::fs::read(root.join("existing.txt")).unwrap(), b"existing");
        assert_eq!(std::fs::read(root.join("source.txt")).unwrap(), b"source");
        super::rename_sync(super::display(&root.join("source.txt")), "renamed.txt".into()).unwrap();
        assert_eq!(std::fs::read(root.join("renamed.txt")).unwrap(), b"source");

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn preview_is_bounded_and_rejects_non_image_extensions() {
        let root = test_folder("preview");
        let image = root.join("cover.png");
        std::fs::write(&image, b"\x89PNG").unwrap();
        assert_eq!(super::preview_sync(super::display(&image)).unwrap(), b"\x89PNG");
        std::fs::write(root.join("notes.txt"), b"note").unwrap();
        assert!(super::preview_sync(super::display(&root.join("notes.txt"))).is_err());

        std::fs::write(&image, vec![0u8; (super::MAX_PREVIEW_BYTES + 1) as usize]).unwrap();
        assert!(super::preview_sync(super::display(&image)).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
