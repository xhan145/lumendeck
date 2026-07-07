import { describe, expect, it } from 'vitest';
import {
  computeBands,
  computeNBands,
  smooth,
  scaleBands,
  DEFAULT_LAYOUT,
  type Bands,
} from '../src/core/audio/bands';
import {
  applyAudio,
  DEFAULT_MAPPING,
  AUDIO_AXIS_UNIT,
  AUDIO_SCALE_UNIT,
  type AudioMapping,
  type AudioReaction,
} from '../src/core/audio/mapping';
import { audioToClip, audioTrackParam, type AudioSample } from '../src/core/audio/audioToClip';
import { createDefaultWorkflow, findNode } from '../src/core/workflow';

// ---------------------------------------------------------------------------
// helpers — synthetic FFT frames (no real AudioContext anywhere in tests)
// ---------------------------------------------------------------------------
/** A Uint8Array of length `n` filled with `v` (0..255). */
const fill = (n: number, v: number): Uint8Array => new Uint8Array(n).fill(v);
/** A Uint8Array of length `n` where [lo,hi) is `v`, else 0. */
const band = (n: number, lo: number, hi: number, v: number): Uint8Array => {
  const a = new Uint8Array(n);
  for (let i = lo; i < hi; i++) a[i] = v;
  return a;
};

// ---------------------------------------------------------------------------
// computeBands — bin averaging, normalization, layout
// ---------------------------------------------------------------------------
describe('computeBands', () => {
  it('empty frame -> all zero bands', () => {
    expect(computeBands(new Uint8Array(0))).toEqual({ bass: 0, mid: 0, treble: 0, level: 0 });
  });

  it('all-max frame -> every band and level normalize to 1', () => {
    expect(computeBands(fill(512, 255))).toEqual({ bass: 1, mid: 1, treble: 1, level: 1 });
  });

  it('normalizes a flat frame to byte/255 on every band', () => {
    const b = computeBands(fill(512, 128));
    expect(b.bass).toBeCloseTo(128 / 255, 6);
    expect(b.mid).toBeCloseTo(128 / 255, 6);
    expect(b.treble).toBeCloseTo(128 / 255, 6);
    expect(b.level).toBeCloseTo(128 / 255, 6);
  });

  it('averages the correct bins per band (bass-heavy frame)', () => {
    // length 100: bins [0,12) full (bass), everything else silent.
    const b = computeBands(band(100, 0, 12, 255), DEFAULT_LAYOUT);
    expect(b.bass).toBeCloseTo(1, 6); // all of the bass range is full
    expect(b.mid).toBe(0);
    expect(b.treble).toBe(0);
    expect(b.level).toBeCloseTo(12 / 100, 6); // only 12 of 100 bins are lit
    expect(b.bass).toBeGreaterThan(b.treble);
  });

  it('respects a custom layout split', () => {
    // Half-and-half frame; a 0.5 midEnd puts the lit half entirely in bass+mid.
    const b = computeBands(band(100, 0, 50, 255), { bassEnd: 0.25, midEnd: 0.5 });
    expect(b.bass).toBeCloseTo(1, 6); // [0,25) all lit
    expect(b.mid).toBeCloseTo(1, 6); // [25,50) all lit
    expect(b.treble).toBe(0); // [50,100) silent
  });
});

// ---------------------------------------------------------------------------
// computeNBands — N-band split
// ---------------------------------------------------------------------------
describe('computeNBands', () => {
  it('returns exactly n normalized values', () => {
    const out = computeNBands(fill(512, 255), 8);
    expect(out).toHaveLength(8);
    for (const v of out) expect(v).toBeCloseTo(1, 6);
  });

  it('clamps n to at least 1', () => {
    expect(computeNBands(fill(64, 255), 0)).toHaveLength(1);
    expect(computeNBands(fill(64, 255), -5)).toHaveLength(1);
  });

  it('empty frame -> n zeros', () => {
    expect(computeNBands(new Uint8Array(0), 4)).toEqual([0, 0, 0, 0]);
  });

  it('splits into contiguous groups (low-loud, high-silent)', () => {
    const out = computeNBands(band(100, 0, 50, 255), 2);
    expect(out[0]).toBeCloseTo(1, 6); // first half loud
    expect(out[1]).toBe(0); // second half silent
  });
});

// ---------------------------------------------------------------------------
// smooth — one-pole convergence + factor bounds
// ---------------------------------------------------------------------------
describe('smooth', () => {
  it('factor 0 -> fully responsive (returns next)', () => {
    expect(smooth(0, 10, 0)).toBe(10);
  });

  it('factor 1 -> frozen (returns prev)', () => {
    expect(smooth(3, 10, 1)).toBe(3);
  });

  it('factor 0.5 -> midpoint', () => {
    expect(smooth(0, 10, 0.5)).toBeCloseTo(5, 12);
  });

  it('output always lies within [min(prev,next), max(prev,next)]', () => {
    for (const f of [0, 0.2, 0.5, 0.8, 1]) {
      const y = smooth(2, 8, f);
      expect(y).toBeGreaterThanOrEqual(2);
      expect(y).toBeLessThanOrEqual(8);
    }
  });

  it('converges toward a fixed target under repeated application', () => {
    let v = 0;
    for (let i = 0; i < 50; i++) v = smooth(v, 1, 0.6);
    expect(v).toBeCloseTo(1, 3);
    expect(v).toBeLessThan(1); // approaches but (for factor>0) never overshoots
  });

  it('clamps out-of-range factors', () => {
    expect(smooth(0, 10, -1)).toBe(10); // treated as 0
    expect(smooth(3, 10, 5)).toBe(3); // treated as 1
  });
});

