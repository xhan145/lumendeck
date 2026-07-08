import { describe, it, expect } from 'vitest';
import { sanitizeAppSettings } from '../src/state/appSettings';
import { ENCODINGS, unregisteredLayers, registeredLayers } from '../src/components/graph/graph3d/encodings';
import { packWells, fabricDisplacement, MAX_WELLS, createFabric } from '../src/components/graph/graph3d/fabric';
import type { WorkflowNode } from '../src/core/types';

function sampler(id: string, cfg: number): WorkflowNode {
  return { id, kind: 'sampler', x: 0, y: 0, params: { cfg } };
}

describe('appSettings graph3dEffects', () => {
  it('accepts the four valid effect levels', () => {
    for (const v of ['off', 'minimal', 'standard', 'rich'] as const) {
      expect(sanitizeAppSettings({ graph3dEffects: v }).graph3dEffects).toBe(v);
    }
  });

  it('drops invalid or missing values to undefined (older blobs still load)', () => {
    expect(sanitizeAppSettings({ graph3dEffects: 'ultra' as never }).graph3dEffects).toBeUndefined();
    expect(sanitizeAppSettings({}).graph3dEffects).toBeUndefined();
    expect(sanitizeAppSettings(undefined).graph3dEffects).toBeUndefined();
  });
});

describe('encoding registry (hard rule: no layer without a datum)', () => {
  it('seeds exactly the mass→fabric-well encoding', () => {
    expect(ENCODINGS).toHaveLength(1);
    const mass = ENCODINGS[0];
    expect(mass.id).toBe('mass');
    expect(mass.layer).toBe('fabric');
    expect(mass.datum).toContain('weightT');
    expect(mass.alwaysOn).toBe(true);
  });

  it('passes when every active layer is registered', () => {
    expect(unregisteredLayers(['fabric'])).toEqual([]);
    expect(registeredLayers().has('fabric')).toBe(true);
  });

  it('flags an active layer with no registry entry', () => {
    // @ts-expect-error deliberately unregistered layer name
    expect(unregisteredLayers(['fabric', 'ripples'])).toEqual(['ripples']);
  });
});

describe('packWells', () => {
  it('creates one well per weighted node, none for weightless kinds', () => {
    const nodes: WorkflowNode[] = [
      sampler('s1', 15),
      { id: 'note', kind: 'prompt', x: 200, y: 0, params: {} }, // no numeric weight
    ];
    const { wells, clamped } = packWells(nodes);
    expect(clamped).toBe(false);
    expect(wells).toHaveLength(1); // prompt is weightless → no well
    expect(wells[0].depth).toBeGreaterThan(0);
    expect(wells[0].sigma).toBeGreaterThan(0);
  });

  it('scales depth + sigma with normalized weight (heavier = deeper + wider)', () => {
    const light = packWells([sampler('a', 3)]).wells[0];
    const heavy = packWells([sampler('b', 27)]).wells[0];
    expect(heavy.depth).toBeGreaterThan(light.depth);
    expect(heavy.sigma).toBeGreaterThan(light.sigma);
  });

  it('clamps to the 64 deepest wells and flags it beyond MAX_WELLS', () => {
    const nodes: WorkflowNode[] = [];
    for (let i = 0; i < MAX_WELLS + 10; i++) nodes.push(sampler(`n${i}`, 1 + (i % 30)));
    const { wells, clamped } = packWells(nodes);
    expect(clamped).toBe(true);
    expect(wells).toHaveLength(MAX_WELLS);
    const keptMin = Math.min(...wells.map((w) => w.depth));
    const allSorted = nodes.map((n) => packWells([n]).wells[0].depth).sort((p, q) => q - p);
    expect(keptMin).toBeGreaterThanOrEqual(allSorted[MAX_WELLS - 1] - 1e-9);
  });
});

describe('fabricDisplacement (CPU mirror of the vertex shader)', () => {
  it('is zero with no wells', () => {
    expect(fabricDisplacement(0, 0, [])).toBe(0);
  });

  it('peaks at the well center and decays with distance', () => {
    const wells = [{ x: 0, z: 0, depth: 100, sigma: 200 }];
    const atCenter = fabricDisplacement(0, 0, wells);
    const far = fabricDisplacement(1000, 0, wells);
    expect(atCenter).toBeCloseTo(100, 5);
    expect(far).toBeLessThan(1);
  });

  it('superposes multiple wells additively', () => {
    const a = { x: -100, z: 0, depth: 50, sigma: 150 };
    const b = { x: 100, z: 0, depth: 50, sigma: 150 };
    const mid = fabricDisplacement(0, 0, [a, b]);
    const single = fabricDisplacement(0, 0, [a]);
    expect(mid).toBeCloseTo(2 * single, 6);
  });

  it('a wider sigma spreads more displacement to a fixed off-center point', () => {
    const narrow = fabricDisplacement(150, 0, [{ x: 0, z: 0, depth: 100, sigma: 100 }]);
    const wide = fabricDisplacement(150, 0, [{ x: 0, z: 0, depth: 100, sigma: 300 }]);
    expect(wide).toBeGreaterThan(narrow);
  });
});

describe('createFabric (THREE builder — no GL context needed for construction)', () => {
  it('builds a fabric group whose material composites correctly over the transparent canvas', () => {
    const fabric = createFabric('standard', '#34D6F4', '#7C3AED');
    expect(fabric.group.children.length).toBe(1);
    const mesh = fabric.group.children[0] as import('three').Mesh;
    const mat = mesh.material as import('three').ShaderMaterial;
    expect(mat.transparent).toBe(true);
    expect(mat.depthWrite).toBe(false);
    expect(mat.fog).toBe(false);
    expect(mesh.renderOrder).toBe(-1);
    expect(mat.uniforms.uWellCount.value).toBe(0);
    fabric.dispose();
  });

  it('update() uploads well count + positions and reports clamp state', () => {
    const fabric = createFabric('minimal', '#34D6F4', '#7C3AED');
    const nodes: WorkflowNode[] = [sampler('s1', 15), sampler('s2', 6)];
    const { clamped } = fabric.update(nodes);
    const mat = (fabric.group.children[0] as import('three').Mesh).material as import('three').ShaderMaterial;
    expect(clamped).toBe(false);
    expect(mat.uniforms.uWellCount.value).toBe(2);
    const wells = mat.uniforms.uWells.value as import('three').Vector4[];
    expect(wells[0].z).toBeGreaterThan(0); // depth packed into vec4.z
    fabric.dispose();
  });

  it('dispose() detaches the group and is idempotent', () => {
    const fabric = createFabric('minimal', '#34D6F4', '#7C3AED');
    expect(() => { fabric.dispose(); fabric.dispose(); }).not.toThrow();
  });
});
