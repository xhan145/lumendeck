/**
 * Regression tests for the adversarial-review fixes on the hardware-profile
 * branch: aspect-preserving clamps, auto-never-constrains, local-bridge-only
 * scope, honest manifests, and the exactly-once safe retry.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRenderJob } from '../src/bridge/adapter';
import { createDefaultWorkflow, findNode } from '../src/core/workflow';
import { httpAdapter, mockAdapter, useStudio } from '../src/state/store';
import {
  applyProfileToJob,
  resolveEffectiveProfile,
  snapshotFromBridgeStatus,
} from '../src/core/hardware';

const OK_RESULT = {
  dataUrl: 'data:image/png;base64,QUJD',
  mediaType: 'image' as const,
  mimeType: 'image/png',
  extension: 'png',
  seed: 9,
};

describe('aspect-preserving profile clamp', () => {
  it('scales both sides uniformly: 1216x832 -> 768x528, never 768x768', () => {
    const job = { ...buildRenderJob(createDefaultWorkflow()), width: 1216, height: 832 };
    const clamped = applyProfileToJob(job, 'gtx_1650_4gb', null);
    expect(clamped.width).toBe(768);
    expect(clamped.height).toBe(528);
  });

  it('keeps within-cap canvases untouched', () => {
    const job = { ...buildRenderJob(createDefaultWorkflow()), width: 640, height: 512 };
    const clamped = applyProfileToJob(job, 'gtx_1650_4gb', null);
    expect(clamped.width).toBe(640);
    expect(clamped.height).toBe(512);
  });

  it('portrait stays portrait: 832x1216 -> 528x768', () => {
    const job = { ...buildRenderJob(createDefaultWorkflow()), width: 832, height: 1216 };
    const clamped = applyProfileToJob(job, 'gtx_1650_4gb', null);
    expect(clamped.width).toBe(528);
    expect(clamped.height).toBe(768);
  });
});

describe('auto never constrains without evidence', () => {
  it('a pre-0.35 bridge status (cuda true, no hardware fields) resolves auto to balanced', () => {
    const snap = snapshotFromBridgeStatus({ cuda: true, device: 'cuda' });
    expect(resolveEffectiveProfile('auto', snap)).toBe('balanced');
  });

  it('a null snapshot resolves auto to balanced (unconstrained), not cpu', () => {
    expect(resolveEffectiveProfile('auto', null)).toBe('balanced');
  });
});

describe('profile scope + safe retry (store wiring)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useStudio.getState().setAdapter('mock');
    useStudio.getState().setHardwareProfile('auto');
  });

  it('never clamps non-bridge renders, even under an explicit constrained profile', async () => {
    useStudio.getState().resetWorkflow();
    const model = findNode(useStudio.getState().workflow, 'model');
    useStudio.getState().updateParam(model!.id, 'assetId', 'ckpt-drift-15');
    useStudio.getState().setHardwareProfile('gtx_1650_4gb');
    useStudio.getState().setAdapter('mock');
    const canvas = findNode(useStudio.getState().workflow, 'canvas');
    useStudio.getState().updateParam(canvas!.id, 'width', 1216);
    useStudio.getState().updateParam(canvas!.id, 'height', 832);
    const generate = vi.spyOn(mockAdapter, 'generate').mockResolvedValue(OK_RESULT);
    await useStudio.getState().enqueueRender();
    expect(generate).toHaveBeenCalledTimes(1);
    const job = generate.mock.calls[0][0];
    // 1216x832 exceeds the 768 cap — a wrongly-applied clamp would shrink it.
    expect(job.width).toBe(1216);
    expect(job.height).toBe(832);
    // ...and the local-GPU directive must not leak into non-bridge payloads.
    expect(job.memoryProfile).toBeUndefined();
    const item = useStudio.getState().gallery[0];
    expect(item.manifest.render?.actualWidth).toBeUndefined();
    expect(item.manifest.render?.safeRetryUsed).toBeUndefined();
  });

  it('runs the OOM safe retry EXACTLY once on the bridge and never persists settings', async () => {
    useStudio.getState().setAdapter('bridge');
    useStudio.getState().setHardwareProfile('gtx_1650_4gb');
    const before = JSON.parse(JSON.stringify(useStudio.getState().appSettings));
    const generate = vi.spyOn(httpAdapter, 'generate').mockResolvedValue({
      ...OK_RESULT,
      fallback: true,
      fallbackReason: 'CUDA out of memory. Tried to allocate 20.00 MiB',
    });
    await useStudio.getState().enqueueRender();
    // original render + ONE retry — a second OOM must never trigger a third call
    expect(generate).toHaveBeenCalledTimes(2);
    const retryJob = generate.mock.calls[1][0];
    expect(retryJob.width).toBe(512);
    expect(retryJob.height).toBe(512);
    expect(retryJob.memoryProfile?.sequentialCpuOffload).toBe(true);
    expect(useStudio.getState().hardwareEvent).toEqual({
      oomCategory: 'cuda_oom',
      fallbackOccurred: true,
      safeRetryUsed: true,
    });
    expect(useStudio.getState().appSettings).toEqual(before);
  });

  it('a successful retry finishes done-with-warning and records the actual dimensions', async () => {
    useStudio.getState().setAdapter('bridge');
    vi.spyOn(httpAdapter, 'generate')
      .mockResolvedValueOnce({ ...OK_RESULT, fallback: true, fallbackReason: 'CUDA out of memory' })
      .mockResolvedValueOnce(OK_RESULT);
    await useStudio.getState().enqueueRender();
    const q = useStudio.getState().queue[0];
    expect(q.status).toBe('done_with_warning');
    expect(q.warning).toMatch(/safe 4GB settings/);
    const item = useStudio.getState().gallery[0];
    expect(item.manifest.render?.safeRetryUsed).toBe(true);
    expect(item.manifest.render?.actualWidth).toBe(512);
    expect(item.manifest.render?.actualHeight).toBe(512);
  });

  it('the worker-tagged fallbackCategory drives classification without message matching', async () => {
    useStudio.getState().setAdapter('bridge');
    const generate = vi.spyOn(httpAdapter, 'generate').mockResolvedValue({
      ...OK_RESULT,
      fallback: true,
      fallbackReason: 'render failed with an opaque driver message',
      fallbackCategory: 'cuda_oom',
    });
    await useStudio.getState().enqueueRender();
    expect(generate).toHaveBeenCalledTimes(2); // category alone triggered the retry
    expect(useStudio.getState().hardwareEvent.oomCategory).toBe('cuda_oom');
  });

  it('a thrown render stamps this render hardware event (no stale OOM report)', async () => {
    useStudio.getState().setAdapter('bridge');
    useStudio.getState().updateBackendSettings({ fallbackToMock: false });
    vi.spyOn(httpAdapter, 'generate').mockRejectedValue(new Error('bridge unreachable'));
    await useStudio.getState().enqueueRender().catch(() => {});
    expect(useStudio.getState().hardwareEvent).toEqual({
      oomCategory: 'other',
      fallbackOccurred: false,
      safeRetryUsed: false,
    });
    useStudio.getState().updateBackendSettings({ fallbackToMock: true });
  });
});

describe('hardware compatibility surfaces in health', () => {
  afterEach(() => {
    useStudio.getState().setHardwareProfile('auto');
    useStudio.getState().resetWorkflow();
  });

  it('a video workflow on the 4GB profile gets a hardware-compat warning', () => {
    useStudio.getState().resetWorkflow();
    const video = findNode(useStudio.getState().workflow, 'video');
    expect(video).toBeTruthy();
    useStudio.getState().updateParam(video!.id, 'enabled', true);
    useStudio.getState().setHardwareProfile('gtx_1650_4gb');
    const issue = useStudio.getState().health.find((i) => i.code === 'hardware-compat');
    expect(issue).toBeTruthy();
    expect(issue!.severity).toBe('warning');
    expect(issue!.message).toMatch(/Unsupported/i);
  });

  it('resetAppSettings recomputes health (no stale constrained warnings survive a reset)', () => {
    useStudio.getState().resetWorkflow();
    const video = findNode(useStudio.getState().workflow, 'video');
    useStudio.getState().updateParam(video!.id, 'enabled', true);
    useStudio.getState().setHardwareProfile('gtx_1650_4gb');
    expect(useStudio.getState().health.some((i) => i.code === 'hardware-compat')).toBe(true);
    useStudio.getState().resetAppSettings();
    // Back to auto (-> balanced, unconstrained): the warning must clear NOW,
    // not on the next workflow edit.
    expect(useStudio.getState().health.some((i) => i.code === 'hardware-compat')).toBe(false);
  });

  it('CPU Mode clamps but emits no compat warnings (no VRAM budget to exceed)', () => {
    useStudio.getState().resetWorkflow();
    const video = findNode(useStudio.getState().workflow, 'video');
    useStudio.getState().updateParam(video!.id, 'enabled', true);
    useStudio.getState().setHardwareProfile('cpu');
    expect(useStudio.getState().health.some((i) => i.code === 'hardware-compat')).toBe(false);
  });

  it('unconstrained profiles add no hardware-compat issues (even for SDXL on balanced)', () => {
    useStudio.getState().resetWorkflow();
    // ckpt-lumen-xl is an SDXL demo checkpoint: `balanced` carries an ADVISORY
    // 8GB budget but must never warn ordinary SDXL users — it is unconstrained.
    const model = findNode(useStudio.getState().workflow, 'model');
    useStudio.getState().updateParam(model!.id, 'assetId', 'ckpt-lumen-xl');
    useStudio.getState().setHardwareProfile('balanced');
    expect(useStudio.getState().health.some((i) => i.code === 'hardware-compat')).toBe(false);
  });
});
