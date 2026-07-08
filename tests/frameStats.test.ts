import { describe, it, expect } from 'vitest';
import { createFrameStats } from '../src/components/graph/graph3d/frameStats';

describe('createFrameStats', () => {
  it('averages a steady frame time to the matching fps', () => {
    const fs = createFrameStats();
    for (let i = 0; i < 300; i++) fs.sample(16.67);
    const s = fs.read();
    expect(s.frameMs).toBeCloseTo(16.67, 1);
    expect(s.fps).toBeCloseTo(60, 0);
    expect(s.samples).toBe(300);
  });

  it('tracks the worst frame over the window and ignores it in the EMA', () => {
    const fs = createFrameStats({ windowSize: 10 });
    for (let i = 0; i < 5; i++) fs.sample(10);
    fs.sample(120); // one spike
    for (let i = 0; i < 4; i++) fs.sample(10);
    expect(fs.read().worstMs).toBe(120);
    expect(fs.read().frameMs).toBeLessThan(60); // EMA not dominated by the spike
  });

  it('rolls the worst-frame window (old spikes age out)', () => {
    const fs = createFrameStats({ windowSize: 3 });
    fs.sample(100);
    fs.sample(10); fs.sample(10); fs.sample(10);
    expect(fs.read().worstMs).toBe(10); // the 100ms spike has left the window
  });

  it('records draw calls and rejects garbage samples', () => {
    const fs = createFrameStats();
    fs.sample(16);
    fs.sample(-5);        // ignored
    fs.sample(NaN);       // ignored
    fs.setDrawCalls(173);
    fs.setDrawCalls(-1);  // ignored
    const s = fs.read();
    expect(s.samples).toBe(1);
    expect(s.drawCalls).toBe(173);
  });

  it('reset clears everything', () => {
    const fs = createFrameStats();
    fs.sample(16); fs.setDrawCalls(50);
    fs.reset();
    const s = fs.read();
    expect(s.samples).toBe(0);
    expect(s.frameMs).toBe(0);
    expect(s.drawCalls).toBe(0);
    expect(s.worstMs).toBe(0);
  });
});
