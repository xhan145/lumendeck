# Releasing LumenDeck + the auto-updater

LumenDeck ships a public GitHub Release carrying the Windows MSI plus the Tauri
updater artifacts, so installed copies can check for and install new versions.

## One-command release

```bash
npm run release
```

`scripts/release.mjs` runs the whole pipeline (it does nothing until the guards
below pass):

1. **Guards** — git tree clean, `package.json` version present, tag `vX.Y.Z` not
   already released, and the signing key env vars set.
2. **Build** — bundle the Python sidecar (asserted `< 20 MB`), `npm run build`,
   then `npx tauri build` with the signing env so the `.msi.zip` + `.sig` updater
   artifacts are produced alongside the `.msi`.
3. **Manifest** — write `latest.json` in Tauri's schema (`scripts/releaseLib.mjs`).
4. **Publish** — `gh release create vX.Y.Z` uploading the **MSI** (for humans),
   the **`.msi.zip`** + **`.sig`** (for the updater), and **`latest.json`**.

The updater endpoint the app polls is:

```
https://github.com/xhan145/lumendeck/releases/latest/download/latest.json
```

## Signing keys (free minisign — NOT Authenticode)

The updater verifies each download against a **minisign** public key embedded in
`src-tauri/tauri.conf.json` (`plugins.updater.pubkey`). This is separate from OS
code-signing — see SmartScreen below.

- **Public key**: committed in `tauri.conf.json`. Safe to share.
- **Private key**: secret, stored **outside the repo** at
  `~/.tauri/lumendeck-updater.key` (gitignored via `*.key` + `.tauri/`). Generated
  once with:

  ```bash
  npx tauri signer generate -w ~/.tauri/lumendeck-updater.key
  ```

- The release build reads two env vars:

  ```bash
  export TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/lumendeck-updater.key"
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="********"
  ```

> **Lose the private key = no more updates.** If the key (or its password) is
> lost, you can never sign an update that existing installs will accept — they get
> stranded on their current version and users must reinstall from a fresh MSI.
> Back the key up in a password manager / encrypted vault. **Never commit it.**

## Unsigned installer / SmartScreen

The MSI is **not** Authenticode code-signed (that requires a paid certificate).
On first run Windows SmartScreen may warn "Windows protected your PC". Users can
proceed via **More info → Run anyway**. This is expected and documented in the
release notes. The minisign updater signature above is unrelated to SmartScreen —
it only protects the update channel, not the initial install.

## First release note (v0.19.0)

The first release establishes the baseline and proves the *check* path (the app
can reach `latest.json` and report "up to date"). A full end-to-end
download+install upgrade can only be verified once a **second** release exists to
upgrade to.
