/** Small pure helpers shared across the Creative OS modules. */

/** Filesystem-safe slug for folder/file names (mirrors exporter.slugify but dep-free of the DOM module). */
export function slugifyName(text: string, fallback = 'project'): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || fallback;
}

/** Human-readable byte size, e.g. 12.3 KB. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
