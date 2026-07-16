import { describe, it, expect } from 'vitest';
import {
  MAX_PULSES,
  PULSE_LIFETIME,
  PULSE_SPEED,
  prunePulses,
  pushPulse,
  valueNoise3,
  velocityAt,
  type FlowContext,
  type FlowPulse,
} from '../src/components/graph/graph3d/flowField';

const EMPTY: FlowContext = { bodies: [], pulses: [], eddy: null };
const v = () => ({ x: 0, y: 0, z: 0 });

describe('valueNoise3', () => {
  it('is deterministic and bounded to [0, 1]', () => {
    expect(valueNoise3(1.3, 4.7, -2.2)).toBe(valueNoise3(1.3, 4.7, -2.2));
    for (let i = 0; i < 50; i++) {
      const n = valueNoise3(i * 0.7, i * -1.3, i * 2.1);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(1);
    }
  });

  it('varies across space (not a constant field)', () => {
    const a = valueNoise3(0.2, 0.2, 0.2);
    const b = valueNoise3(5.7, 1.9, -3.3);
    expect(a).not.toBeCloseTo(b, 6);
  });
});

describe('velocityAt — curl term', () => {
  it('the planar XZ component is divergence-free (numeric check across samples)', () => {
    // div_xz(v) = ∂vx/∂x + ∂vz/∂z should vanish for a curl-of-scalar field.
    const h = 0.01;
    for (const [px, pz] of [[0.7, -1.2], [3.1, 4.4], [-2.6, 0.9], [8.8, -7.7]]) {
      const vxp = velocityAt(px + h, 0, pz, 2.5, EMPTY, 0, v()).x;
      const vxm = velocityAt(px - h, 0, pz, 2.5, EMPTY, 0, v()).x;
      const vzp = velocityAt(px, 0, pz + h, 2.5, EMPTY, 0, v()).z;
      const vzm = velocityAt(px, 0, pz - h, 2.5, EMPTY, 0, v()).z;
      const div = (vxp - vxm) / (2 * h) + (vzp - vzm) / (2 * h);
      expect(Math.abs(div)).toBeLessThan(0.05); // ≈0 up to finite-difference error
    }
  });

  it('is deterministic and writes into the out-param without allocating', () => {
    const out = v();
    const r = velocityAt(1, 2, 3, 4, EMPTY, 0, out);
    expect(r).toBe(out);
    const again = velocityAt(1, 2, 3, 4, EMPTY, 0, v());
    expect(again.x).toBe(out.x);
    expect(again.z).toBe(out.z);
  });

  it('evolves over time (the swirl is alive), frozen time ⇒ frozen field', () => {
    const a = velocityAt(1, 0, 1, 0, EMPTY, 0, v());
    const b = velocityAt(1, 0, 1, 30, EMPTY, 0, v());
    expect(Math.abs(a.x - b.x) + Math.abs(a.z - b.z)).toBeGreaterThan(1e-6);
    const f1 = velocityAt(1, 0, 1, 12, EMPTY, 0, v());
    const f2 = velocityAt(1, 0, 1, 12, EMPTY, 999999, v()); // nowMs only affects pulses
    expect(f1).toEqual(f2);
  });
});

describe('velocityAt — wakes', () => {
  it('a moving body drags nearby fluid along its velocity', () => {
    const ctx: FlowContext = {
      bodies: [{ x: 0, y: 0, z: 0, vx: 5, vy: 0, vz: 0, radius: 1 }],
      pulses: [],
      eddy: null,
    };
    const near = velocityAt(0.3, 0, 0, 0, ctx, 0, v());
    const base = velocityAt(0.3, 0, 0, 0, EMPTY, 0, v());
    expect(near.x - base.x).toBeGreaterThan(2); // strong drag near the body
    const far = velocityAt(40, 0, 0, 0, ctx, 0, v());
    expect(Math.abs(far.x - velocityAt(40, 0, 0, 0, EMPTY, 0, v()).x)).toBeLessThan(1e-6);
  });

  it('stationary bodies leave no wake', () => {
    const ctx: FlowContext = {
      bodies: [{ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, radius: 2 }],
      pulses: [],
      eddy: null,
    };
    expect(velocityAt(0.5, 0, 0, 3, ctx, 0, v())).toEqual(velocityAt(0.5, 0, 0, 3, EMPTY, 0, v()));
  });
});

describe('velocityAt — pulses', () => {
  const pulse: FlowPulse = { x: 0, y: 0, z: 0, t0: 0, amp: 3 };

  it('pushes radially outward at the expanding ring', () => {
    const age = 0.4;
    const ringR = PULSE_SPEED * age;
    const ctx: FlowContext = { bodies: [], pulses: [pulse], eddy: null };
    const at = velocityAt(ringR, 0, 0, 0, ctx, age * 1000, v());
    const base = velocityAt(ringR, 0, 0, 0, EMPTY, 0, v());
    expect(at.x - base.x).toBeGreaterThan(0.3); // outward (+x from origin)
  });

  it('decays to nothing past its lifetime', () => {
    const ctx: FlowContext = { bodies: [], pulses: [pulse], eddy: null };
    const late = (PULSE_LIFETIME + 0.2) * 1000;
    expect(velocityAt(2, 0, 0, 5, ctx, late, v())).toEqual(velocityAt(2, 0, 0, 5, EMPTY, late, v()));
  });
});

describe('velocityAt — eddy', () => {
  it('stirs tangentially (perpendicular to the radial direction)', () => {
    const ctx: FlowContext = { bodies: [], pulses: [], eddy: { x: 0, y: 0, z: 0, strength: 2, radius: 2 } };
    const at = velocityAt(1, 0, 0, 0, ctx, 0, v()); // radial = +x → tangential = +z
    const base = velocityAt(1, 0, 0, 0, EMPTY, 0, v());
    expect(Math.abs(at.z - base.z)).toBeGreaterThan(0.3);
    expect(Math.abs(at.x - base.x)).toBeLessThan(1e-6); // no radial push from the eddy
  });
});

describe('pulse queue', () => {
  it('pushPulse caps at MAX_PULSES dropping the oldest', () => {
    let pulses: readonly FlowPulse[] = [];
    for (let i = 0; i < MAX_PULSES + 3; i++) {
      pulses = pushPulse(pulses, { x: i, y: 0, z: 0, t0: i, amp: 1 });
    }
    expect(pulses.length).toBe(MAX_PULSES);
    expect(pulses[0].x).toBe(3); // oldest three dropped
  });

  it('prunePulses drops expired ones and keeps the reference when none expired', () => {
    const fresh: readonly FlowPulse[] = [{ x: 0, y: 0, z: 0, t0: 1000, amp: 1 }];
    expect(prunePulses(fresh, 1100)).toBe(fresh);
    const pruned = prunePulses(fresh, 1000 + (PULSE_LIFETIME + 1) * 1000);
    expect(pruned.length).toBe(0);
  });

  it('prunePulses is a same-reference no-op on the empty steady state (runs every frame)', () => {
    const empty: readonly FlowPulse[] = [];
    expect(prunePulses(empty, 123456)).toBe(empty);
  });
});