// ---------------------------------------------------------------------------
// scaleBands — sensitivity multiply + re-clamp
// ---------------------------------------------------------------------------
describe('scaleBands', () => {
  it('multiplies each band and re-clamps to 0..1', () => {
    const b: Bands = { bass: 0.25, mid: 0.5, treble: 0.1, level: 0.4 };
    const s = scaleBands(b, 2);
    expect(s.bass).toBeCloseTo(0.5, 9);
    expect(s.mid).toBe(1); // 1.0 clamps
    expect(s.treble).toBeCloseTo(0.2, 9);
    expect(s.level).toBeCloseTo(0.8, 9);
  });
});

// ---------------------------------------------------------------------------
// applyAudio — band -> offset/ring per target + gain
// ---------------------------------------------------------------------------
describe('applyAudio', () => {
  const bands: Bands = { bass: 0.5, mid: 0.25, treble: 0.1, level: 0.5 };

  it('maps axis targets to world offsets scaled by gain', () => {
    const mapping: AudioMapping = { targets: [{ band: 'bass', kind: 'x', nodeId: 'n1', gain: 2 }] };
    const { offsets } = applyAudio(bands, mapping);
    const off = offsets.get('n1')!;
    expect(off.dx).toBeCloseTo(0.5 * 2 * AUDIO_AXIS_UNIT, 9);
    expect(off.dy).toBe(0);
    expect(off.dz).toBe(0);
    expect(off.scale).toBe(1); // identity scale when no scale target
  });

  it('maps a scale target on top of the identity scale', () => {
    const mapping: AudioMapping = { targets: [{ band: 'mid', kind: 'scale', nodeId: 'n1', gain: 1 }] };
    const off = applyAudio(bands, mapping).offsets.get('n1')!;
    expect(off.scale).toBeCloseTo(1 + 0.25 * AUDIO_SCALE_UNIT, 9);
  });

  it('maps a ring target to a clamped 0..1 value with no offset entry', () => {
    const mapping: AudioMapping = { targets: [{ band: 'treble', kind: 'ring', nodeId: 'n2', gain: 1 }] };
    const { offsets, ringValues } = applyAudio(bands, mapping);
    expect(ringValues.get('n2')).toBeCloseTo(0.1, 9);
    expect(offsets.has('n2')).toBe(false); // ring-only node has no spatial offset
  });

  it('clamps ring values to 1 under a big gain', () => {
    const mapping: AudioMapping = { targets: [{ band: 'bass', kind: 'ring', nodeId: 'n1', gain: 5 }] };
    expect(applyAudio(bands, mapping).ringValues.get('n1')).toBe(1); // 0.5*5=2.5 -> 1
  });

  it('accumulates multiple targets on the same node', () => {
    const mapping: AudioMapping = {
      targets: [
        { band: 'bass', kind: 'x', nodeId: 'n1', gain: 1 },
        { band: 'mid', kind: 'y', nodeId: 'n1', gain: 1 },
        { band: 'treble', kind: 'scale', nodeId: 'n1', gain: 1 },
      ],
    };
    const off = applyAudio(bands, mapping).offsets.get('n1')!;
    expect(off.dx).toBeCloseTo(0.5 * AUDIO_AXIS_UNIT, 9);
    expect(off.dy).toBeCloseTo(0.25 * AUDIO_AXIS_UNIT, 9);
    expect(off.scale).toBeCloseTo(1 + 0.1 * AUDIO_SCALE_UNIT, 9);
  });

  it('accumulates onto a base reaction without mutating it', () => {
    const base: AudioReaction = applyAudio(bands, { targets: [{ band: 'bass', kind: 'x', nodeId: 'n1', gain: 1 }] });
    const baseDx = base.offsets.get('n1')!.dx;
    const next = applyAudio(bands, { targets: [{ band: 'bass', kind: 'x', nodeId: 'n1', gain: 1 }] }, base);
    expect(next.offsets.get('n1')!.dx).toBeCloseTo(baseDx * 2, 9);
    // base is untouched
    expect(base.offsets.get('n1')!.dx).toBeCloseTo(baseDx, 9);
  });

  it('empty mapping -> empty reaction', () => {
    const { offsets, ringValues } = applyAudio(bands, { targets: [] });
    expect(offsets.size).toBe(0);
    expect(ringValues.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_MAPPING — curated starting wiring
// ---------------------------------------------------------------------------
describe('DEFAULT_MAPPING', () => {
  it('wires bass->scale/ring, mid->X, treble->Y on the sampler orb', () => {
    const wf = createDefaultWorkflow();
    const sampler = findNode(wf, 'sampler')!;
    const m = DEFAULT_MAPPING(wf);
    expect(m.targets.every((t) => t.nodeId === sampler.id)).toBe(true);
    const kindsByBand = m.targets.map((t) => `${t.band}:${t.kind}`).sort();
    expect(kindsByBand).toEqual(['bass:ring', 'bass:scale', 'mid:x', 'treble:y'].sort());
  });

  it('empty workflow -> no targets', () => {
    expect(DEFAULT_MAPPING({ nodes: [], edges: [] } as never).targets).toEqual([]);
  });

  it('is pure/deterministic', () => {
    const wf = createDefaultWorkflow();
    expect(DEFAULT_MAPPING(wf)).toEqual(DEFAULT_MAPPING(wf));
  });
});

// ---------------------------------------------------------------------------
// audioToClip — samples -> MotionClip (tracks/keyframes/ids/times/empty)
// ---------------------------------------------------------------------------
describe('audioToClip', () => {
  const mk = (bass: number, mid: number, treble: number): Bands => ({ bass, mid, treble, level: (bass + mid + treble) / 3 });
  const mapping: AudioMapping = {
    targets: [
      { band: 'bass', kind: 'scale', nodeId: 'n1', gain: 1 },
      { band: 'mid', kind: 'x', nodeId: 'n1', gain: 1 },
      { band: 'treble', kind: 'ring', nodeId: 'n1', gain: 1 },
      { band: 'bass', kind: 'y', nodeId: 'other', gain: 1 }, // different node — ignored
    ],
  };
  const samples: AudioSample[] = [
    { t: 0, bands: mk(0, 0, 0) },
    { t: 0.5, bands: mk(0.5, 0.5, 0.5) },
    { t: 1, bands: mk(1, 1, 1) },
  ];

  it('emits one track per matching target (in mapping order), namespaced params', () => {
    const clip = audioToClip(samples, mapping, 'n1');
    expect(clip.tracks.map((t) => t.param)).toEqual([
      audioTrackParam('scale'),
      audioTrackParam('x'),
      audioTrackParam('ring'),
    ]);
    for (const t of clip.tracks) expect(t.nodeId).toBe('n1');
  });

  it('each track has N keyframes at the sample times', () => {
    const clip = audioToClip(samples, mapping, 'n1');
    for (const t of clip.tracks) {
      expect(t.keyframes).toHaveLength(samples.length);
      expect(t.keyframes.map((k) => k.t)).toEqual([0, 0.5, 1]);
    }
  });

  it('keyframe values equal the channel reaction at each sample', () => {
    const clip = audioToClip(samples, mapping, 'n1');
    const xTrack = clip.tracks.find((t) => t.param === audioTrackParam('x'))!;
    // mid -> X: dx = mid * gain * AUDIO_AXIS_UNIT
    expect(xTrack.keyframes.map((k) => k.value)).toEqual([
      0 * AUDIO_AXIS_UNIT,
      0.5 * AUDIO_AXIS_UNIT,
      1 * AUDIO_AXIS_UNIT,
    ]);
    const ringTrack = clip.tracks.find((t) => t.param === audioTrackParam('ring'))!;
    expect(ringTrack.keyframes.map((k) => k.value)).toEqual([0, 0.5, 1]); // treble clamped 0..1
  });

  it('mints unique, non-empty ids on every track and keyframe', () => {
    const clip = audioToClip(samples, mapping, 'n1');
    const kfIds = clip.tracks.flatMap((t) => t.keyframes.map((k) => k.id));
    expect(kfIds.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(kfIds).size).toBe(kfIds.length);
    const trackIds = clip.tracks.map((t) => t.id);
    expect(new Set(trackIds).size).toBe(trackIds.length);
  });

  it('duration = last sample time; loop off (a captured performance)', () => {
    const clip = audioToClip(samples, mapping, 'n1');
    expect(clip.duration).toBe(1);
    expect(clip.loop).toBe(false);
  });

  it('dedupes targets that share a channel kind for the node', () => {
    const dup: AudioMapping = {
      targets: [
        { band: 'bass', kind: 'x', nodeId: 'n1', gain: 1 },
        { band: 'mid', kind: 'x', nodeId: 'n1', gain: 1 }, // same channel -> dropped
      ],
    };
    const clip = audioToClip(samples, dup, 'n1');
    expect(clip.tracks).toHaveLength(1);
    expect(clip.tracks[0].param).toBe(audioTrackParam('x'));
  });

  it('empty samples OR no matching targets -> a clip with no tracks', () => {
    expect(audioToClip([], mapping, 'n1').tracks).toEqual([]);
    expect(audioToClip([], mapping, 'n1').duration).toBe(0);
    expect(audioToClip(samples, mapping, 'nobody').tracks).toEqual([]);
    expect(audioToClip(samples, { targets: [] }, 'n1').tracks).toEqual([]);
  });
});
