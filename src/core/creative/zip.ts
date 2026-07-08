/**
 * Minimal, dependency-free ZIP writer (STORE method — no compression). Produces
 * a spec-valid .zip so the Release Pack Builder can assemble a real structured
 * folder the user can download and unzip, with zero third-party deps (matching
 * LumenDeck's node-native, no-dep philosophy).
 *
 * STORE (method 0) keeps this tiny and correct; release packs are text + a few
 * PNGs, so compression is not worth a dependency.
 */

export interface ZipEntry {
  /** forward-slash path inside the archive, e.g. 'promo/hero_16x9.png' */
  name: string;
  data: Uint8Array;
}

// Precomputed CRC-32 table (IEEE 802.3 polynomial 0xEDB88320).
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const encoder = new TextEncoder();

/** UTF-8 encode a string to bytes (for text entries). */
export function textBytes(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Decode a `data:...;base64,XXXX` URL to raw bytes. Returns empty on non-base64. */
export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return new Uint8Array(0);
  const meta = dataUrl.slice(0, comma);
  const payload = dataUrl.slice(comma + 1);
  if (!meta.includes('base64')) {
    // Percent-encoded text payload.
    try {
      return encoder.encode(decodeURIComponent(payload));
    } catch {
      return encoder.encode(payload);
    }
  }
  return base64ToBytes(payload);
}

function base64ToBytes(b64: string): Uint8Array {
  // Prefer atob in the browser/Tauri webview; fall back to Buffer under node tests.
  // atob throws on a corrupt/truncated payload — swallow it and return empty so a
  // single broken render can never abort a whole release-pack build (matches the
  // "returns empty on non-base64" contract in dataUrlToBytes' doc comment).
  try {
    if (typeof atob === 'function') {
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
      return out;
    }
    const g = globalThis as { Buffer?: { from(s: string, enc: string): Uint8Array } };
    if (g.Buffer) return new Uint8Array(g.Buffer.from(b64, 'base64'));
  } catch {
    /* corrupt base64 → empty */
  }
  return new Uint8Array(0);
}

function writeU32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}
function writeU16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value & 0xffff, true);
}

/**
 * Build a STORE-method ZIP from entries. Uses a fixed DOS timestamp so output is
 * byte-deterministic (testable) rather than wall-clock dependent.
 */
export function zipSync(entries: ZipEntry[]): Uint8Array {
  const files = entries.map((e) => ({ nameBytes: encoder.encode(e.name), data: e.data, crc: crc32(e.data) }));

  const DOS_TIME = 0; // 00:00:00
  const DOS_DATE = 0x21; // 1980-01-01
  const LOCAL_HEADER = 30;
  const CENTRAL_HEADER = 46;
  const EOCD = 22;

  let localSize = 0;
  for (const f of files) localSize += LOCAL_HEADER + f.nameBytes.length + f.data.length;
  let centralSize = 0;
  for (const f of files) centralSize += CENTRAL_HEADER + f.nameBytes.length;

  const total = localSize + centralSize + EOCD;
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);

  const offsets: number[] = [];
  let p = 0;

  // Local file headers + data.
  for (const f of files) {
    offsets.push(p);
    writeU32(view, p, 0x04034b50); // local file header signature
    writeU16(view, p + 4, 20); // version needed
    writeU16(view, p + 6, 0); // flags
    writeU16(view, p + 8, 0); // method: STORE
    writeU16(view, p + 10, DOS_TIME);
    writeU16(view, p + 12, DOS_DATE);
    writeU32(view, p + 14, f.crc);
    writeU32(view, p + 18, f.data.length); // compressed size
    writeU32(view, p + 22, f.data.length); // uncompressed size
    writeU16(view, p + 26, f.nameBytes.length);
    writeU16(view, p + 28, 0); // extra length
    buf.set(f.nameBytes, p + 30);
    buf.set(f.data, p + 30 + f.nameBytes.length);
    p += LOCAL_HEADER + f.nameBytes.length + f.data.length;
  }

  const centralStart = p;
  // Central directory.
  files.forEach((f, i) => {
    writeU32(view, p, 0x02014b50); // central dir signature
    writeU16(view, p + 4, 20); // version made by
    writeU16(view, p + 6, 20); // version needed
    writeU16(view, p + 8, 0); // flags
    writeU16(view, p + 10, 0); // method: STORE
    writeU16(view, p + 12, DOS_TIME);
    writeU16(view, p + 14, DOS_DATE);
    writeU32(view, p + 16, f.crc);
    writeU32(view, p + 20, f.data.length);
    writeU32(view, p + 24, f.data.length);
    writeU16(view, p + 28, f.nameBytes.length);
    writeU16(view, p + 30, 0); // extra length
    writeU16(view, p + 32, 0); // comment length
    writeU16(view, p + 34, 0); // disk number start
    writeU16(view, p + 36, 0); // internal attrs
    writeU32(view, p + 38, 0); // external attrs
    writeU32(view, p + 42, offsets[i]); // local header offset
    buf.set(f.nameBytes, p + 46);
    p += CENTRAL_HEADER + f.nameBytes.length;
  });

  // End of central directory.
  writeU32(view, p, 0x06054b50);
  writeU16(view, p + 4, 0);
  writeU16(view, p + 6, 0);
  writeU16(view, p + 8, files.length);
  writeU16(view, p + 10, files.length);
  writeU32(view, p + 12, centralSize);
  writeU32(view, p + 16, centralStart);
  writeU16(view, p + 20, 0); // comment length

  return buf;
}
