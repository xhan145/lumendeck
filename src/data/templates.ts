import type { Workflow } from '../core/types';
import { createDefaultWorkflow, findNode, updateNodeParam } from '../core/workflow';

export interface RecipeTemplate {
  id: string;
  name: string;
  description: string;
  build(): Workflow;
}

/** Start from the default graph with a chosen installed checkpoint. */
function base(checkpointId: string, apply: (wf: Workflow) => Workflow): Workflow {
  let wf = createDefaultWorkflow();
  const model = findNode(wf, 'model')!;
  wf = updateNodeParam(wf, model.id, 'assetId', checkpointId);
  return apply(wf);
}

function setPrompt(wf: Workflow, positive: string, negative = 'blurry, low quality, watermark'): Workflow {
  const p = findNode(wf, 'prompt')!;
  return updateNodeParam(updateNodeParam(wf, p.id, 'positive', positive), p.id, 'negative', negative);
}

function setSampler(wf: Workflow, steps: number, cfg: number): Workflow {
  const s = findNode(wf, 'sampler')!;
  return updateNodeParam(updateNodeParam(wf, s.id, 'steps', steps), s.id, 'cfg', cfg);
}

function setCanvas(wf: Workflow, width: number, height: number): Workflow {
  const c = findNode(wf, 'canvas')!;
  return updateNodeParam(updateNodeParam(wf, c.id, 'width', width), c.id, 'height', height);
}

export const TEMPLATES: RecipeTemplate[] = [
  {
    id: 'neon-poster',
    name: 'Neon Poster',
    description: 'High-contrast neon key art with glowing signage.',
    build: () =>
      base('ckpt-lumen-xl', (wf) =>
        setCanvas(
          setSampler(setPrompt(wf, 'neon cyberpunk poster, glowing signage, rain-slick street, cinematic, ultra detailed'), 30, 8),
          1024,
          1024,
        ),
      ),
  },
  {
    id: 'ink-sketch',
    name: 'Ink Sketch',
    description: 'Monochrome sumi-e ink-wash study on paper.',
    build: () =>
      base('ckpt-drift-15', (wf) =>
        setCanvas(
          setSampler(setPrompt(wf, 'sumi-e ink wash sketch, minimal, high contrast, textured paper', 'color, photo, 3d render'), 22, 6),
          768,
          768,
        ),
      ),
  },
  {
    id: 'portrait-studio',
    name: 'Portrait Studio',
    description: 'Soft-lit photoreal studio portrait.',
    build: () =>
      base('ckpt-lumen-xl', (wf) =>
        setCanvas(
          setSampler(setPrompt(wf, 'studio portrait, soft rim light, 85mm, shallow depth of field, photoreal, skin detail'), 28, 7),
          896,
          1152,
        ),
      ),
  },
];

export function findTemplate(id: string): RecipeTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
