/**
 * Prompt presets — a curated + user-editable library of positive/negative prompt
 * pairs (with optional sampler settings). Pure data + CRUD helpers, React-free
 * and free of any I/O; the store persists them and the UI consumes them.
 *
 * Built-in presets are seeded on first run and flagged `builtin`. Deleting a
 * builtin does NOT remove it — it is marked hidden so it can be restored — while
 * deleting a user preset removes it outright.
 */

/** Optional sampler overrides applied alongside the prompt text. */
export interface PromptPresetSettings {
  steps?: number;
  cfg?: number;
  sampler?: string;
  scheduler?: string;
}

export interface PromptPreset {
  id: string;
  name: string;
  positive: string;
  negative: string;
  tags?: string[];
  settings?: PromptPresetSettings;
  builtin?: boolean;
  /** builtins are hidden (not removed) when "deleted"; user presets never set this */
  hidden?: boolean;
  createdAt: string;
}

const BUILTIN_AT = '2026-07-06T00:00:00.000Z';

/** ~10 curated starter presets covering common looks. */
export const STARTER_PRESETS: PromptPreset[] = [
  {
    id: 'preset-cinematic-photo',
    name: 'Cinematic Photo',
    positive: 'cinematic film still, dramatic lighting, shallow depth of field, 35mm, highly detailed, color graded',
    negative: 'cartoon, illustration, low quality, overexposed, blurry',
    tags: ['photo', 'cinematic'],
    settings: { steps: 30, cfg: 6.5, sampler: 'dpmpp_2m', scheduler: 'karras' },
    builtin: true,
    createdAt: BUILTIN_AT,
  },
  {
    id: 'preset-portrait-photoreal',
    name: 'Portrait Photoreal',
    positive: 'photorealistic portrait, natural skin texture, catchlight in eyes, soft studio lighting, 85mm, sharp focus',
    negative: 'plastic skin, deformed, extra fingers, blurry, lowres',
    tags: ['portrait', 'photo'],
    settings: { steps: 32, cfg: 5.5, sampler: 'dpmpp_2m', scheduler: 'karras' },
    builtin: true,
    createdAt: BUILTIN_AT,
  },
  {
    id: 'preset-anime',
    name: 'Anime',
    positive: 'anime key visual, clean lineart, vibrant cel shading, expressive eyes, detailed background',
    negative: 'photorealistic, 3d render, extra limbs, lowres, jpeg artifacts',
    tags: ['anime', 'illustration'],
    settings: { steps: 26, cfg: 7, sampler: 'euler_a', scheduler: 'normal' },
    builtin: true,
    createdAt: BUILTIN_AT,
  },
  {
    id: 'preset-watercolor',
    name: 'Watercolor',
    positive: 'delicate watercolor painting, soft washes of color, textured paper, loose brush strokes, dreamy',
    negative: 'photo, hard edges, digital noise, oversaturated',
    tags: ['painting', 'illustration'],
    settings: { steps: 24, cfg: 6, sampler: 'euler_a', scheduler: 'karras' },
    builtin: true,
    createdAt: BUILTIN_AT,
  },
  {
    id: 'preset-3d-render',
    name: '3D Render',
    positive: 'octane render, physically based materials, global illumination, subsurface scattering, ultra detailed, 8k',
    negative: 'flat, 2d, sketch, low poly, noise',
    tags: ['3d', 'render'],
    settings: { steps: 28, cfg: 7, sampler: 'dpmpp_2m_sde', scheduler: 'karras' },
    builtin: true,
    createdAt: BUILTIN_AT,
  },
  {
    id: 'preset-product-shot',
    name: 'Product Shot',
    positive: 'studio product photography, seamless background, soft box lighting, crisp reflections, high detail, commercial',
    negative: 'cluttered background, harsh shadows, blurry, lowres, watermark',
    tags: ['product', 'photo'],
    settings: { steps: 30, cfg: 6, sampler: 'dpmpp_2m', scheduler: 'karras' },
    builtin: true,
    createdAt: BUILTIN_AT,
  },
  {
    id: 'preset-pixel-art',
    name: 'Pixel Art',
    positive: 'pixel art, 16-bit, limited palette, crisp pixels, retro game sprite, detailed dithering',
    negative: 'smooth gradients, photorealistic, blurry, antialiased',
    tags: ['pixel', 'retro'],
    settings: { steps: 20, cfg: 7.5, sampler: 'euler', scheduler: 'normal' },
    builtin: true,
    createdAt: BUILTIN_AT,
  },
  {
    id: 'preset-comic-ink',
    name: 'Comic Ink',
    positive: 'comic book ink illustration, bold black outlines, dynamic hatching, halftone shading, high contrast',
    negative: 'photo, soft focus, muted colors, lowres',
    tags: ['comic', 'illustration'],
    settings: { steps: 24, cfg: 7, sampler: 'euler_a', scheduler: 'normal' },
    builtin: true,
    createdAt: BUILTIN_AT,
  },
  {
    id: 'preset-cyberpunk',
    name: 'Cyberpunk',
    positive: 'cyberpunk cityscape, neon signage, rain-slick streets, volumetric fog, moody lighting, ultra detailed',
    negative: 'daylight, pastoral, low contrast, blurry, lowres',
    tags: ['cyberpunk', 'scifi'],
    settings: { steps: 30, cfg: 7, sampler: 'dpmpp_2m_sde', scheduler: 'karras' },
    builtin: true,
    createdAt: BUILTIN_AT,
  },
  {
    id: 'preset-oil-painting',
    name: 'Oil Painting',
    positive: 'classical oil painting, thick impasto brush strokes, rich chiaroscuro, canvas texture, masterful composition',
    negative: 'photo, digital, flat, lowres, jpeg artifacts',
    tags: ['painting', 'classical'],
    settings: { steps: 28, cfg: 6.5, sampler: 'dpmpp_2m', scheduler: 'karras' },
    builtin: true,
    createdAt: BUILTIN_AT,
  },
];

