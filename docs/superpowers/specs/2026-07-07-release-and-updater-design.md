# LumenDeck — Real Release + Auto-Updater (2026-07-07, v0.19.0)

Turn the built app into something others can install and keep current: a public GitHub Release
carrying the MSI, a Tauri auto-updater that checks a `latest.json` and installs new versions, a
one-command local release script, and an honest first-run story (unsigned installer). Approved via
brainstorming: public repo · full Tauri updater · skip Authenticode (documented) · local release
script · first release = **v0.19.0**.

## Components

### 1. Tauri updater plugin
- Deps: `tauri-plugin-updater` (Rust, in `src-tauri/Cargo.toml` + registered in `lib.rs`/`main.rs`)
  and `@tauri-apps/plugin-updater` + `@tauri-apps/plugin-process` (JS, for relaunch).
- `tauri.conf.json`: `bundle.createUpdaterArtifacts: true`; `plugins.updater = { endpoints:
  ["https://github.com/xhan145/lumendeck/releases/latest/download/latest.json"], pubkey: "<minisign
  public key>" }`.
- Capabilities: grant `updater:default` + `process:allow-restart` in the app's capability file.

### 2. Signing keypair (free minisign — NOT Authenticode)
- Generated once via `tauri signer generate`. **Public** key committed in `tauri.conf.json`.
  **Private** key + password live only in a gitignored local file / env
  (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) consumed by the release build.
  If the private key is lost, future updates can't be signed for existing installs — storage
  location is documented in the release script + README.
- `.gitignore` must exclude the key file; a pre-release guard aborts if the key is missing or if a
  key-shaped file is staged.

### 3. In-app Updates UI (`src/components/updates/` + a pure core module)
- `src/core/update/version.ts` (pure, tested): `compareSemver(a,b)`, `isNewer(latest, current)`,
  `parseUpdaterManifest(json)` (validates the Tauri `latest.json` shape), `platformKey()`.
- `src/bridge/updater.ts`: a thin wrapper that **feature-detects the Tauri runtime**
  (`isTauri()`), calling `@tauri-apps/plugin-updater`'s `check()` / `downloadAndInstall()` and
  `plugin-process`'s `relaunch()` only in the desktop shell. In the browser/dev it returns a
  `{ available:false, reason:'desktop-only' }` sentinel — never throws.
- **UpdatesCard** (Home/Settings): current version, a Check button, states — checking / up-to-date /
  update-available (version + notes) / downloading (progress) / ready → Relaunch / error (loud).
  A silent check on launch (respects reduced-motion / no nagging: one check, dismissible). Disabled
  with a "desktop app only" note in the browser.

### 4. `latest.json` generator + `npm run release`
- `scripts/release.mjs` (Node, run via `npm run release`):
  1. Guards: git tree clean, current branch, `package.json` version present, tag `vX.Y.Z` not
     already released, signing key env present.
  2. Build: `python bridge/build_sidecar.py` → assert sidecar < 20 MB (v0.15 slimness guard) →
     `npm run build` → `npx tauri build` (with signing env so `.msi.zip` + `.sig` are produced).
  3. Generate `latest.json` in Tauri's schema: `{ version, notes, pub_date,
     platforms: { "windows-x86_64": { signature: <contents of .sig>, url: <release-asset URL of the
     .msi.zip> } } }`.
  4. Publish: `gh release create vX.Y.Z` (title + notes) uploading the **MSI** (for humans),
     the **`.msi.zip`** + **`.sig`** (for the updater), and **`latest.json`**.
- Pure pieces (manifest assembly, asset-URL construction, version/tag guard) factored into
  `scripts/releaseLib.mjs` and unit-tested; the shelling-out stays in `release.mjs`.

### 5. Go public — safely
- Pre-flight: scan git history for secrets (`gh`/grep for key/token patterns, confirm the updater
  private key and any `.env` are gitignored and never committed). Only then
  `gh repo edit xhan145/lumendeck --visibility public`.
- Cut the first Release (v0.19.0) so the updater endpoint resolves to a real `latest.json`.

## Testing & verification
- **Pure unit (vitest)**: `compareSemver`/`isNewer` (ordering, equal, pre-release, malformed),
  `parseUpdaterManifest` (valid + missing-platform + bad-shape → error), `platformKey`. `releaseLib`
  manifest assembly + tag/version guard (Node test or vitest). All existing 465 tests stay green;
  tsc clean.
- **Build**: `npm run build` + `npx tauri build` with signing env produces `LumenDeck_0.19.0_x64_
  en-US.msi` (valid OLE2), a `.msi.zip`, and a matching `.sig`; sidecar stays slim (~8–11 MB MSI).
- **Release smoke**: after publishing, fetch the public `latest.json` URL → 200 + correct schema +
  version 0.19.0; assert the `.msi.zip` asset URL resolves; verify the `.sig` matches the artifact
  with the public key.
- **Updater logic**: with the app pointed at a crafted `latest.json` whose version is higher,
  `parseUpdaterManifest` + `isNewer` report "update available" (unit-level). 
- **Honest limit**: a live A→B auto-upgrade needs a *second* published release; v0.19.0 establishes
  the baseline and proves the check path, but the end-to-end download+install is verified in full
  only at the next release. Stated in the release notes.

## Acceptance
1. `npm run release` builds signed artifacts + `latest.json` and publishes a public GitHub Release
   with the MSI attached.
2. The repo is public; `…/releases/latest/download/latest.json` returns 200 with the v0.19.0
   manifest; the updater private key is NOT in the repo/history.
3. In the desktop app, the Updates card shows the current version and "up to date" against the live
   `latest.json`; in the browser it shows "desktop app only" without error.
4. Unsigned-installer SmartScreen behavior is documented; 465+ tests green; tsc clean; MSI valid.
