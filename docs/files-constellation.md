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

## Cinematic Constellation FX

**Files → Constellation → Particle FX** exposes three persisted modes:

| Mode | Distant stars | Ambient dust | Mist per group | Bloom |
| --- | ---: | ---: | ---: | --- |
| Off | 0 | 0 | 0 | No |
| Balanced | 1,100 | 260 | 25 | No |
| Cinematic (default) | 2,400 | 820 | 85 | Yes |

Each real file is one GPU-instanced, selectable core, with a shared halo particle
layer. The root star is the currently browsed directory. Category group rings and
labels are **display-only grouping**, not extra files or folders. A single
line-segment mesh encodes membership and intra-cluster connections.

- Cosmetic particles, halos, and links use deterministic seeds and do not
  change Windows file paths or move nodes on disk.
- Orbit/zoom/pan use Three.js OrbitControls; a selected file receives a focus
  ring and active link. Hovering exposes the real file name in a readable tooltip.
- Particle motion freezes for `prefers-reduced-motion`; selected-star
  highlighting still works.
- Renderer DPR is capped at 1.5 for higher tiers. When sustained slow frames
  trigger adaptive fallback, bloom is bypassed and DPR drops. The saved
  preference is **not** overwritten.
- Hidden windows pause animation. Canvas/GPU memory is disposed when the
  view closes. WebGL errors fall back to List view with a visible notice.
- The side list/index remains usable by keyboard, and all 800 loaded entries
  remain accessible in List. The 3D canvas visualizes at most 180 files.
- The decorative global starfield is disabled while Files is open to avoid
  rendering two animated WebGL scenes behind each other.

### Easier zoom and star inspection

The **Files → Constellation** camera now supports fast wheel zoom **toward the
mouse cursor**, plus trackpad/touch pinch. The camera can approach to 1.35 scene
units, instead of stopping at 5.5. Star navigation does not change real files.

The bottom-left zoom strip provides:
- **+ / −**: large-step smooth zoom in/out
- **Focus star**: center the selected, visible file star and move closer
- **Reset**: return to the whole-folder view

Click or Tab into the 3D viewport for keyboard shortcuts: **+ / =** to zoom in,
**−** to zoom out, **F** to focus the selected star, and **0** to reset. These
shortcuts are limited to the focused 3D viewport, so typing in search or path
fields remains unaffected. Direct orbit/pan/pinch/wheel interactions cancel any
in-progress camera animation. Reduced-motion mode jumps without animation.

Zoom safety: the camera distance is clamped to [1.35, 82], camera state stays
preserved during FX/sort changes, and all zoom actions are visual only.

### Visual acceptance checklist

1. Check a mixed folder with images, music, documents and subfolders.
   Every category forms a legible spatial cluster.
2. Try Cinematic, Balanced, Off. Observe mist/particles/bloom change.
3. Click a star, orbit, click another. The camera should **not reset**.
4. Sort by date then by name. Star coordinates should remain stable.
5. Check GPU load on low-end hardware and Windows reduced-motion settings.
6. Leave Files and return. Ensure WebGL resources don't accumulate.
7. Confirm List and Grid still work with 3D unavailable.

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