/** Deep-copy the starter set (so callers never mutate the shared constant). */
export function seedStarterPresets(): PromptPreset[] {
  return STARTER_PRESETS.map((p) => ({ ...p, tags: p.tags ? [...p.tags] : undefined, settings: p.settings ? { ...p.settings } : undefined }));
}

/** Presets a user should see: everything not hidden, builtins first. */
export function visiblePresets(list: PromptPreset[]): PromptPreset[] {
  return list.filter((p) => !p.hidden);
}

/**
 * Insert or replace a preset by id. A preset with an existing id is updated in
 * place (preserving order); a new one is appended.
 */
export function savePreset(list: PromptPreset[], preset: PromptPreset): PromptPreset[] {
  const idx = list.findIndex((p) => p.id === preset.id);
  if (idx === -1) return [...list, preset];
  return list.map((p, i) => (i === idx ? preset : p));
}

/**
 * Delete a preset. Builtins are hidden (restorable), user presets are removed.
 * Deleting an unknown id is a no-op.
 */
export function deletePreset(list: PromptPreset[], id: string): PromptPreset[] {
  return list.flatMap((p) => {
    if (p.id !== id) return [p];
    if (p.builtin) return [{ ...p, hidden: true }];
    return [];
  });
}

/** Restore a hidden builtin so it is visible again. */
export function restorePreset(list: PromptPreset[], id: string): PromptPreset[] {
  return list.map((p) => (p.id === id ? { ...p, hidden: false } : p));
}

/** Rename a preset (works for builtins and user presets). */
export function renamePreset(list: PromptPreset[], id: string, name: string): PromptPreset[] {
  return list.map((p) => (p.id === id ? { ...p, name } : p));
}

export function findPreset(list: PromptPreset[], id: string): PromptPreset | undefined {
  return list.find((p) => p.id === id);
}
