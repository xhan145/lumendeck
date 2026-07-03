import type { HardwareInfo, PipelineTimingKey, PipelineTimings, RuntimeInfo } from './types';

export class TurboProfiler {
  private marks = new Map<string, number>();
  private timings: PipelineTimings = {};

  mark(label: string): void {
    this.marks.set(label, performance.now());
  }

  measure(key: PipelineTimingKey, startLabel: string, endLabel?: string): number {
    const start = this.marks.get(startLabel);
    if (start === undefined) return 0;
    const end = endLabel ? this.marks.get(endLabel) : performance.now();
    if (end === undefined) return 0;
    const elapsed = Math.max(0, end - start);
    this.timings[key] = elapsed;
    return elapsed;
  }

  set(key: PipelineTimingKey, valueMs: number): void {
    this.timings[key] = Math.max(0, valueMs);
  }

  snapshot(): PipelineTimings {
    return { ...this.timings };
  }
}

export function collectBrowserHardwareInfo(backendName: string): HardwareInfo {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const memory = nav && 'deviceMemory' in nav ? Number((nav as Navigator & { deviceMemory?: number }).deviceMemory) : undefined;
  return {
    cpuName: nav?.platform,
    gpuName: 'Browser GPU unavailable',
    ramGB: Number.isFinite(memory) ? memory : undefined,
    backendName,
  };
}

export function createRuntimeInfo(input: Omit<RuntimeInfo, 'dateTime'>): RuntimeInfo {
  return { ...input, dateTime: new Date().toISOString() };
}
