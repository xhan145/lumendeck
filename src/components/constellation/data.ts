import { CAPSULES, CAPSULE_KINDS, CAPSULE_CATEGORY_LABELS } from '../../core/capsules';
import type { CapsuleCategory, CapsuleKind } from '../../core/types';
import type { ProjectBrain, CreativeRecipe, ProjectStatus } from '../../core/creative/types';
import type { ConstellationNode, ConstellationNodeStatus } from './types';

/**
 * Builds the LumenDeck capability constellation from REAL product data — the
 * capsule registry, the live Creative OS slice, and the gallery — so the sky is
 * an honest map of what the product can do, not marketing set-dressing. PURE:
 * all data and the CSS-var color resolver are injected, so this is fully
 * unit-testable in the node environment.
 *
 * The "Open Core" branch is the FREE/OPEN statement expressed as data: each
 * satellite there corresponds to an invariant that is literally enforced in
 * code (localOnlyMode/telemetryDisabled are hardcoded `true` in AppSettings).
 */

export interface ConstellationDataInput {
  brains?: readonly ProjectBrain[];
  recipes?: readonly CreativeRecipe[];
  /** Gallery summary: total renders + per-collection counts. */
  galleryCount?: number;
  collections?: readonly { id: string; name: string; count: number }[];
  /** Resolves 'var(--token)' CSS colors to concrete values (identity in tests). */
  resolve?: (color: string) => string;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

const BRAIN_STATUS: Record<ProjectStatus, ConstellationNodeStatus> = {
  spark: 'forming',
  'in-progress': 'active',
  polishing: 'active',
  'release-ready': 'complete',
  shipped: 'complete',
  archived: 'dormant',
};

function capsuleLeaf(kind: CapsuleKind, resolve: (c: string) => string, categoryColor: string): ConstellationNode {
  const def = CAPSULES[kind];
  return {
    id: `capsule-${kind}`,
    label: def.title,
    description: def.description,
    colors: [resolve(def.accent), categoryColor],
    type: 'tool',
    status: 'active',
    strength: 0.45,
  };
}

function studioBranch(resolve: (c: string) => string): ConstellationNode {
  const byCategory = new Map<CapsuleCategory, CapsuleKind[]>();
  for (const kind of CAPSULE_KINDS) {
    const cat = CAPSULES[kind].category;
    const list = byCategory.get(cat) ?? [];
    list.push(kind);
    byCategory.set(cat, list);
  }
  const violet = resolve('var(--ld-violet)');
  const children: ConstellationNode[] = [];
  for (const [category, kinds] of byCategory) {
    const categoryColor = resolve(CAPSULES[kinds[0]].accent);
    children.push({
      id: `category-${category}`,
      label: CAPSULE_CATEGORY_LABELS[category],
      description: `${kinds.length} ${kinds.length === 1 ? 'capsule' : 'capsules'} — wire them into the executable recipe graph.`,
      colors: [categoryColor, violet],
      type: 'addon',
      status: 'active',
      strength: clamp01(0.3 + kinds.length / 12),
      children: kinds.map((k) => capsuleLeaf(k, resolve, categoryColor)),
    });
  }
  return {
    id: 'studio',
    label: 'Studio Graph',
    description: `A node-native diffusion studio: ${CAPSULE_KINDS.length} capsules across ${byCategory.size} families, all wired into one executable graph.`,
    colors: [resolve('var(--cap-sampler)'), resolve('var(--cap-model)')],
    type: 'mission',
    status: 'active',
    strength: 0.95,
    children,
  };
}

function conceptLeaves(
  parentId: string,
  color: string,
  altColor: string,
  items: [string, string][],
): ConstellationNode[] {
  return items.map(([label, description], i) => ({
    id: `${parentId}-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    label,
    description,
    colors: [color, altColor] as [string, string],
    type: 'tool' as const,
    status: 'active' as const,
    strength: 0.4 + (i % 3) * 0.1,
  }));
}

function creativeBranch(input: ConstellationDataInput, resolve: (c: string) => string): ConstellationNode {
  const mango = resolve('var(--ld-mango)');
  const violet = resolve('var(--ld-violet)');
  const brains = input.brains ?? [];
  const recipes = input.recipes ?? [];
  const children: ConstellationNode[] = [];
  for (const brain of brains) {
    children.push({
      id: `brain-${brain.id}`,
      label: brain.name,
      description: brain.identity?.logline || `${brain.type} project — ${brain.status.replace('-', ' ')}.`,
      colors: [(brain.style?.palette?.[0] as string) || mango, violet],
      type: 'mission',
      status: BRAIN_STATUS[brain.status] ?? 'active',
      strength: clamp01(0.35 + (brain.renders?.length ?? 0) / 12),
    });
  }
  for (const recipe of recipes) {
    children.push({
      id: `recipe-${recipe.id}`,
      label: recipe.name,
      description: recipe.persona ? `Recipe · ${recipe.persona}` : 'A reusable creative recipe.',
      colors: [(recipe.brandColors?.[0] as string) || resolve('var(--cap-export)'), violet],
      type: 'evidence',
      status: 'active',
      strength: clamp01(0.3 + (recipe.successScore ?? 0) / 5),
    });
  }
  if (children.length === 0) {
    children.push(
      ...conceptLeaves('creative', mango, violet, [
        ['Project Brains', 'Living project memory: goals, assets, prompts, renders, and a readiness score.'],
        ['Creative Recipes', 'Reusable persona + style + model bundles you can apply in one move.'],
        ['Entropy Sweeps', 'Find the duplicates, orphans, and dead ends hiding in a growing project.'],
        ['Proof Packs', 'Evidence-grade exports: what was made, how, and with which settings.'],
      ]),
    );
  }
  return {
    id: 'creative',
    label: 'Creative OS',
    description:
      brains.length > 0
        ? `${brains.length} living ${brains.length === 1 ? 'project' : 'projects'} and ${recipes.length} ${recipes.length === 1 ? 'recipe' : 'recipes'} orbit here.`
        : 'Projects as living systems — brains, recipes, readiness, and release packs.',
    colors: [mango, violet],
    type: 'mission',
    status: brains.length > 0 ? 'active' : 'forming',
    strength: clamp01(0.5 + brains.length / 8),
    children,
  };
}

function galleryBranch(input: ConstellationDataInput, resolve: (c: string) => string): ConstellationNode {
  const cyan = resolve('var(--ld-cyan)');
  const mint = resolve('var(--ld-ok)');
  const total = input.galleryCount ?? 0;
  const collections = input.collections ?? [];
  const children: ConstellationNode[] = collections.map((c) => ({
    id: `collection-${c.id}`,
    label: c.name,
    description: `${c.count} ${c.count === 1 ? 'render' : 'renders'} in this collection.`,
    colors: [mint, cyan] as [string, string],
    type: 'evidence' as const,
    status: 'active' as const,
    strength: clamp01(0.3 + c.count / 24),
  }));
  // Renders default to collectionId null (and deleting a collection re-files its
  // renders as null) — surface them honestly instead of pretending nothing exists.
  const categorized = collections.reduce((sum, c) => sum + c.count, 0);
  const uncategorized = Math.max(0, total - categorized);
  if (uncategorized > 0) {
    children.push({
      id: 'gallery-uncategorized',
      label: 'Uncategorized',
      description: `${uncategorized} ${uncategorized === 1 ? 'render' : 'renders'} not yet filed into a collection.`,
      colors: [mint, cyan],
      type: 'evidence',
      status: 'active',
      strength: clamp01(0.3 + uncategorized / 24),
    });
  }
  // The frontier placeholder appears only when there is truly nothing yet.
  if (total === 0 && children.length === 0) {
    children.push({
      id: 'gallery-frontier',
      label: 'Awaiting First Render',
      description: 'Everything you make lands here — durable, local, and honestly labeled.',
      colors: [mint, cyan],
      type: 'evidence',
      status: 'forming',
      strength: 0.3,
    });
  }
  return {
    id: 'gallery',
    label: 'Gallery',
    description:
      total > 0
        ? `${total} ${total === 1 ? 'render' : 'renders'} archived durably on your machine — collections, tags, honest fallback labels.`
        : 'A durable render archive in IndexedDB — collections, tags, and honest fallback labeling.',
    colors: [mint, cyan],
    type: 'evidence',
    status: total > 0 ? 'active' : 'forming',
    strength: clamp01(0.4 + total / 60),
    children,
  };
}

/** Build the full capability constellation. Safe with a completely empty store. */
export function buildLumenConstellation(input: ConstellationDataInput = {}): ConstellationNode {
  const resolve = input.resolve ?? ((c: string) => c);
  const cyan = resolve('var(--ld-cyan)');
  const violet = resolve('var(--ld-violet)');
  const mint = resolve('var(--ld-ok)');
  const mango = resolve('var(--ld-mango)');

  const openCore: ConstellationNode = {
    id: 'open-core',
    label: 'Open Core',
    description: 'The promises the product is built on — enforced in code, not marketing.',
    colors: [mint, cyan],
    type: 'core',
    status: 'active',
    strength: 1,
    children: [
      {
        id: 'open-local',
        label: 'Local-Only Mode',
        description: 'Hardcoded true in settings. Renders never leave your machine unless you wire a cloud key yourself.',
        colors: [mint, cyan],
        type: 'evidence',
        status: 'complete',
        strength: 0.8,
      },
      {
        id: 'open-telemetry',
        label: 'Zero Telemetry',
        description: 'telemetryDisabled is a literal `true` in the type system. There is no analytics code path.',
        colors: [mint, cyan],
        type: 'evidence',
        status: 'complete',
        strength: 0.8,
      },
      {
        id: 'open-license',
        label: 'Apache-2.0',
        description: 'The whole studio is source-available under a permissive license. Fork it. Keep it. Yours.',
        colors: [mint, violet],
        type: 'evidence',
        status: 'complete',
        strength: 0.8,
      },
      {
        id: 'open-portable',
        label: 'Portable Outputs',
        description: 'Manifests, showcases, and project files are plain JSON and HTML — readable anywhere, forever.',
        colors: [mint, violet],
        type: 'evidence',
        status: 'complete',
        strength: 0.7,
      },
    ],
  };

  const motion: ConstellationNode = {
    id: 'motion',
    label: 'Motion Engine',
    description: 'Keyframe any capsule parameter in seconds and render the sweep as real frames.',
    colors: [resolve('var(--cap-video)'), violet],
    type: 'mission',
    status: 'active',
    strength: 0.7,
    children: conceptLeaves('motion', resolve('var(--cap-video)'), violet, [
      ['Timeline & Keyframes', 'A value timeline over any numeric capsule parameter, with easing.'],
      ['Orb Motion', 'Procedural orbit, bob, pulse, and drift for the living 3D graph.'],
      ['Motion Render', 'Sweeps render one frame at a time — peak VRAM stays at a single render.'],
    ]),
  };

  const audio: ConstellationNode = {
    id: 'audio',
    label: 'Audio Reactivity',
    description: 'Web Audio bands drive the constellation live. A reload never auto-listens — hard privacy rule.',
    colors: [resolve('var(--cap-conditioning)'), cyan],
    type: 'mission',
    status: 'active',
    strength: 0.6,
    children: conceptLeaves('audio', resolve('var(--cap-conditioning)'), cyan, [
      ['Band Analysis', 'Bass, mid, treble, and level from a live FFT.'],
      ['Live Mapping', 'Route any band to orb position, scale, or value rings.'],
      ['Bake to Clip', 'Freeze a live performance into a motion clip you can render.'],
    ]),
  };

  const evolve: ConstellationNode = {
    id: 'evolve',
    label: 'Auto-Evolve',
    description: 'Bounded parameter search — a deterministic genome scored by CLIP and aesthetics. Not a black box.',
    colors: [resolve('var(--cap-lora)'), cyan],
    type: 'mission',
    status: 'active',
    strength: 0.65,
    children: conceptLeaves('evolve', resolve('var(--cap-lora)'), cyan, [
      ['Deterministic Genome', 'cfg, steps, denoise, and seed evolve inside honest bounds.'],
      ['CLIP + Aesthetic Scoring', 'Real image–prompt alignment plus deterministic aesthetics.'],
      ['Bounded Generations', 'Populations of 2–8 over 1–6 generations. One render of VRAM.'],
    ]),
  };

  const field: ConstellationNode = {
    id: 'field',
    label: 'Render-Space Field',
    description: 'Fly a translucent ghost through parameter space; its position writes real settings.',
    colors: [cyan, violet],
    type: 'mission',
    status: 'active',
    strength: 0.6,
    children: conceptLeaves('field', cyan, violet, [
      ['Ghost Controller', 'A draggable field probe — position becomes cfg, denoise, seed.'],
      ['Anchors', 'Save a sweet spot; restore the exact parameter bundle later.'],
      ['Field Presets', 'Curated axis bundles: Structure, Fidelity, Variation, and friends.'],
    ]),
  };

  const turbo: ConstellationNode = {
    id: 'turbo',
    label: 'TurboForge',
    description: 'Measured-only performance planning: benchmarks, compile cache, and honest speedups.',
    colors: [resolve('var(--ld-warn)'), mango],
    type: 'tool',
    status: 'active',
    strength: 0.55,
    children: conceptLeaves('turbo', resolve('var(--ld-warn)'), mango, [
      ['Render Plans', 'Task-aware acceleration profiles per backend and model.'],
      ['Benchmarks', 'Speedup claims only from measured baseline vs optimized runs.'],
      ['Compile Cache', 'Warm starts for compiled pipelines.'],
    ]),
  };

  const cloud: ConstellationNode = {
    id: 'cloud',
    label: 'Cloud Bridges',
    description: 'Optional hosted APIs through the local bridge — keys never touch the browser. Local stays default.',
    colors: [resolve('var(--ld-accent)'), cyan],
    type: 'integration',
    status: 'active',
    strength: 0.5,
    children: conceptLeaves('cloud', resolve('var(--ld-accent)'), cyan, [
      ['Local Bridge', 'A stdlib Python sidecar owns all provider HTTP on 127.0.0.1.'],
      ['Hosted Providers', 'Bring your own key; unsupported features fail loudly, never silently.'],
    ]),
  };

  return {
    id: 'lumen',
    label: 'LumenDeck',
    description:
      'A free, open, local-first generative image studio. Every capability orbits here — visible, reachable, and yours.',
    colors: [cyan, violet],
    type: 'core',
    status: 'active',
    strength: 1,
    children: [
      openCore,
      studioBranch(resolve),
      motion,
      audio,
      evolve,
      field,
      turbo,
      cloud,
      creativeBranch(input, resolve),
      galleryBranch(input, resolve),
    ],
  };
}
