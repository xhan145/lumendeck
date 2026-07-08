/**
 * Rack fan-out — the fix for the LoRA/ControlNet "dead axis". A preset (or the
 * auto field) binds an AGGREGATE `loraRack.weight` / `controlNetRack.strength`,
 * but those are NOT ParamDefs and `buildRenderJob` never reads them: it reads the
 * PER-SLOT `slots[].weight` / `slots[].strength`. So writing the aggregate onto
 * the rack node does nothing to the render.
 *
 * `fanOutRackPatches` closes that gap: it pushes an aggregate weight/strength into
 * EVERY enabled slot of the matching rack (so the axis actually moves the render),
 * and no-ops when the rack is absent or has no enabled slots. Pure + deterministic
 * — every write goes through `updateNodeParam`, so identity/versioning is intact.
 */
import type { ControlSlot, LoraSlot, Workflow } from '../types';
import { findNode, updateNodeParam } from '../workflow';

/** A generic node-KIND patch (structurally accepts a `PresetPatch`). */
export interface RackPatch {
  node: string;
  param: string;
  value: number;
}

/**
 * True for the two rack AGGREGATE patches the render never consumes directly
 * (`buildRenderJob` reads per-slot instead). Callers fan these out via
 * `fanOutRackPatches` and SKIP them in their direct `updateNodeParam` loop.
 */
export function isRackAggregatePatch(p: { node: string; param: string }): boolean {
  return (
    (p.node === 'loraRack' && p.param === 'weight') ||
    (p.node === 'controlNetRack' && p.param === 'strength')
  );
}

/**
 * Apply each rack-aggregate patch to every ENABLED slot of its rack:
 *  - `{node:'loraRack',param:'weight',value}`     → each enabled LoRA slot's weight
 *  - `{node:'controlNetRack',param:'strength',value}` → each enabled ControlNet slot's strength
 * Non-rack patches are ignored (callers apply those directly). A missing rack or
 * ZERO enabled slots is a no-op (nothing to drive — honest, never a phantom slot).
 */
export function fanOutRackPatches(workflow: Workflow, patches: RackPatch[]): Workflow {
  let wf = workflow;
  for (const p of patches) {
    if (p.node === 'loraRack' && p.param === 'weight') {
      const rack = findNode(wf, 'loraRack');
      if (!rack) continue;
      const slots = (rack.params.slots as LoraSlot[] | undefined) ?? [];
      if (!slots.some((s) => s.enabled)) continue;
      wf = updateNodeParam(
        wf,
        rack.id,
        'slots',
        slots.map((s) => (s.enabled ? { ...s, weight: p.value } : s)),
      );
    } else if (p.node === 'controlNetRack' && p.param === 'strength') {
      const rack = findNode(wf, 'controlNetRack');
      if (!rack) continue;
      const slots = (rack.params.slots as ControlSlot[] | undefined) ?? [];
      if (!slots.some((s) => s.enabled)) continue;
      wf = updateNodeParam(
        wf,
        rack.id,
        'slots',
        slots.map((s) => (s.enabled ? { ...s, strength: p.value } : s)),
      );
    }
  }
  return wf;
}
