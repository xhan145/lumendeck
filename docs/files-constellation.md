# Files + Constellation: native first slice

This is a **real filesystem browser**, not a replacement storage format. The
creative Constellation view remains separate; this Files screen applies the same
stars-and-relationships language to actual local folder entries.

## How to open it

1. On Windows, launch with `npm.cmd run tauri:dev` from a Visual Studio
   developer shell (or an x64 shell initialized with `vcvars64.bat`).
2. Choose **Files** on the Desktop, dock, rail or Ctrl+Space launcher.
3. Use **List**, **Grid**, or **Constellation** at the top of Files.
4. Click once to select. Double-click / press Enter to browse a folder or open
   a document in its default Windows application. Constellation stars can be
   selected by clicking and opened by double-clicking.
5. Type a folder path in the address bar (Ctrl+L), use Back (Alt+Left),
   Up (Alt+Up), common places, mounted drives, or Refresh.
6. Use **New folder** or select an item then **Rename** for explicit changes.

## Reality and safety boundaries

- The Rust backend enumerates a single requested directory only, capped at 800
  entries per request. Current-folder search and sorting apply to loaded entries
  only. There is no recursive search, indexer, filesystem watcher or background
  crawler. Permission errors are surfaced; inaccessible entries are counted.
- The star chart is an **ephemeral projection** of these real entries. Orbiting,
  panning, zooming or selecting never moves, modifies or duplicates files.
  Constellation displays up to 180 actual entries with balanced categories.
  A separate accessible index covers all loaded entries.
- Image previews use a bounded, explicitly requested native raster read (up to
  3 MiB) and a temporary blob URL. No global file protocol or broad asset
  server scope is enabled.
- This slice allows **only** Create Folder and Rename. New names reject path
  separators, traversal, invalid Windows characters and reserved device names.
  Existing destination names are not intentionally overwritten. It does not
  implement delete, move, copy, cut/paste, recycle bin or filesystem writes via
  the constellation.
- Opening potentially executable files or shortcuts is blocked by the native
  file-open command. For deliberate executable or advanced system operations,
  use the separate Explorer fallback.
- In browser-only Vite mode Files displays a native-app requirement instead of
  fabricated files. The Windows OS shell, desktop process and taskbar are
  **not** replaced or registered by this feature.

## Tests and validation

```cmd
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
npm.cmd run tauri:dev
```

In the native window test: Home, Documents, a drive root, path entry, back/up,
a folder containing images, selected-image preview, a nonexistent/inaccessible
folder, large folder warning, a new folder, and a rename that collides with an
existing item. Reopen that directory in Windows Explorer to verify the real
changes. Confirm the 3D camera orbit remains where you left it after selecting
different stars. Test Explorer fallback separately.

Windows CI runs JavaScript tests/typecheck/build plus a Rust check with the
development sidecar override. For packaged production builds, first generate
the actual Python sidecar using `python bridge/build_sidecar.py`.

## Next hardening milestones

The first slice is intentionally not a complete Explorer replacement.
Before any Windows shell registration, add paginated directory enumeration,
symlink/junction handling, native OS thumbnails for large media, a recycle-bin
integration with undo/confirmation, copy/move conflict handling, accessibility
audits, keyboard navigation in the star field, path history persistence and
Windows file association tests. Keep a recovery launcher independent of the
React/Tauri app.
