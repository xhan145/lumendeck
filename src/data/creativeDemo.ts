/**
 * Creative OS seed/demo data. Tells a two-project story: one CHAOTIC project
 * (missing brief, broken links, orphaned + unused prompts, no exports) and one
 * RELEASE-READY project (full identity, all promo aspects, copy, a shipped
 * release pack, a published link). Seeding also inserts a few tiny SVG renders
 * into the gallery so the release-ready project's assets actually resolve and it
 * appears in Proof Mode.
 *
 * Deterministic: callers pass `now`. Ids are fixed strings (demo_*) so re-seeds
 * are idempotent-ish and easy to spot.
 */
import type { GalleryItem } from '../state/store';
import type { ExportManifest } from '../core/manifest';
import type { CreativeRecipe, ProjectBrain } from '../core/creative/types';
import { createRecipe } from '../core/creative/recipes';

/** A small labeled gradient SVG as a data URL — renders as an <img>, zips as text. */
function gradientSvg(w: number, h: number, c1: string, c2: string, label: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/><text x="50%" y="50%" fill="#ffffff" font-family="sans-serif" font-size="${Math.round(Math.min(w, h) / 8)}" text-anchor="middle" dominant-baseline="middle" opacity="0.85">${label}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function manifest(prompt: string, width: number, height: number, at: string): ExportManifest {
  return {
    app: 'LumenDeck',
    appVersion: 'demo',
    createdAt: at,
    prompt,
    negativePrompt: 'blurry, low quality',
    resolvedPrompt: prompt,
    wildcards: [],
    seed: 1234,
    sampler: { name: 'euler', steps: 24, cfg: 6 },
    canvas: { width, height },
    media: { type: 'image', format: 'svg', frameCount: 1, fps: 0 },
    model: { id: 'ckpt-lumen-xl', name: 'Lumen XL', family: 'sdxl', hash: 'demo' },
    loras: [],
    controlNets: [],
    graphVersion: 1,
    graph: { id: 'demo', name: 'demo', version: 1, schemaVersion: 1, nodes: [], edges: [] },
  };
}

interface DemoBundle {
  brains: ProjectBrain[];
  recipes: CreativeRecipe[];
  renders: GalleryItem[];
}

export function buildCreativeDemo(now: Date): DemoBundle {
  const at = now.toISOString();
  const earlier = new Date(now.getTime() - 40 * 86_400_000).toISOString(); // 40 days ago (stale)

  // ---- gallery renders backing the release-ready project ----
  const renders: GalleryItem[] = [
    {
      id: 'demo_r_logo',
      dataUrl: gradientSvg(1024, 1024, '#34d6f4', '#a78bfa', 'AURORA'),
      mediaType: 'image', mimeType: 'image/svg+xml', extension: 'svg', createdAt: at,
      manifest: manifest('aurora type brand logo, luminous monogram', 1024, 1024, at),
      collectionId: null, tags: ['logo', 'brand'],
    },
    {
      id: 'demo_r_16x9',
      dataUrl: gradientSvg(1280, 720, '#1a73e8', '#34d6f4', '16:9'),
      mediaType: 'image', mimeType: 'image/svg+xml', extension: 'svg', createdAt: at,
      manifest: manifest('aurora hero banner, wide cinematic key art', 1280, 720, at),
      collectionId: null, tags: ['promo', 'hero'],
    },
    {
      id: 'demo_r_1x1',
      dataUrl: gradientSvg(1024, 1024, '#a78bfa', '#ff8a00', '1:1'),
      mediaType: 'image', mimeType: 'image/svg+xml', extension: 'svg', createdAt: at,
      manifest: manifest('aurora square feed post, bold centered mark', 1024, 1024, at),
      collectionId: null, tags: ['promo', 'social'],
    },
    {
      id: 'demo_r_9x16',
      dataUrl: gradientSvg(720, 1280, '#ff8a00', '#a78bfa', '9:16'),
      mediaType: 'image', mimeType: 'image/svg+xml', extension: 'svg', createdAt: at,
      manifest: manifest('aurora vertical story, tall gradient splash', 720, 1280, at),
      collectionId: null, tags: ['promo', 'story'],
    },
    {
      // Unlabeled + only loosely tied — demonstrates entropy in the chaotic project.
      id: 'demo_r_nebula1',
      dataUrl: gradientSvg(1024, 1024, '#222835', '#60a5fa', 'NEBULA'),
      mediaType: 'image', mimeType: 'image/svg+xml', extension: 'svg', createdAt: earlier,
      manifest: manifest('nebula runner splash concept', 1024, 1024, earlier),
      collectionId: null, tags: [],
    },
  ];

  // ---- recipes ----
  const neonPoster = createRecipe('Neon Poster', now, {
    persona: 'Bold indie art director',
    styleTags: ['neon', 'high-contrast', 'cinematic', 'volumetric light'],
    modelId: 'ckpt-lumen-xl',
    promptTemplate: '{subject}, neon-drenched poster, dramatic rim light, ultra detailed',
    negativePrompt: 'flat, dull, low contrast, watermark',
    aspectRatios: ['16:9', '1:1'],
    exportTargets: ['itch', 'x'],
    brandColors: ['#34d6f4', '#a78bfa'],
    successScore: 4,
  });
  const softProduct = createRecipe('Soft Product Shot', now, {
    persona: 'Calm product photographer',
    styleTags: ['soft light', 'minimal', 'pastel', 'studio'],
    modelId: 'ckpt-lumen-xl',
    promptTemplate: '{subject}, soft studio light, minimal pastel background, product photography',
    negativePrompt: 'harsh shadows, clutter, noise',
    aspectRatios: ['1:1'],
    exportTargets: ['shopify', 'instagram'],
    brandColors: ['#e6e1e5', '#ff8a00'],
    successScore: 3,
  });
  const verticalStory = createRecipe('Vertical Story', now, {
    persona: 'Fast-moving social editor',
    styleTags: ['vertical', 'bold type', 'gradient'],
    modelId: '',
    promptTemplate: '{subject}, vertical story format, bold gradient, punchy composition',
    negativePrompt: 'busy, tiny text',
    aspectRatios: ['9:16'],
    exportTargets: ['instagram'],
    brandColors: ['#ff8a00', '#a78bfa'],
    successScore: 5,
  });
  const recipes = [neonPoster, softProduct, verticalStory];

  // ---- CHAOTIC project ----
  const nebula: ProjectBrain = {
    id: 'demo_proj_nebula',
    schemaVersion: 1,
    name: 'Nebula Runner',
    type: 'app',
    status: 'in-progress',
    identity: { logline: '', audience: '', promise: '' }, // no brief -> blocker
    style: { styleTags: ['space', 'retro'], palette: ['#60a5fa'], mood: '' },
    activeGoals: ['Nail the key art'],
    assets: [
      { id: 'demo_as_nebula_broken', label: 'Old splash export', kind: 'promo', path: 'C:/old/splash.png', status: 'broken', addedAt: earlier },
    ],
    prompts: [
      { id: 'demo_pr_nebula_used', text: 'nebula runner splash concept', addedAt: earlier, lastProducedAt: earlier },
      { id: 'demo_pr_nebula_unused', text: 'pixel spaceship boss fight, dramatic', addedAt: earlier }, // no output -> stale + prompt-without-output
    ],
    renders: ['demo_r_nebula1', 'demo_r_ghost_missing'], // second id does not exist -> orphaned-render-link
    recipes: [],
    exports: [],
    copy: { shortDescription: '', longDescription: '', githubDescription: '', readmeSection: '', pressSummary: '', socialCaptions: [] },
    publishedLinks: [],
    events: [
      { id: 'demo_ev_n1', at: earlier, type: 'created', label: 'Project "Nebula Runner" created' },
      { id: 'demo_ev_n2', at: earlier, type: 'prompt-added', label: 'Added prompt: nebula runner splash' },
      { id: 'demo_ev_n3', at: earlier, type: 'render-linked', label: 'Linked a render' },
      { id: 'demo_ev_n4', at, type: 'note', label: 'Picked back up after a break' },
    ],
    statusHistory: [{ at: earlier, from: 'spark', to: 'in-progress' }],
    createdAt: earlier,
    updatedAt: at,
    lastOpenedAt: at,
  };

  // ---- RELEASE-READY project ----
  const aurora: ProjectBrain = {
    id: 'demo_proj_aurora',
    schemaVersion: 1,
    name: 'Aurora Type',
    type: 'brand',
    status: 'release-ready',
    identity: {
      logline: 'A luminous display typeface for late-night makers.',
      audience: 'indie designers and studios',
      promise: 'Type that glows on dark canvases without shouting.',
    },
    style: { styleTags: ['luminous', 'editorial', 'calm', 'high-contrast'], palette: ['#34d6f4', '#a78bfa', '#ff8a00'], mood: 'calm, confident, midnight' },
    activeGoals: ['Ship the specimen site', 'Post launch thread'],
    assets: [
      { id: 'demo_as_aurora_logo', label: 'Aurora logo', kind: 'logo', galleryId: 'demo_r_logo', status: 'ok', addedAt: at },
      { id: 'demo_as_aurora_hero', label: 'Hero banner', kind: 'promo', galleryId: 'demo_r_16x9', status: 'ok', addedAt: at },
      { id: 'demo_as_aurora_ref', label: 'Moodboard', kind: 'reference', path: 'moodboard.pdf', status: 'ok', addedAt: at },
    ],
    prompts: [
      { id: 'demo_pr_aurora_1', text: 'aurora type brand logo, luminous monogram', addedAt: at, lastProducedAt: at },
      { id: 'demo_pr_aurora_2', text: 'aurora hero banner, wide cinematic key art', addedAt: at, lastProducedAt: at },
    ],
    renders: ['demo_r_logo', 'demo_r_16x9', 'demo_r_1x1', 'demo_r_9x16'],
    recipes: [neonPoster.id],
    exports: [
      { id: 'demo_exp_aurora', kind: 'release-pack', label: 'Release Pack (11/13 slots)', fileName: 'aurora-type-release-pack.zip', at, itemCount: 13, bytes: 48213 },
    ],
    copy: {
      shortDescription: 'Aurora Type — a luminous display typeface for late-night makers.',
      longDescription: 'Aurora Type is a display typeface built for dark interfaces and midnight work sessions. It glows without shouting, pairs cleanly with UI text, and ships with a full specimen.\n\nGoals:\n- Ship the specimen site\n- Post launch thread',
      githubDescription: 'A luminous display typeface for late-night makers. Glows on dark canvases without shouting.',
      readmeSection: '# Aurora Type\n\nA luminous display typeface for late-night makers.\n\n## What it does\n\nType that glows on dark canvases without shouting.\n\n_Made with LumenDeck._',
      pressSummary: 'FOR IMMEDIATE RELEASE\n\nAurora Type\nA luminous display typeface for late-night makers.\nAimed at indie designers and studios.',
      socialCaptions: [
        'Introducing Aurora Type — a luminous display typeface for late-night makers. #luminous #madeWithLumenDeck',
        'Aurora Type is here. Type that glows on dark canvases. #editorial #madeWithLumenDeck',
      ],
    },
    publishedLinks: [{ id: 'demo_ln_aurora', label: 'Specimen site', url: 'https://example.com/aurora', addedAt: at }],
    events: [
      { id: 'demo_ev_a1', at: earlier, type: 'created', label: 'Project "Aurora Type" created' },
      { id: 'demo_ev_a2', at: earlier, type: 'identity-updated', label: 'Wrote the brief' },
      { id: 'demo_ev_a3', at, type: 'render-linked', label: 'Linked hero + logo renders' },
      { id: 'demo_ev_a4', at, type: 'captions-updated', label: 'Generated social captions' },
      { id: 'demo_ev_a5', at, type: 'export-built', label: 'Built release pack (11/13)' },
      { id: 'demo_ev_a6', at, type: 'status-changed', label: 'Status: polishing → release-ready' },
      { id: 'demo_ev_a7', at, type: 'link-published', label: 'Published: Specimen site' },
    ],
    statusHistory: [
      { at: earlier, from: 'spark', to: 'in-progress' },
      { at, from: 'in-progress', to: 'polishing' },
      { at, from: 'polishing', to: 'release-ready' },
    ],
    createdAt: earlier,
    updatedAt: at,
    lastOpenedAt: at,
  };

  return { brains: [nebula, aurora], recipes, renders };
}
