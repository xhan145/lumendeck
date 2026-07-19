#!/usr/bin/env node
/**
 * Fetch a relocatable python-build-standalone CPython into
 * src-tauri/resources/python/ so the desktop app (and the portable bundle) can
 * pip-install the managed CUDA torch runtime with NO system Python preinstalled.
 *
 *   node scripts/fetch-python.mjs [--force]
 *
 * Resolves the latest CPython 3.12 `install_only` build for
 * x86_64-pc-windows-msvc from the astral-sh/python-build-standalone GitHub
 * releases, downloads it, SHA256-verifies it against the published checksum, and
 * extracts it. Idempotent: skips when resources/python/VERSION already matches.
 *
 * Env overrides:
 *   LUMENDECK_PBS_URL     direct tarball URL (skips API resolution)
 *   LUMENDECK_PBS_TAG     pin a release tag instead of "latest"
 *   LUMENDECK_PBS_PYVER   pin a Python minor (default "3.12")
 *   GH_TOKEN / GITHUB_TOKEN  used for the GitHub API to avoid rate limits
 *
 * The archive is a trusted, checksum-verified CPython from astral-sh's GitHub
 * releases — the same trust model as Tauri/Node fetching their own toolchains.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RESOURCES = join(ROOT, 'src-tauri', 'resources');
const PY_DIR = join(RESOURCES, 'python');
const VERSION_MARKER = join(PY_DIR, 'VERSION');
const PLATFORM = 'x86_64-pc-windows-msvc';
const PY_MINOR = process.env.LUMENDECK_PBS_PYVER || '3.12';
const FORCE = process.argv.includes('--force');
const API = 'https://api.github.com/repos/astral-sh/python-build-standalone/releases';

function log(m) { console.log(`  [fetch-python] ${m}`); }
function fail(m) { console.error(`\n✗ [fetch-python] ${m}`); process.exit(1); }

function ghHeaders() {
  const h = { 'User-Agent': 'lumendeck-build', Accept: 'application/vnd.github+json' };
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function resolveAsset() {
  if (process.env.LUMENDECK_PBS_URL) {
    const url = process.env.LUMENDECK_PBS_URL;
    return { tarUrl: url, shaUrl: `${url}.sha256`, name: url.split('/').pop() };
  }
  const tag = process.env.LUMENDECK_PBS_TAG;
  const rel = tag ? `${API}/tags/${tag}` : `${API}/latest`;
  const res = await fetch(rel, { headers: ghHeaders() });
  if (!res.ok) fail(`GitHub API ${res.status} resolving the pbs release (${rel})`);
  const release = await res.json();
  const assets = release.assets || [];
  // cpython-3.12.x+YYYYMMDD-x86_64-pc-windows-msvc-install_only.tar.gz — prefer
  // the plain install_only (not -full, -debug, -pgo, or _stripped), highest 3.12.
  const re = new RegExp(`^cpython-${PY_MINOR.replace('.', '\\.')}\\.\\d+\\+\\d+-${PLATFORM}-install_only\\.tar\\.gz$`);
  const tarballs = assets.filter((a) => re.test(a.name)).sort((a, b) => b.name.localeCompare(a.name));
  if (!tarballs.length) fail(`no ${PY_MINOR} install_only ${PLATFORM} asset in release ${release.tag_name}`);
  const tar = tarballs[0];
  // pbs publishes a single combined SHA256SUMS; older releases used per-asset
  // <name>.sha256. Prefer whichever this release has.
  const perAsset = assets.find((a) => a.name === `${tar.name}.sha256`);
  const sums = assets.find((a) => a.name === 'SHA256SUMS');
  return {
    tarUrl: tar.browser_download_url,
    shaUrl: perAsset ? perAsset.browser_download_url : null,
    sumsUrl: sums ? sums.browser_download_url : null,
    name: tar.name,
  };
}

function hashFromSums(text, name) {
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (m && m[2].trim().split('/').pop() === name) return m[1];
  }
  return '';
}

async function download(url, dest) {
  const res = await fetch(url, { headers: { 'User-Agent': 'lumendeck-build' }, redirect: 'follow' });
  if (!res.ok) fail(`download ${res.status} for ${url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

async function main() {
  const asset = await resolveAsset();
  if (!FORCE && existsSync(VERSION_MARKER)) {
    const have = readFileSync(VERSION_MARKER, 'utf8').trim();
    if (have === asset.name && existsSync(join(PY_DIR, 'python.exe'))) {
      log(`already present: ${asset.name} (use --force to re-fetch)`);
      return;
    }
  }
  mkdirSync(RESOURCES, { recursive: true });
  const tmpName = `.${asset.name}`;
  const tmpTar = join(RESOURCES, tmpName);
  log(`downloading ${asset.name}`);
  await download(asset.tarUrl, tmpTar);

  log('verifying SHA256');
  let expected = '';
  if (process.env.LUMENDECK_PBS_SKIP_SHA !== '1') {
    try {
      if (asset.shaUrl) {
        const shaRes = await fetch(asset.shaUrl, { headers: { 'User-Agent': 'lumendeck-build' }, redirect: 'follow' });
        if (shaRes.ok) expected = (await shaRes.text()).trim().split(/\s+/)[0];
      }
      if (!expected && asset.sumsUrl) {
        const sumsRes = await fetch(asset.sumsUrl, { headers: { 'User-Agent': 'lumendeck-build' }, redirect: 'follow' });
        if (sumsRes.ok) expected = hashFromSums(await sumsRes.text(), asset.name);
      }
    } catch { /* handled below */ }
    if (!expected) fail(`no published SHA256 for ${asset.name} (set LUMENDECK_PBS_SKIP_SHA=1 to override)`);
    const got = sha256(tmpTar);
    if (got.toLowerCase() !== expected.toLowerCase()) {
      rmSync(tmpTar, { force: true });
      fail(`SHA256 mismatch: expected ${expected}, got ${got}`);
    }
    log(`SHA256 ok (${got.slice(0, 16)}…)`);
  }

  log('extracting');
  rmSync(PY_DIR, { recursive: true, force: true });
  // Run from RESOURCES with a RELATIVE basename: an absolute Windows path
  // (C:\...) makes GNU tar treat `C:` as a remote host ("Cannot connect to C:").
  // `-xf` auto-detects gzip for both GNU tar and Windows bsdtar.
  try {
    execFileSync('tar', ['-xf', tmpName], { cwd: RESOURCES, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    rmSync(tmpTar, { force: true });
    fail(`tar extraction failed: ${(err.stderr || err.message || '').toString().slice(0, 400)}`);
  }
  rmSync(tmpTar, { force: true });
  const exe = join(PY_DIR, 'python.exe');
  if (!existsSync(exe)) fail(`extraction did not produce ${exe}`);
  writeFileSync(VERSION_MARKER, `${asset.name}\n`, 'utf8');
  log(`ready: ${exe}`);
}

main().catch((err) => fail(err?.stack || String(err)));
