import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSettleDebouncer, normalizePos, type Vec3 } from '../src/components/field/fieldPreview';

// ---------------------------------------------------------------------------
// createSettleDebouncer — trailing settle debounce for the ghost/orb drag
// stream. Fake timers keep this fully deterministic (no rAF/real-timer flake).
// ---------------------------------------------------------------------------
describe('createSettleDebouncer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires once, with the pushed position, after the quiet period', () => {
    const fire = vi.fn<(pos: Vec3) => void>();
    const deb = createSettleDebouncer(150);
    const pos = { x: 0.2, y: 0.4, z: 0.6 };

    deb.push(pos, fire);
    expect(fire).not.toHaveBeenCalled(); // not before the window elapses
    vi.advanceTimersByTime(149);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fire).toHaveBeenCalledTimes(1);
    expect(fire).toHaveBeenCalledWith(pos);

    // No further fires after it settled once.
    vi.advanceTimersByTime(1000);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('supersedes rapid pushes — only the last position fires once', () => {
    const fire = vi.fn<(pos: Vec3) => void>();
    const deb = createSettleDebouncer(150);

    deb.push({ x: 0.1, y: 0, z: 0 }, fire);
    vi.advanceTimersByTime(50);
    deb.push({ x: 0.2, y: 0, z: 0 }, fire);
    vi.advanceTimersByTime(50);
    deb.push({ x: 0.9, y: 0.8, z: 0.7 }, fire); // newest wins
    vi.advanceTimersByTime(150);

    expect(fire).toHaveBeenCalledTimes(1);
    expect(fire).toHaveBeenCalledWith({ x: 0.9, y: 0.8, z: 0.7 });
  });

  it('restarts the settle window on every push (never fires mid-drag)', () => {
    const fire = vi.fn<(pos: Vec3) => void>();
    const deb = createSettleDebouncer(150);

    deb.push({ x: 0.1, y: 0, z: 0 }, fire);
    vi.advanceTimersByTime(120); // < 150: still pending
    deb.push({ x: 0.2, y: 0, z: 0 }, fire); // resets the clock
    vi.advanceTimersByTime(120); // 240ms total, but only 120 since last push
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30); // now 150 since last push
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('uses the latest fire callback, not the earlier one', () => {
    const fireA = vi.fn<(pos: Vec3) => void>();
    const fireB = vi.fn<(pos: Vec3) => void>();
    const deb = createSettleDebouncer(150);

    deb.push({ x: 0.3, y: 0.3, z: 0.3 }, fireA);
    deb.push({ x: 0.4, y: 0.4, z: 0.4 }, fireB);
    vi.advanceTimersByTime(150);

    expect(fireA).not.toHaveBeenCalled();
    expect(fireB).toHaveBeenCalledTimes(1);
    expect(fireB).toHaveBeenCalledWith({ x: 0.4, y: 0.4, z: 0.4 });
  });

  it('cancel() stops a pending fire', () => {
    const fire = vi.fn<(pos: Vec3) => void>();
    const deb = createSettleDebouncer(150);

    deb.push({ x: 0.5, y: 0.5, z: 0.5 }, fire);
    vi.advanceTimersByTime(100);
    deb.cancel();
    vi.advanceTimersByTime(1000);
    expect(fire).not.toHaveBeenCalled();
  });

  it('can be reused after cancel', () => {
    const fire = vi.fn<(pos: Vec3) => void>();
    const deb = createSettleDebouncer(150);

    deb.push({ x: 0.1, y: 0.1, z: 0.1 }, fire);
    deb.cancel();
    deb.push({ x: 0.2, y: 0.2, z: 0.2 }, fire);
    vi.advanceTimersByTime(150);
    expect(fire).toHaveBeenCalledTimes(1);
    expect(fire).toHaveBeenCalledWith({ x: 0.2, y: 0.2, z: 0.2 });
  });

  it('honors a custom delay', () => {
    const fire = vi.fn<(pos: Vec3) => void>();
    const deb = createSettleDebouncer(40);

    deb.push({ x: 0, y: 0, z: 0 }, fire);
    vi.advanceTimersByTime(39);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('drives its timer through the injected timer surface', () => {
    // A holder object keeps the property's declared type across the deb.push
    // calls (a bare `let` assigned only inside the closure narrows to never).
    const holder: { armed: (() => void) | null } = { armed: null };
    let cleared = 0;
    const timers = {
      set: (cb: () => void) => {
        holder.armed = cb;
        return 7;
      },
      clear: () => {
        cleared += 1;
      },
    };
    const fire = vi.fn<(pos: Vec3) => void>();
    const deb = createSettleDebouncer(150, timers);

    deb.push({ x: 0.5, y: 0.5, z: 0.5 }, fire);
    // Re-arm: the second push must clear the first handle before setting a new one.
    deb.push({ x: 0.6, y: 0.6, z: 0.6 }, fire);
    expect(cleared).toBe(1);
    holder.armed?.();
    expect(fire).toHaveBeenCalledTimes(1);
    expect(fire).toHaveBeenCalledWith({ x: 0.6, y: 0.6, z: 0.6 });
  });
});

// ---------------------------------------------------------------------------
// normalizePos — clamp raw drag positions into [0,1]^3.
// ---------------------------------------------------------------------------
describe('normalizePos', () => {
  it('passes through in-range values unchanged', () => {
    expect(normalizePos({ x: 0.25, y: 0.5, z: 0.75 })).toEqual({ x: 0.25, y: 0.5, z: 0.75 });
  });

  it('clamps values above 1 down to 1', () => {
    expect(normalizePos({ x: 1.4, y: 3, z: 1.0001 })).toEqual({ x: 1, y: 1, z: 1 });
  });

  it('clamps values below 0 up to 0', () => {
    expect(normalizePos({ x: -0.2, y: -5, z: -0.0001 })).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('collapses non-finite axes to 0', () => {
    expect(normalizePos({ x: NaN, y: Infinity, z: -Infinity })).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('keeps the 0 and 1 endpoints', () => {
    expect(normalizePos({ x: 0, y: 1, z: 0 })).toEqual({ x: 0, y: 1, z: 0 });
  });

  it('returns a fresh object (never the input reference)', () => {
    const input = { x: 0.5, y: 0.5, z: 0.5 };
    const out = normalizePos(input);
    expect(out).not.toBe(input);
    expect(out).toEqual(input);
  });
});
