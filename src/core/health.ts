import { CAPSULES } from './capsules';
import { findAsset, loraCompatible, type ModelAsset, type ModelFamily } from './shelf';
import type { LoraSlot, Workflow } from './types';

export type HealthCode =
  | 'missing-model'
  | 'model-not-installed'
  | 'broken-link'
  | 'socket-mismatch'
  | 'bad-dimensions'
  | 'vram-risk'
  | 'lora-compat'
  | 'disconnected';

export interface HealthIssue {
  id: string;
  severity: 'error' | 'warning';
  code: HealthCode;
  message: string;
  nodeId?: string;
}

/** Rough VRAM estimate in GB for a text-to-image pass. */
export function estimateVramGB(
  width: number,
  height: number,
  batch: number,
  family: ModelFamily,
): number {
  const base: Record<ModelFamily, number> = { 'SD1.5': 2.4, SDXL: 5.8, SD3: 7.2, Flux: 14 };
  const mp = (width * height) / 1_000_000;
  // latent + activations scale roughly with pixel count and batch
  return +(base[family] + mp * 1.35 * batch).toFixed(1);
}

export const VRAM_BUDGET_GB = 8;

export function checkHealth(wf: Workflow, shelf: ModelAsset[]): HealthIssue[] {
  const issues: HealthIssue[] = [];
  let n = 0;
  const add = (issue: Omit<HealthIssue, 'id'>) => issues.push({ id: `hi_${++n}`, ...issue });

  const nodeById = new Map(wf.nodes.map((node) => [node.id, node]));

  // Broken links + socket type mismatches
  for (const edge of wf.edges) {
    const fromNode = nodeById.get(edge.from.node);
    const toNode = nodeById.get(edge.to.node);
    if (!fromNode || !toNode) {
      add({
        severity: 'error',
        code: 'broken-link',
        message: 'A connection references a capsule that no longer exists.',
      });
      continue;
    }
    const out = CAPSULES[fromNode.kind].outputs.find((s) => s.id === edge.from.socket);
    const inp = CAPSULES[toNode.kind].inputs.find((s) => s.id === edge.to.socket);
    if (!out || !inp) {
      add({
        severity: 'error',
        code: 'broken-link',
        message: `Connection between ${fromNode.kind} and ${toNode.kind} references a missing socket.`,
        nodeId: toNode.id,
      });
      continue;
    }
    if (out.type !== inp.type) {
      add({
        severity: 'error',
        code: 'socket-mismatch',
        message: `${CAPSULES[fromNode.kind].title} “${out.label}” (${out.type}) is wired into ${CAPSULES[toNode.kind].title} “${inp.label}” (${inp.type}).`,
        nodeId: toNode.id,
      });
    }
  }

  // Model capsule → shelf
  const modelNode = wf.nodes.find((node) => node.kind === 'model');
  const checkpointId = (modelNode?.params.assetId as string) || '';
  const checkpoint = checkpointId ? findAsset(shelf, checkpointId) : undefined;
  if (modelNode) {
    if (!checkpointId || !checkpoint) {
      add({
        severity: 'error',
        code: 'missing-model',
        message: checkpointId
          ? `Checkpoint “${checkpointId}” is not on the Model Shelf.`
          : 'No checkpoint selected in the Model capsule.',
        nodeId: modelNode.id,
      });
    } else if (!checkpoint.installed) {
      add({
        severity: 'error',
        code: 'model-not-installed',
        message: `${checkpoint.name} is on the shelf but not installed (${checkpoint.path}).`,
        nodeId: modelNode.id,
      });
    }
  }

  // LoRA rack: assets exist + family compatibility
  const rackNode = wf.nodes.find((node) => node.kind === 'loraRack');
  const slots = (rackNode?.params.slots as LoraSlot[] | undefined) ?? [];
  for (const slot of slots) {
    if (!slot.enabled) continue;
    const lora = findAsset(shelf, slot.assetId);
    if (!lora) {
      add({
        severity: 'error',
        code: 'missing-model',
        message: `LoRA “${slot.assetId}” is not on the Model Shelf.`,
        nodeId: rackNode?.id,
      });
      continue;
    }
    if (!lora.installed) {
      add({
        severity: 'error',
        code: 'model-not-installed',
        message: `${lora.name} is not installed (${lora.path}).`,
        nodeId: rackNode?.id,
      });
    }
    if (checkpoint) {
      const compat = loraCompatible(lora, checkpoint);
      if (!compat.ok) {
        add({ severity: 'warning', code: 'lora-compat', message: compat.warning!, nodeId: rackNode?.id });
      }
    }
  }

  // Canvas dimensions
  const canvasNode = wf.nodes.find((node) => node.kind === 'canvas');
  if (canvasNode) {
    const width = Number(canvasNode.params.width) || 0;
    const height = Number(canvasNode.params.height) || 0;
    const batch = Number(canvasNode.params.batch) || 1;
    if (width % 8 !== 0 || height % 8 !== 0) {
      add({
        severity: 'error',
        code: 'bad-dimensions',
        message: `Canvas ${width}×${height} — both sides must be multiples of 8.`,
        nodeId: canvasNode.id,
      });
    }
    if (width < 256 || height < 256) {
      add({
        severity: 'warning',
        code: 'bad-dimensions',
        message: `Canvas ${width}×${height} is below 256px — expect mush.`,
        nodeId: canvasNode.id,
      });
    }
    if (width > 4096 || height > 4096) {
      add({
        severity: 'warning',
        code: 'bad-dimensions',
        message: `Canvas ${width}×${height} exceeds 4096px — most backends will refuse or tile.`,
        nodeId: canvasNode.id,
      });
    }
    if (checkpoint) {
      const vram = estimateVramGB(width, height, batch, checkpoint.family);
      if (vram > VRAM_BUDGET_GB) {
        add({
          severity: 'warning',
          code: 'vram-risk',
          message: `Estimated ${vram} GB VRAM for ${checkpoint.family} at ${width}×${height}×${batch} — over the ${VRAM_BUDGET_GB} GB budget.`,
          nodeId: canvasNode.id,
        });
      }
    }
  }

  // Sampler must have model + conditioning wired
  const samplerNode = wf.nodes.find((node) => node.kind === 'sampler');
  if (samplerNode) {
    const hasInto = (socket: string) =>
      wf.edges.some((e) => e.to.node === samplerNode.id && e.to.socket === socket);
    if (!hasInto('model')) {
      add({
        severity: 'error',
        code: 'disconnected',
        message: 'Sampler has no model input — wire Model (or LoRA Rack) into it.',
        nodeId: samplerNode.id,
      });
    }
    if (!hasInto('conditioning')) {
      add({
        severity: 'error',
        code: 'disconnected',
        message: 'Sampler has no prompt conditioning input.',
        nodeId: samplerNode.id,
      });
    }
  }

  return issues;
}
