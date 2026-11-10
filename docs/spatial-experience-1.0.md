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

## Fifth dimension: context (X/Y/Z + T + C)

Context is the **fifth coordinate**, not the sixth: three spatial axes,
**T** (the existing fourth-dimensional last-modified-time projection), and
**C** (an explainable, selected-file relationship score).

**Files → Constellation → Ⅴ CONTEXT** offers three independent modes:

| Mode | Behavior |
| --- | --- |
| Off | Original 3D/4D file positions and brightness; context wiring disappears |
| Reveal | Related files are gently pulled/lifted in the 3D projection; evidence-backed lavender lines appear; other stars stay accessible |
| Focus | Stronger emphasis, greater projected separation and dimming of unrelated stars, without deleting or hiding them |

Select a real star and choose a score threshold from **25 to 85**. The
algorithm compares only metadata already returned by the current directory
listing: matching filename stems, shared meaningful filename words, file
extension/kind, and proximity of actual modified timestamps. Each result
contains its precise evidence labels and a bounded **0–100 heuristic score**.
The on-scene Ⅴ panel lists the strongest matches; the inspector lists up to
seven with their specific evidence. Clicking a result selects that real file.

**No confidence or semantic claim:** A score is not probability,
similarity of file contents, proof of dependency, duplicate detection or
confirmed project membership. A missing link does not mean the two files are
unrelated. Generic words are ignored, scores are deterministic, ties sort by
real path, and at most **18 context edges** are rendered per selected star.

Context shares the 180-star limit with the Files Constellation and never
requests another folder, file preview or filesystem scan. It runs entirely
locally in pure TypeScript; no AI embeddings, telemetry or network connections.
The selected anchor, active lens and threshold are session-only view state,
not saved navigation history.

**Composition with time:** On each frame, the 4D projector first obtains
positions from real last-modified timestamps. Context then makes a small,
bounded presentation-only adjustment using coordinate **C**. The GPU file
cores, halos, selection rings, min-map dots and context links update together.
The underlying file path and metadata never change. Changing context mode or
threshold does not recreate the Three.js renderer or reset the camera.

### 5D test and accessibility checklist

1. Use a folder with mixed media and at least three named variants, such as
   `Orbit-mix.wav`, `Orbit-mix.flac` and `Orbit-notes.md`. Select one
   real star and compare the evidence explanations with the filenames.
2. Move the threshold from 25 to 85. Confirm fewer matches appear and no
   threshold creates claims about actual project dependencies.
3. Switch **Off → Reveal → Focus → Off**. Confirm the original 3D/4D
   positions are restored without changing files or the camera.
4. While 4D Time plays, verify the context wires, glow, focus ring and map
   nodes move with their parent star. Pause and scrub manually.
5. Check a directory with unrelated names, unknown modified dates, a single
   file, an empty folder and more than 180 entries. Empty match lists must
   give a clear explanation rather than fabricate links.
6. Verify every contextual result is keyboard-selectable through the inspector
   (and, on large screens, through the on-scene panel); List/Grid remain
   usable with the context lens disabled.
7. Switch FX quality and Windows reduced-motion; the lens and fallback
   List view remain safe. Watch GPU memory when switching folders repeatedly.


## Sixth dimension: Spectrum (X / Y / Z / T / C / S)

**Name:** **Spectrum (S)**. Its animated visual behavior is **Spectral Drift**.

The sixth dimension is **chromatic display state**, not a sixth
independent physical coordinate or an extra filesystem metadata field.
It encodes observations already available in the current folder into
color gradients on each file star:

- **Base hue** = actual file type (folder, image, audio, video, code,
  document, other), retaining the existing muted purple/indigo/blue
  category palette.
- **Gradient brightness/lavender shift** = closeness of an observed
  last-modified timestamp to the active 4D time playhead, plus the
  selected file's already explainable 5D context score.
- **White-violet highlight** = the selected or hovered star.
- **Spectral Drift** = a small, slow decorative hue modulation. Its
  oscillation **is not a new filesystem event or a live activity signal**.

Use **Files → Constellation → Ⅵ SPECTRUM**:

| Mode | Expected behavior |
| --- | --- |
| Off | Solid, existing category star colors. The star geometry's gradient multipliers become uniform white. |
| Gradient | Static two-tone gradient on each GPU-instanced file star. The per-star color updates as you scrub or play time, or change context. |
| Drift (default) | Gradient with very subtle autonomous hue movement. Freezes in reduced-motion mode and during GPU performance degradation; evidence still updates on manual time scrubbing. |

All three modes persist as `AppSettings.fileSpectrumMode` and are
independent from particle quality and context selection. Older saved
settings sanitize to the default; unknown values do not crash the app.

