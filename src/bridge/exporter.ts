/** Client-side file downloads for renders and reproducibility manifests. */

function triggerDownload(href: string, filename: string): void {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function downloadJson(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  triggerDownload(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadDataUrl(dataUrl: string, filename: string): void {
  triggerDownload(dataUrl, filename);
}

/** Save arbitrary text (e.g. a self-contained showcase HTML file) to disk. */
export function downloadText(text: string, filename: string, mime = 'text/html'): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  triggerDownload(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Save base64-encoded BINARY (e.g. a frame-sequence ZIP) via a Blob object URL.
 * A raw `data:` URL on an <a download> can exceed WebView2/Chromium's ~2MB URL
 * length and fail SILENTLY, so decode to bytes and download a blob: URL instead.
 */
export function downloadBase64(base64: string, filename: string, mime = 'application/octet-stream'): void {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  triggerDownload(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Filesystem-safe slug from a prompt for use in filenames. */
export function slugify(text: string, fallback = 'render'): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || fallback;
}
