# LUMENDECK Spatial Experience 1.0

**Branch:** `ux/shell-first-desktop` · **PR:** #53 (draft)
**Target:** the approved 3D/4D Files Constellation mockup, implemented as a usable native Windows-first Tauri experience.

## Delivered in this milestone

| Area | Implemented behavior |
| --- | --- |
| Spatial visual identity | Preserves the analog deep-purple nebula, faceted 3D stars, time trails and existing Off/Balanced/Cinematic FX. Adds an instanced folder silhouette for every visible **real folder**. No external assets. |
| Real folder navigation | Mounted Windows drives and common local places, actual directory listing, double-clicked folder stars, keyboard-accessible List/Grid, input address, back/up, and clickable breadcrumbs built only from the selected path. |
| Saved spatial views | **Save view** stores the currently opened real folder and its 3D camera position/target. **Bookmark** stores or updates a folder. Saved views appear on the Places rail; clicking one restores its real path and camera. Remove is explicit. |
| Spatial mini-map | Top-down, low-cost 2D canvas drawn from the very same instanced node positions, including 4D shifts. Camera-target crosshair; click a dot to select a real file. Accessible selection is also available in the file index and List mode. |
| Native inspector | Real image previews, bounded (first 24 KiB) text/source preview, read-only metadata, same-kind neighbors from this folder, and an observed modification-date histogram. Explicit Open, Rename and Copy Path actions. |
| 4D time | Preserves real modified timestamps, time scrubber, play/pause, trails, spatial motion and Focus Star. Unknown timestamps are not fabricated. |
| Performance | Preserves 800-entry enumeration and 180-star scene limits, shader particle budgets, DPR cap, hidden-window pause, GPU fallback, adaptive FX. Mini-map repaints at ~9 Hz. Folder glyphs are instanced; previews are bounded. |
| UX safety | No shell registry changes, no silent file changes, no automatic movement, no delete/copy/move, no recursive indexing and no AI access to personal files. Windows Explorer fallback remains independent. |

## Precise interpretation of the visual mockup

The mockup is a design target, not a screenshot of a real user directory. New
screens render **actual** filesystem paths and metadata. Constellation
connections reflect members of the currently listed directory, grouped by file
type. They do not claim arbitrary related projects or file dependency graphs.

The 4D trails are a spatial projection from **last-modified timestamps**, not
reconstructed historical locations, previous file contents or deleted files.
The inspector's miniature chart is an observed **date distribution**, not a
fabricated time-trajectory or audio waveform.

The saved camera angle is an app-local view of one folder. It does not
rename/move files or record all navigation. The currently selected path is
never transmitted to an external API by this feature.

## Local persistence and privacy

- Bookmarks are written only after a user chooses **Bookmark** or **Save view**.
- Storage is the Tauri WebView's localStorage, key
  `lumendeck.files.spatialBookmarks.v1`. Up to 16 entries are retained.
- Entries are validated when read. Invalid JSON, invalid paths, bogus camera
  coordinates and inaccessible storage fail safely.
- Bookmarks contain the actual path and camera numbers. They are **not
  encrypted**; anyone able to read the app's local WebView profile may see
  bookmarked paths. Do not bookmark sensitive locations on a shared PC.
- Removing a view changes only this local saved-view list. It does not delete
  or move an actual folder.
- Text preview is a Rust `spawn_blocking` operation, performed only for a
  selected supported text-like file, bounded at 24 KiB. Unknown and potentially
  executable formats are not auto-opened or auto-previewed.

## Windows launch, PowerShell only

```powershell
Set-Location 'C:\Users\roar\Documents\GitHub\lumendeck'
git switch ux/shell-first-desktop
git pull --ff-only origin ux/shell-first-desktop
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
cmd.exe /d /c 'call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" && npm.cmd run tauri:dev'
```

Do not run `cd /d` or `call` directly in PowerShell.

## Acceptance checks on Windows

1. Open **Files** from Desktop, dock, launcher and NavRail; confirm this opens
   LUMENDECK, not Explorer. Confirm Explorer fallback launches on demand.
2. Browse `C:\`, Documents, a real folder and one nested directory using
   the address bar, breadcrumbs, Up, Back, List, Grid and a 3D folder star.
3. Select a file star and compare inspector path, size, type and last-modified
   date to Explorer. Click one same-kind neighbor; verify it changes selection.
4. Preview a real local PNG or JPEG under 3 MiB. Preview a real `.md` or
   `.ts` file; confirm content is accurate and a file above 24 KiB is
   truncated. Try a binary file and an inaccessible file; confirm no crash.
5. In Constellation orbit, zoom to one folder, **Save view**, visit another
   folder, then choose the saved view. Confirm folder and camera framing are
   restored. Save the same folder again and confirm there is one updated
   bookmark. Remove it; verify the folder still exists.
6. With 4D Time enabled select a star, play, pause and scrub dates. Confirm
   its halo, trail, reticle and mini-map point follow its 3D core. Confirm
   other stars remain selectable through the mini-map and the accessible list.
7. Switch Particle FX Off, Balanced and Cinematic. Confirm camera bookmarks
   survive the switch. Minimize the app and reopen; ensure no render crash.
8. Narrow the window below ~990px; open **Inspector**, then close its drawer.
   At phone-sized width, verify List/Grid remains accessible.
9. Enable Windows reduced motion. Playback must not autoplay, while manual
   temporal scrubbing and list navigation remain usable.
10. Inspect directories with 0, 1, 180 and >800 entries, spaces/Unicode in
    paths, a disconnected drive, UNC share (if available) and read-only files.
    Confirm limits and error messages are honest and no files are modified.
11. After repeated Files/Creative navigation, inspect memory and GPU behavior
    in Task Manager. Validate no sustained accumulation of WebGL contexts
    or leaked image object URLs.

## CI gates

`verify-windows` executes npm unit tests, `tsc --noEmit`, a Vite production
build, `cargo check` and real native Rust filesystem unit tests, using the
development-sidecar override. The branch's latest run must pass before
promoting this PR from draft.

These checks validate code and Windows compilation, **not** GPU visual fidelity
or hands-on usability. Screenshots/performance observations from the user's
Windows machine remain required for final 1.0 release sign-off.

## Deliberate non-goals and follow-up work

- No Explorer/system-shell replacement, registry changes, taskbar or desktop
  process takeover.
- No recursive disk atlas or inferred project relationship database.
- No real file-version history or deleted-file time travel.
- No full audio waveform renderer, media editing, general scripting or
  executable launch from the file preview.
- No drag/drop, cut/copy/paste, bulk moves or recycle-bin operations before
  conflict-handling, undo and permission reviews.
- No cloud sync, tracking, AI indexing, telemetry or background file crawling.

Future expansion should follow these safety boundaries rather than trading
filesystem accuracy for more impressive visual effects.
