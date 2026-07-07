#!/usr/bin/env node
/**
 * LumenDeck one-command release: build signed artifacts + latest.json, then
 * publish a public GitHub Release.  Run with:  npm run release
 *
 * ---------------------------------------------------------------------------
 * SIGNING ENVIRONMENT (required — the build fails without these)
 * ---------------------------------------------------------------------------
 * The updater signs each artifact with a free **minisign** keypair (NOT
 * Authenticode — the installer is unsigned; SmartScreen is documented in
 * docs/RELEASING.md).  The PUBLIC key is committed in src-tauri/tauri.conf.json.
 * The PRIVATE key is secret and lives OUTSIDE the repo:
 *
 *     ~/.tauri/lumendeck-updater.key        (gitignored; the file itself)
 *
 * `npx tauri build` reads two env vars to sign the update artifacts:
 *
 *     TAURI_SIGNING_PRIVATE_KEY            path to (or contents of) the .key file
 *     TAURI_SIGNING_PRIVATE_KEY_PASSWORD   the password chosen at key generation
 *
 * Set them for the release shell, e.g. (bash):
 *     export TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/lumendeck-updater.key"
 *     export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="********"
 *
 * WARNING: if the private key is lost, updates can NEVER be signed for existing
 * installs again — they would be stranded on their current version.  Back it up
 * somewhere safe (a password manager / encrypted vault), never in the repo.
 *
 * The keypair is generated once with:  npx tauri signer generate -w ~/.tauri/lumendeck-updater.key
 * ---------------------------------------------------------------------------
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLatestJson, buildAssetUrl, guardVersionTag } from './releaseLib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SIDECAR_MAX_BYTES = 20 * 1024 * 1024; // 20 MB slimness guard (v0.15)

function step(msg) {
  console.log(`\n→ ${msg}`);
}
function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}
function run(cmd, args, opts = {}) {
  console.log(`  $ ${cmd} ${args.join(' ')}`);
  return execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
}
function capture(cmd, args) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

// 1. GUARDS ----------------------------------------------------------------
step('Guard: git tree is clean');
const gitStatus = capture('git', ['status', '--porcelain']);
if (gitStatus) fail('Working tree is dirty. Commit or stash before releasing.');

step('Guard: read package.json version');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
if (!version) fail('package.json has no "version".');
const tag = `v${version}`;
guardVersionTag(version, tag); // throws on mismatch (defensive)
console.log(`  version=${version}  tag=${tag}`);

step('Guard: tag not already released');
let existingTags = '';
try {
  existingTags = capture('git', ['tag', '--list', tag]);
} catch {
  /* no tags yet */
}
if (existingTags === tag) fail(`Tag ${tag} already exists locally. Bump the version first.`);
try {
  const releases = capture('gh', ['release', 'list', '--json', 'tagName']);
  if (releases.includes(`"${tag}"`)) fail(`Release ${tag} already exists on GitHub.`);
} catch {
  console.log('  (gh release list skipped — continuing)');
}

step('Guard: signing key env present');
if (!process.env.TAURI_SIGNING_PRIVATE_KEY || !process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
  fail(
    'Missing TAURI_SIGNING_PRIVATE_KEY / TAURI_SIGNING_PRIVATE_KEY_PASSWORD.\n' +
      '  See the header of this file — the private key lives at ~/.tauri/lumendeck-updater.key.',
  );
}

// 2. BUILD -----------------------------------------------------------------
step('Build: bundle the Python sidecar');
run('python', ['bridge/build_sidecar.py']);

step('Guard: sidecar stays slim (< 20 MB)');
const sidecarCandidates = [
  join(ROOT, 'src-tauri', 'binaries', 'lumendeck-bridge.exe'),
  join(ROOT, 'src-tauri', 'binaries', 'lumendeck-bridge-x86_64-pc-windows-msvc.exe'),
];
const sidecar = sidecarCandidates.find((p) => existsSync(p));
if (!sidecar) fail(`Sidecar binary not found in src-tauri/binaries after build.`);
const sidecarBytes = statSync(sidecar).size;
console.log(`  ${sidecar} = ${(sidecarBytes / 1024 / 1024).toFixed(1)} MB`);
if (sidecarBytes > SIDECAR_MAX_BYTES) fail('Sidecar exceeds the 20 MB slimness budget.');

step('Build: frontend (npm run build)');
run('npm', ['run', 'build']);

step('Build: signed desktop bundle (npx tauri build)');
run('npx', ['tauri', 'build']);

// 3. LOCATE ARTIFACTS ------------------------------------------------------
// Tauri v2 signs the .msi DIRECTLY: it emits `<name>.msi` + `<name>.msi.sig`
// (there is no .msi.zip — that was v1). The updater downloads the .msi and
// verifies it against the .sig. The bundle dir accumulates every version's MSI,
// so match THIS version's files exactly, not the first .msi alphabetically.
step('Locate: this version\'s .msi + .msi.sig under src-tauri/target/release/bundle');
const bundleDir = join(ROOT, 'src-tauri', 'target', 'release', 'bundle', 'msi');
if (!existsSync(bundleDir)) fail(`Bundle dir not found: ${bundleDir}`);
const files = readdirSync(bundleDir);
const msi = files.find((f) => f.includes(`_${version}_`) && f.endsWith('.msi'));
const sig = msi ? `${msi}.sig` : undefined;
if (!msi) fail(`No .msi for ${version} found (is bundle.targets = ["msi"]?).`);
if (!sig || !existsSync(join(bundleDir, sig)))
  fail('No .msi.sig found (is bundle.createUpdaterArtifacts = true and the signing env set?).');
console.log(`  msi=${msi}\n  sig=${sig}`);

// 4. GENERATE latest.json --------------------------------------------------
step('Generate: latest.json');
const sigContents = readFileSync(join(bundleDir, sig), 'utf8').trim();
const assetUrl = buildAssetUrl(version, msi);
const notes =
  process.env.LUMENDECK_RELEASE_NOTES ||
  `LumenDeck ${version}. See the GitHub release page for details.`;
const latest = buildLatestJson({
  version,
  notes,
  pubDate: new Date().toISOString(),
  sigContents,
  assetUrl,
});
const latestPath = join(bundleDir, 'latest.json');
writeFileSync(latestPath, JSON.stringify(latest, null, 2), 'utf8');
console.log(`  wrote ${latestPath}`);

// 5. PUBLISH ---------------------------------------------------------------
step(`Publish: gh release create ${tag}`);
run('gh', [
  'release',
  'create',
  tag,
  join(bundleDir, msi), // human installer AND updater artifact (v2 signs the .msi)
  join(bundleDir, sig), // updater signature (.msi.sig)
  latestPath, // updater manifest
  '--title',
  `LumenDeck ${version}`,
  '--notes',
  notes,
]);

console.log(`\n✓ Released ${tag}. latest.json:`);
console.log(`  https://github.com/xhan145/lumendeck/releases/latest/download/latest.json`);
