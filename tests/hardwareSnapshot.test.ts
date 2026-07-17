import { describe, expect, it } from 'vitest';
import { snapshotFromBridgeStatus, resolveEffectiveProfile } from '../src/core/hardware';

describe('snapshotFromBridgeStatus', () => {
  it('builds a GTX 1650 snapshot from a bridge status that reports ~4GB CUDA', () => {
    const snap = snapshotFromBridgeStatus({
      cuda: true,
      device: 'cuda',
      gpuName: 'NVIDIA GeForce GTX 1650',
      totalVramMb: 4096,
      freeVramMb: 3600,
      computeCapability: '7.5',
      bf16Supported: false,
    });
    expect(snap).not.toBeNull();
    expect(snap?.nvidia).toBe(true);
    expect(snap?.cuda).toBe(true);
    expect(snap?.supportedPrecisions?.fp16).toBe(true);
    expect(snap?.supportedPrecisions?.bf16).toBe(false);
    // auto resolves this snapshot to the 4GB profile (test 4)
    expect(resolveEffectiveProfile('auto', snap)).toBe('gtx_1650_4gb');
  });

  it('resolves auto to balanced (unconstrained) when the bridge reports no CUDA (test 6)', () => {
    const snap = snapshotFromBridgeStatus({ cuda: false, device: 'cpu' });
    expect(snap?.cuda).toBe(false);
    expect(resolveEffectiveProfile('auto', snap)).toBe('balanced');
  });

  it('resolves auto to balanced (unconstrained) when CUDA initialization failed (test 7)', () => {
    const snap = snapshotFromBridgeStatus({ cuda: true, cudaInitFailed: true, gpuName: 'NVIDIA GeForce GTX 1650', totalVramMb: 4096 });
    expect(resolveEffectiveProfile('auto', snap)).toBe('balanced');
  });

  it('returns null for a missing status (startup without a bridge, test 24)', () => {
    expect(snapshotFromBridgeStatus(null)).toBeNull();
    expect(snapshotFromBridgeStatus(undefined)).toBeNull();
    expect(resolveEffectiveProfile('auto', snapshotFromBridgeStatus(null))).toBe('balanced');
  });
});