Implementation uses Three.js's existing `InstancedMesh` and built-in
`MeshBasicMaterial.vertexColors`, with one shared vertex-gradient
attribute and one per-file instance tint. This avoids extra WebGL
render passes, additional external textures and third-party shader
packages. The particle halo and top-down mini-map reuse the same
per-star colors. The 3D/4D/5D coordinates and real paths are unchanged.

Missing modification dates do not receive invented temporal color
evidence. Context evidence is still a **bounded heuristic**, not a
probability of shared content or project dependencies. Gradient motion
is a visualization cue only, not an indication of edits happening.

### Sixth-dimensional visual QA

1. Open a mixed directory and compare base colors against the real file
   kind legend. Turn Spectrum Off and confirm solid original colors.
2. Select **Gradient** and verify two-tone color transitions across
   individual star surfaces, rather than only a flat colored glow.
3. Scrub the 4D timeline across known modification dates; nearby
   timestamps should brighten the relevant stars in a deterministic way.
4. Select a file with multiple contextual matches, switch Reveal/Focus,
   then adjust the context threshold. The matching stars' tints and halo
   should reflect the change, without hiding other real files.
5. Enable Drift, pause the 4D timeline, and verify only gentle periodic
   chromatic motion remains. Enable Windows reduced-motion: hue drift
   freezes, but keyboard selection, zoom and scrubbing still work.
6. Compare the real 3D stars, GPU halo points and mini-map colors.
   Switching Off should restore category colors with no camera reset.
7. Repeat on a low-memory GPU and across several folder switches;
   monitor GPU responsiveness and confirm the existing WebGL→List
   fallback and Explorer recovery path remain available.


## Spacetime: GPU-rendered fourth-dimensional field

**Spacetime is a rendering of T (time), not a seventh dimension.** The
existing 4D timeline remains the authoritative control. This optional
GPU visualization adds faint curved contour lines beneath the real file
stars. They respond to the last-modified-time playhead and to selection/
5D context, but they are explicitly **abstract** rather than measured
historical file positions or physical spacetime curvature.

In **Files → Constellation → 4D TIME → Spacetime**, choose:

- **Off:** no contours or extra GPU draw. This is also forced when Particle
  FX is Off, irrespective of the stored Spacetime mode.
- **Contours (default):** a subdued purple-slate field; the GPU vertex
  shader projects selected-file focus wells and 4D playhead curvature
  with no CPU-side line-position updates per frame.
- **Flow:** the same field with slow shader-only phase motion while the
  4D timeline is playing. It freezes on pause, Windows reduced motion,
  or sustained slow-frame degradation. With insufficient distinct file
  timestamps, the field remains static.

The geometry is a single static `LineSegments` buffer. Balanced caps
the field at **9 horizontal + 13 vertical contours × 36 segments**;
Cinematic at **17 + 23 contours × 64 segments**. Both are one draw
call when visible, with restrained alpha (0.12/0.16) and no additive
bloom. All geometry/ShaderMaterial resources are disposed when the
Files constellation unmounts.

In Cinematic mode, file stars now use GPU-calculated faceted lighting,
while Basic materials remain the low-cost alternative in other FX modes.
Bloom is reduced so color/detail stays visible. A broken inverse-order
GLSL `smoothstep` was corrected, per-frame CPU bounding-sphere rebuilds
were replaced with a conservative fixed raycast bound, and constellation
wires now fill a reusable typed buffer without per-frame temporary arrays.
When the adaptive governor degrades quality, the bloom render targets
are disposed immediately to release GPU memory.

### Spacetime and performance validation

1. In a real folder, compare Spacetime Off, Contours and Flow at identical
   camera positions. Confirm subtle lines are *behind* selectable stars
   and do not overpower names or file-type colors.
2. With 4D Time playing, check that contours bend gradually near the
   selected star. Pause time: Flow motion freezes. Scrub dates: the
   field changes phase, but no file positions or timestamps change.
3. Switch Context Focus/Reveal to see a subtle difference in the focus
   well, without falsely asserting actual file dependencies.
4. Switch Particle FX Off: ensure the GPU field is absent and the
   Spacetime selector is visibly disabled. Re-enable Balanced/Cinematic.
5. Test Windows reduced motion, hidden/minimized windows, a single
   undated file, disconnected drives, and repeated folder switching.
6. Compare Task Manager's GPU **3D** engine and process memory while
   navigating or playing time. A higher utilization percentage alone
   is not proof of improved efficiency. Track **frame time**, dropped
   frames and sustained responsiveness under the same viewport/DPI.
7. Validate on the user's actual Windows GPU (CI can compile WebGL
   shaders' source but does not run a browser GPU visual inspection).
