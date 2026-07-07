import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fieldProfile,
  profileHasAxes,
  profileEntries,
  type FieldProfile,
} from '../src/core/field/fieldProfile';
import { applyField, fieldPosition } from '../src/core/field/applyField';
import { pathToClip, type PathSample } from '../src/core/field/pathToClip';
import { defaultFieldState, hydrateField, type FieldState } from '../src/state/field';
import { findNode } from '../src/core/workflow';
import type { ControlNetFamily } from '../src/core/controlnet';
import type { MotionParamPatch } from '../src/core/motion/renderPlan';
import { useStudio } from '../src/state/store';

// ---------------------------------------------------------------------------
// fieldProfile — curated per-kind / family / prompt selection (deterministic)
// ---------------------------------------------------------------------------
describe('fieldProfile — curated per-kind table', () => {
  const noParams: Record<string, unknown> = {};

  it('sampler → X Structure(cfg,steps), Y Fidelity(denoise), Z Variation(seed)', () => {
    const p = fieldProfile('sampler', 'SD1.5', noParams);
    expect(p.x?.label).toBe('Structure');
    expect(p.x?.bundle.map((b) => b.param)).toEqual(['cfg', 'steps']);
    expect(p.y?.label).toBe('Fidelity');
    expect(p.y?.bundle.map((b) => b.param)).toEqual(['denoise']);
    expect(p.z?.label).toBe('Variation');
    expect(p.z?.bundle.map((b) => b.param)).toEqual(['seed']);
  });

  it('imageLoader → single X Adherence(strength) axis, no Y/Z', () => {
    const p = fieldProfile('imageLoader', 'SD1.5', noParams);
    expect(p.x?.label).toBe('Adherence');
    expect(p.x?.bundle.map((b) => b.param)).toEqual(['strength']);
    expect(p.y).toBeUndefined();
    expect(p.z).toBeUndefined();
  });

  it('hiresFix → X Detail(scale,denoise) bundle', () => {
    const p = fieldProfile('hiresFix', 'SD1.5', noParams);
    expect(p.x?.label).toBe('Detail');
    expect(p.x?.bundle.map((b) => b.param)).toEqual(['scale', 'denoise']);
  });

  it('controlNetRack → mean control-strength bundle (0..2)', () => {
    const p = fieldProfile('controlNetRack', 'SD1.5', noParams);
    expect(p.x?.label).toBe('Control strength');
    expect(p.x?.bundle).toEqual([{ param: 'strength', min: 0, max: 2 }]);
  });

  it('loraRack → mean LoRA-weight bundle (-1..2)', () => {
    const p = fieldProfile('loraRack', 'SD1.5', noParams);
    expect(p.x?.label).toBe('LoRA weight');
    expect(p.x?.bundle).toEqual([{ param: 'weight', min: -1, max: 2 }]);
  });

  it('generic fallback → first ≤3 numeric ParamDefs each on their own axis', () => {
    // canvas has width/height/batch numeric params (+ a toggle) -> exactly 3 axes.
    const p = fieldProfile('canvas', 'SD1.5', noParams);
    expect(profileEntries(p).map((e) => e.param)).toEqual(['width', 'height', 'batch']);
    expect(p.x?.bundle[0].param).toBe('width');
    expect(p.y?.bundle[0].param).toBe('height');
    expect(p.z?.bundle[0].param).toBe('batch');
  });

  it('a node with NO numeric params → empty {} profile (ghost disabled)', () => {
    // prompt has only textareas; note has only a textarea.
    expect(fieldProfile('prompt', 'SD1.5', noParams)).toEqual({});
    expect(fieldProfile('note', 'SD1.5', noParams)).toEqual({});
    expect(profileHasAxes(fieldProfile('prompt', 'SD1.5', noParams))).toBe(false);
  });

  it('family adapts the sampler cfg range (SDXL lower than SD1.5)', () => {
    const families: ControlNetFamily[] = ['SD1.5', 'SD2.1', 'SDXL'];
    const cfgMax = families.map((f) => fieldProfile('sampler', f, noParams).x!.bundle[0].max);
    // SDXL max CFG is strictly lower than SD1.5's.
    const [sd15, , sdxl] = cfgMax;
    expect(sdxl).toBeLessThan(sd15);
    // Ranges stay within the capsule's own cfg bounds (1..30).
    for (const f of families) {
      const cfg = fieldProfile('sampler', f, noParams).x!.bundle[0];
      expect(cfg.min).toBeGreaterThanOrEqual(1);
      expect(cfg.max).toBeLessThanOrEqual(30);
    }
  });

  it('a photo/realism prompt marker biases the Fidelity (denoise) axis', () => {
    const plain = fieldProfile('sampler', 'SD1.5', noParams, 'a fantasy castle');
    const photo = fieldProfile('sampler', 'SD1.5', noParams, 'a realistic photo of a castle, dslr');
    // Plain sweeps full denoise range; photo lifts the low end.
    expect(plain.y!.bundle[0].min).toBe(0);
    expect(photo.y!.bundle[0].min).toBeGreaterThan(plain.y!.bundle[0].min);
  });

  it('is pure/deterministic (same inputs → deep-equal output)', () => {
    const a = fieldProfile('sampler', 'SDXL', { cfg: 9 }, 'photo');
    const b = fieldProfile('sampler', 'SDXL', { cfg: 9 }, 'photo');
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// applyField — position + intensity → patches; fieldPosition round-trip
// ---------------------------------------------------------------------------
describe('applyField', () => {
  const profile = fieldProfile('sampler', 'SD1.5', {}); // Structure/Fidelity/Variation

  it('intensity 0 pins EVERY param at its bundle midpoint regardless of position', () => {
    const patches = applyField({ x: 1, y: 0, z: 1 }, 0, profile, 'n1');
    for (const e of profileEntries(profile)) {
      const patch = patches.find((p) => p.param === e.param)!;
      expect(patch.value).toBeCloseTo((e.min + e.max) / 2, 9);
    }
  });

  it('intensity 1 sweeps to the range ends at pos 0 and pos 1', () => {
    for (const e of profileEntries(profile)) {
      const atMin = applyField({ x: 0, y: 0, z: 0 }, 1, profile, 'n1').find((p) => p.param === e.param)!;
      const atMax = applyField({ x: 1, y: 1, z: 1 }, 1, profile, 'n1').find((p) => p.param === e.param)!;
      expect(atMin.value).toBeCloseTo(e.min, 9);
      expect(atMax.value).toBeCloseTo(e.max, 9);
    }
  });

  it('clamps out-of-[0,1] coords to the bundle bounds (never exceeds min/max)', () => {
    const over = applyField({ x: 5, y: -3, z: 99 }, 1, profile, 'n1');
    for (const e of profileEntries(profile)) {
      const patch = over.find((p) => p.param === e.param)!;
      expect(patch.value).toBeGreaterThanOrEqual(e.min);
      expect(patch.value).toBeLessThanOrEqual(e.max);
    }
  });

  it('stamps the supplied nodeId on every patch', () => {
    const patches = applyField({ x: 0.5, y: 0.5, z: 0.5 }, 1, profile, 'ghost-node');
    expect(patches.length).toBeGreaterThan(0);
    for (const p of patches) expect(p.nodeId).toBe('ghost-node');
  });

  it('empty profile → no patches', () => {
    expect(applyField({ x: 0.5, y: 0.5, z: 0.5 }, 1, {}, 'n1')).toEqual([]);
  });

  it('fieldPosition inverts applyField at full intensity (round-trip)', () => {
    const pos = { x: 0.2, y: 0.65, z: 0.9 };
    const patches = applyField(pos, 1, profile, 'n1');
    const back = fieldPosition(patches, profile);
    expect(back.x).toBeCloseTo(pos.x, 6);
    expect(back.y).toBeCloseTo(pos.y, 6);
    expect(back.z).toBeCloseTo(pos.z, 6);
  });

  it('fieldPosition defaults missing axes/values to the midpoint (0.5)', () => {
    // No values at all -> every axis recovers 0.5.
    expect(fieldPosition([], profile)).toEqual({ x: 0.5, y: 0.5, z: 0.5 });
    // A profile with no axes -> all 0.5 regardless of values.
    const vals: MotionParamPatch[] = [{ nodeId: 'n', param: 'cfg', value: 9 }];
    expect(fieldPosition(vals, {} as FieldProfile)).toEqual({ x: 0.5, y: 0.5, z: 0.5 });
  });
});

// ---------------------------------------------------------------------------
// pathToClip — N samples → one track per param, keyframe count/times/values
// ---------------------------------------------------------------------------
describe('pathToClip', () => {
  const profile = fieldProfile('sampler', 'SD1.5', {});

  const samples: PathSample[] = [
    { t: 0, pos: { x: 0, y: 0, z: 0 } },
    { t: 0.5, pos: { x: 0.5, y: 0.5, z: 0.5 } },
    { t: 1, pos: { x: 1, y: 1, z: 1 } },
  ];

  it('emits one track per field-mapped param (in profile order)', () => {
    const clip = pathToClip(samples, profile, 'n1');
    expect(clip.tracks.map((t) => t.param)).toEqual(profileEntries(profile).map((e) => e.param));
    for (const t of clip.tracks) expect(t.nodeId).toBe('n1');
  });

  it('each track has exactly N keyframes at the sample times', () => {
    const clip = pathToClip(samples, profile, 'n1');
    for (const t of clip.tracks) {
      expect(t.keyframes).toHaveLength(samples.length);
      expect(t.keyframes.map((k) => k.t)).toEqual([0, 0.5, 1]);
    }
  });

  it('keyframe values equal applyField(pos, 1) at each sample', () => {
    const clip = pathToClip(samples, profile, 'n1');
    for (const t of clip.tracks) {
      samples.forEach((s, i) => {
        const expected = applyField(s.pos, 1, profile, 'n1').find((p) => p.param === t.param)!.value;
        expect(t.keyframes[i].value).toBeCloseTo(expected, 9);
      });
    }
  });

  it('mints a stable, unique id on every keyframe and track', () => {
    const clip = pathToClip(samples, profile, 'n1');
    const kfIds = clip.tracks.flatMap((t) => t.keyframes.map((k) => k.id));
    expect(kfIds.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(kfIds).size).toBe(kfIds.length); // all unique
    const trackIds = clip.tracks.map((t) => t.id);
    expect(new Set(trackIds).size).toBe(trackIds.length);
  });

  it('duration = last sample time; loop off (a recorded performance, not a loop)', () => {
    const clip = pathToClip(samples, profile, 'n1');
    expect(clip.duration).toBe(1);
    expect(clip.loop).toBe(false);
  });

  it('empty samples OR empty profile → a clip with no tracks', () => {
    expect(pathToClip([], profile, 'n1').tracks).toEqual([]);
    expect(pathToClip(samples, {}, 'n1').tracks).toEqual([]);
    expect(pathToClip([], profile, 'n1').duration).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// field state slice — default + additive hydration (old blobs load)
// ---------------------------------------------------------------------------
describe('field state slice', () => {
  it('defaultFieldState is empty', () => {
    expect(defaultFieldState()).toEqual({ ghosts: [], anchors: [] });
  });

  it('hydrateField(undefined) → empty state', () => {
    expect(hydrateField(undefined)).toEqual({ ghosts: [], anchors: [] });
  });

  it('resets the transient recording flag on hydrate (never resume a session)', () => {
    const persisted: FieldState = {
      ghosts: [{ id: 'g1', nodeId: 'n1', pos: { x: 0.2, y: 0.3, z: 0.4 }, intensity: 0.7, pinned: true, recording: true }],
      anchors: [],
    };
    const hydrated = hydrateField(persisted);
    expect(hydrated.ghosts[0].recording).toBe(false);
    expect(hydrated.ghosts[0].pinned).toBe(true);
    expect(hydrated.ghosts[0].intensity).toBe(0.7);
  });

  it('drops malformed ghosts/anchors (partial/old blobs load without crashing)', () => {
    const junk = {
      ghosts: [null, { nodeId: 'n1' }, { id: 'ok', nodeId: 'n1', pos: {}, intensity: 1, pinned: false, recording: false }],
      anchors: [{ id: 'a1', nodeId: 'n1', name: 'A', pos: { x: 0, y: 0, z: 0 }, values: [{ nodeId: 'n1', param: 'cfg', value: 7 }] }, 'bad'],
    } as unknown as FieldState;
    const hydrated = hydrateField(junk);
    expect(hydrated.ghosts).toHaveLength(1);
    expect(hydrated.ghosts[0].id).toBe('ok');
    expect(hydrated.anchors).toHaveLength(1);
    expect(hydrated.anchors[0].values).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// store actions — spawn / move / anchor / record wiring
// ---------------------------------------------------------------------------
describe('store — ghost controller actions', () => {
  beforeEach(() => {
    useStudio.getState().resetWorkflow();
    // Clear any ghosts/anchors + reset motion to a clean baseline for record tests.
    useStudio.setState({ field: { ghosts: [], anchors: [] } });
  });

  it('spawnGhost no-ops on a node with an empty profile (e.g. prompt)', () => {
    const prompt = findNode(useStudio.getState().workflow, 'prompt')!;
    useStudio.getState().spawnGhost(prompt.id);
    expect(useStudio.getState().field.ghosts).toHaveLength(0);
  });

  // Regression (review): deleting a node must prune its ghost + anchors so they
  // don't orphan the field slice.
  it('removeCapsule prunes the deleted node\'s ghosts and anchors', () => {
    const sampler = findNode(useStudio.getState().workflow, 'sampler')!;
    useStudio.getState().spawnGhost(sampler.id);
    const g = useStudio.getState().field.ghosts[0];
    useStudio.getState().saveAnchor(g.id, 'spot');
    expect(useStudio.getState().field.ghosts).toHaveLength(1);
    expect(useStudio.getState().field.anchors).toHaveLength(1);
    useStudio.getState().removeCapsule(sampler.id);
    expect(useStudio.getState().field.ghosts).toHaveLength(0);
    expect(useStudio.getState().field.anchors).toHaveLength(0);
  });

  // Regression (review): resetWorkflow must clear all ghosts/anchors.
  it('resetWorkflow clears all ghosts and anchors', () => {
    const sampler = findNode(useStudio.getState().workflow, 'sampler')!;
    useStudio.getState().spawnGhost(sampler.id);
    useStudio.getState().resetWorkflow();
    expect(useStudio.getState().field.ghosts).toHaveLength(0);
    expect(useStudio.getState().field.anchors).toHaveLength(0);
  });

  // Regression (review): cancelAllGhostRecordings clears in-progress recording
  // flags (the leaked-timer teardown called on 3D-view unmount).
  it('cancelAllGhostRecordings clears the recording flag', () => {
    const sampler = findNode(useStudio.getState().workflow, 'sampler')!;
    useStudio.getState().spawnGhost(sampler.id);
    const g = useStudio.getState().field.ghosts[0];
    useStudio.getState().startGhostRecording(g.id);
    expect(useStudio.getState().field.ghosts[0].recording).toBe(true);
    useStudio.getState().cancelAllGhostRecordings();
    expect(useStudio.getState().field.ghosts[0].recording).toBe(false);
  });

  it('spawnGhost adds exactly one ghost for a drivable node (idempotent per node)', () => {
    const sampler = findNode(useStudio.getState().workflow, 'sampler')!;
    useStudio.getState().spawnGhost(sampler.id);
    useStudio.getState().spawnGhost(sampler.id); // second call is a no-op
    const ghosts = useStudio.getState().field.ghosts;
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0].nodeId).toBe(sampler.id);
    expect(ghosts[0].pos).toEqual({ x: 0.5, y: 0.5, z: 0.5 });
  });

  it('moveGhost writes the node params via applyField in one commit', () => {
    const sampler = findNode(useStudio.getState().workflow, 'sampler')!;
    useStudio.getState().spawnGhost(sampler.id);
    const ghost = useStudio.getState().field.ghosts[0];
    const versionBefore = useStudio.getState().workflow.version;
    // Drive Structure (X=cfg,steps) to the top of its range at full intensity.
    useStudio.getState().moveGhost(ghost.id, { x: 1, y: 1, z: 1 });
    const wf = useStudio.getState().workflow;
    const node = wf.nodes.find((n) => n.id === sampler.id)!;
    const profile = useStudio.getState().fieldProfileFor(sampler.id);
    const expected = applyField({ x: 1, y: 1, z: 1 }, 1, profile, sampler.id);
    for (const p of expected) expect(node.params[p.param]).toBeCloseTo(p.value, 9);
    expect(wf.version).toBeGreaterThan(versionBefore);
  });

  it('moveGhost clamps the stored ghost position to [0,1]', () => {
    const sampler = findNode(useStudio.getState().workflow, 'sampler')!;
    useStudio.getState().spawnGhost(sampler.id);
    const ghost = useStudio.getState().field.ghosts[0];
    useStudio.getState().moveGhost(ghost.id, { x: 9, y: -9, z: 0.3 });
    const stored = useStudio.getState().field.ghosts[0].pos;
    expect(stored).toEqual({ x: 1, y: 0, z: 0.3 });
  });

  it('setGhostIntensity re-applies params (intensity 0 → midpoints)', () => {
    const sampler = findNode(useStudio.getState().workflow, 'sampler')!;
    useStudio.getState().spawnGhost(sampler.id);
    const ghost = useStudio.getState().field.ghosts[0];
    useStudio.getState().moveGhost(ghost.id, { x: 1, y: 1, z: 1 });
    useStudio.getState().setGhostIntensity(ghost.id, 0);
    const node = useStudio.getState().workflow.nodes.find((n) => n.id === sampler.id)!;
    const profile = useStudio.getState().fieldProfileFor(sampler.id);
    for (const e of profileEntries(profile)) {
      expect(node.params[e.param]).toBeCloseTo((e.min + e.max) / 2, 9);
    }
  });

  it('collapseGhost removes the ghost but leaves params where they were', () => {
    const sampler = findNode(useStudio.getState().workflow, 'sampler')!;
    useStudio.getState().spawnGhost(sampler.id);
    const ghost = useStudio.getState().field.ghosts[0];
    useStudio.getState().moveGhost(ghost.id, { x: 1, y: 1, z: 1 });
    const cfgAfterMove = useStudio.getState().workflow.nodes.find((n) => n.id === sampler.id)!.params.cfg;
    useStudio.getState().collapseGhost(ghost.id);
    expect(useStudio.getState().field.ghosts).toHaveLength(0);
    const cfgAfterCollapse = useStudio.getState().workflow.nodes.find((n) => n.id === sampler.id)!.params.cfg;
    expect(cfgAfterCollapse).toBe(cfgAfterMove);
  });

  it('saveAnchor then restoreAnchor round-trips the param values', () => {
    const sampler = findNode(useStudio.getState().workflow, 'sampler')!;
    useStudio.getState().spawnGhost(sampler.id);
    const ghost = useStudio.getState().field.ghosts[0];
    useStudio.getState().moveGhost(ghost.id, { x: 0.8, y: 0.2, z: 0.6 });
    useStudio.getState().saveAnchor(ghost.id, 'sweet spot');
    const anchor = useStudio.getState().field.anchors[0];
    expect(anchor.name).toBe('sweet spot');
    const savedCfg = useStudio.getState().workflow.nodes.find((n) => n.id === sampler.id)!.params.cfg;

    // Move the ghost away, then restore.
    useStudio.getState().moveGhost(ghost.id, { x: 0, y: 0, z: 0 });
    expect(useStudio.getState().workflow.nodes.find((n) => n.id === sampler.id)!.params.cfg).not.toBe(savedCfg);
    useStudio.getState().restoreAnchor(anchor.id);
    const restoredCfg = useStudio.getState().workflow.nodes.find((n) => n.id === sampler.id)!.params.cfg;
    expect(restoredCfg).toBeCloseTo(savedCfg as number, 9);
    // The ghost returns to the anchor position too.
    expect(useStudio.getState().field.ghosts[0].pos).toEqual(anchor.pos);
  });

  it('deleteAnchor removes it', () => {
    const sampler = findNode(useStudio.getState().workflow, 'sampler')!;
    useStudio.getState().spawnGhost(sampler.id);
    useStudio.getState().saveAnchor(useStudio.getState().field.ghosts[0].id, 'x');
    const anchor = useStudio.getState().field.anchors[0];
    useStudio.getState().deleteAnchor(anchor.id);
    expect(useStudio.getState().field.anchors).toHaveLength(0);
  });

  it('record: start → move → stop produces a playable motion clip set active', () => {
    vi.useFakeTimers();
    try {
      const sampler = findNode(useStudio.getState().workflow, 'sampler')!;
      useStudio.getState().spawnGhost(sampler.id);
      const ghost = useStudio.getState().field.ghosts[0];
      const clipsBefore = useStudio.getState().motion.clips.length;

      useStudio.getState().startGhostRecording(ghost.id);
      expect(useStudio.getState().field.ghosts[0].recording).toBe(true);

      // Simulate a drag over ~200ms: move the ghost, letting the interval sample.
      useStudio.getState().moveGhost(ghost.id, { x: 0.25, y: 0.25, z: 0.25 });
      vi.advanceTimersByTime(100);
      useStudio.getState().moveGhost(ghost.id, { x: 0.75, y: 0.75, z: 0.75 });
      vi.advanceTimersByTime(100);

      useStudio.getState().stopGhostRecording(ghost.id);
      expect(useStudio.getState().field.ghosts[0].recording).toBe(false);

      const motion = useStudio.getState().motion;
      expect(motion.clips.length).toBe(clipsBefore + 1);
      const clip = motion.clips[motion.clips.length - 1];
      expect(motion.activeClipId).toBe(clip.id);
      // One track per driven sampler param, each with >= 2 keyframes (seed + samples).
      expect(clip.tracks.map((t) => t.param).sort()).toEqual(['cfg', 'denoise', 'seed', 'steps'].sort());
      for (const t of clip.tracks) expect(t.keyframes.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stopGhostRecording with no samples/movement never throws and still finalizes', () => {
    vi.useFakeTimers();
    try {
      const sampler = findNode(useStudio.getState().workflow, 'sampler')!;
      useStudio.getState().spawnGhost(sampler.id);
      const ghost = useStudio.getState().field.ghosts[0];
      useStudio.getState().startGhostRecording(ghost.id);
      // Stop immediately (only the seeded t=0 + final sample exist).
      expect(() => useStudio.getState().stopGhostRecording(ghost.id)).not.toThrow();
      expect(useStudio.getState().field.ghosts[0].recording).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
