import type { CapsuleDef, CapsuleKind } from './types';

/**
 * The nine LumenDeck Capsule node definitions. Both the Recipe View cards and
 * the Graph View nodes are projections of these definitions plus per-node params.
 */
export const CAPSULES: Record<CapsuleKind, CapsuleDef> = {
  prompt: {
    kind: 'prompt',
    title: 'Prompt',
    accent: 'var(--cap-prompt)',
    description: 'What to imagine. Positive and negative text conditioning.',
    inputs: [],
    outputs: [{ id: 'conditioning', label: 'Conditioning', type: 'conditioning' }],
    params: [
      {
        id: 'positive',
        label: 'Prompt',
        kind: 'textarea',
        default: 'a luminous deck of glowing cards floating over a midnight ocean, volumetric light, ultra detailed',
        help: 'Describe the image you want.',
      },
      {
        id: 'negative',
        label: 'Negative prompt',
        kind: 'textarea',
        default: 'blurry, low quality, watermark',
        help: 'What to avoid.',
      },
    ],
  },
  model: {
    kind: 'model',
    title: 'Model',
    accent: 'var(--cap-model)',
    description: 'Base checkpoint that defines the look and capability.',
    inputs: [],
    outputs: [{ id: 'model', label: 'Model', type: 'model' }],
    params: [
      { id: 'assetId', label: 'Checkpoint', kind: 'select', options: [], default: '' },
    ],
  },
  loraRack: {
    kind: 'loraRack',
    title: 'LoRA Rack',
    accent: 'var(--cap-lora)',
    description: 'Stack style/subject adapters on top of the base model.',
    inputs: [{ id: 'model_in', label: 'Model', type: 'model' }],
    outputs: [{ id: 'model_out', label: 'Model + LoRAs', type: 'lora_stack' }],
    params: [
      { id: 'slots', label: 'LoRA slots', kind: 'text', default: [] as unknown },
    ],
  },
  control: {
    kind: 'control',
    title: 'Control',
    accent: 'var(--cap-control)',
    description: 'Optional structural guidance (pose, depth, edges).',
    inputs: [],
    outputs: [{ id: 'control', label: 'Control', type: 'control' }],
    params: [
      { id: 'enabled', label: 'Enabled', kind: 'toggle', default: false },
      {
        id: 'mode',
        label: 'Mode',
        kind: 'select',
        options: [
          { value: 'none', label: 'None' },
          { value: 'canny', label: 'Canny edges' },
          { value: 'depth', label: 'Depth' },
          { value: 'pose', label: 'Pose' },
        ],
        default: 'none',
      },
      { id: 'strength', label: 'Strength', kind: 'number', min: 0, max: 2, step: 0.05, default: 1 },
    ],
  },
  sampler: {
    kind: 'sampler',
    title: 'Sampler',
    accent: 'var(--cap-sampler)',
    description: 'How the image is denoised: algorithm, steps, guidance, seed.',
    inputs: [
      { id: 'conditioning', label: 'Conditioning', type: 'conditioning' },
      { id: 'model', label: 'Model', type: 'lora_stack' },
      { id: 'control', label: 'Control', type: 'control' },
      { id: 'latent', label: 'Canvas', type: 'latent' },
    ],
    outputs: [{ id: 'image', label: 'Image', type: 'image' }],
    params: [
      {
        id: 'sampler',
        label: 'Sampler',
        kind: 'select',
        options: [
          { value: 'euler', label: 'Euler' },
          { value: 'euler_a', label: 'Euler Ancestral' },
          { value: 'dpmpp_2m', label: 'DPM++ 2M' },
          { value: 'ddim', label: 'DDIM' },
        ],
        default: 'euler_a',
      },
      { id: 'steps', label: 'Steps', kind: 'number', min: 1, max: 150, step: 1, default: 28 },
      { id: 'cfg', label: 'Guidance (CFG)', kind: 'number', min: 1, max: 30, step: 0.5, default: 7 },
      { id: 'seed', label: 'Seed', kind: 'seed', default: 1337, help: '-1 rolls a random seed per render.' },
    ],
  },
  canvas: {
    kind: 'canvas',
    title: 'Canvas',
    accent: 'var(--cap-canvas)',
    description: 'Output size and batch. Dimensions should be multiples of 8.',
    inputs: [],
    outputs: [{ id: 'latent', label: 'Latent', type: 'latent' }],
    params: [
      { id: 'width', label: 'Width', kind: 'number', min: 64, max: 8192, step: 8, default: 1024 },
      { id: 'height', label: 'Height', kind: 'number', min: 64, max: 8192, step: 8, default: 1024 },
      { id: 'batch', label: 'Batch size', kind: 'number', min: 1, max: 16, step: 1, default: 1 },
    ],
  },
  queue: {
    kind: 'queue',
    title: 'Queue',
    accent: 'var(--cap-queue)',
    description: 'Collects render jobs and dispatches them to the active backend.',
    inputs: [{ id: 'image', label: 'Image', type: 'image' }],
    outputs: [{ id: 'image_out', label: 'Rendered', type: 'image' }],
    params: [
      { id: 'autoRun', label: 'Auto-run on change', kind: 'toggle', default: false },
    ],
  },
  export: {
    kind: 'export',
    title: 'Export',
    accent: 'var(--cap-export)',
    description: 'Saves renders to the gallery and to disk.',
    inputs: [{ id: 'image', label: 'Image', type: 'image' }],
    outputs: [{ id: 'manifest_out', label: 'Manifest', type: 'manifest' }],
    params: [
      {
        id: 'format',
        label: 'Format',
        kind: 'select',
        options: [
          { value: 'png', label: 'PNG' },
          { value: 'webp', label: 'WebP' },
        ],
        default: 'png',
      },
      { id: 'embedManifest', label: 'Embed manifest', kind: 'toggle', default: true },
    ],
  },
  manifest: {
    kind: 'manifest',
    title: 'Manifest',
    accent: 'var(--cap-manifest)',
    description: 'Reproducibility record: prompt, seed, models, LoRAs, graph.',
    inputs: [{ id: 'manifest_in', label: 'Manifest', type: 'manifest' }],
    outputs: [],
    params: [
      { id: 'includeGraph', label: 'Include graph snapshot', kind: 'toggle', default: true },
      { id: 'author', label: 'Author', kind: 'text', default: '' },
    ],
  },
};

export const CAPSULE_KINDS = Object.keys(CAPSULES) as CapsuleKind[];

export function capsuleDef(kind: CapsuleKind): CapsuleDef {
  return CAPSULES[kind];
}

export function defaultParams(kind: CapsuleKind): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of CAPSULES[kind].params) {
    out[p.id] = Array.isArray(p.default) ? [...(p.default as unknown[])] : p.default;
  }
  return out;
}
