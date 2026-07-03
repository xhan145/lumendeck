import { useEffect, useMemo, useState } from 'react';
import { findNode } from '../core/workflow';
import { loraOverheadMs } from '../turboForge/loraOptimizer';
import { TURBO_PRESETS } from '../turboForge/presets';
import { TURBO_BACKENDS, type BackendHealth } from '../turboForge/backends';
import type { TurboPresetId } from '../turboForge/types';
import { createRenderPlan } from '../turboForge/renderPlanner';
import { useStudio } from '../state/store';
import { Icon } from './icons';

function msLabel(ms?: number): string {
  if (!ms) return 'No measurement yet';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function TurboForgePanel() {
  const {
    workflow,
    shelf,
    turboPresetId,
    turboBackendId,
    backendSettings,
    turboBenchmarks,
    turboLastPlan,
    turboLastBenchmark,
    setTurboPreset,
    createTurboPlan,
    runTurboBenchmark,
    clearTurboCache,
  } = useStudio();
  const [health, setHealth] = useState<BackendHealth>({ status: 'degraded', message: 'Checking backend...' });
  const plan = useMemo(
    () => turboLastPlan ?? createRenderPlan(workflow, shelf, { presetId: turboPresetId, backendId: turboBackendId, history: turboBenchmarks }),
    [shelf, turboBackendId, turboBenchmarks, turboLastPlan, turboPresetId, workflow],
  );
  const latest = turboLastBenchmark ?? turboBenchmarks[0];
  const modelOk = plan.selectedModel && plan.warnings.every((warning) => warning.code !== 'missing-model' && warning.code !== 'model-not-installed');
  const loraOverhead = loraOverheadMs(plan.selectedLoras);
  const sampler = findNode(workflow, 'sampler');

  useEffect(() => {
    let cancelled = false;
    if (backendSettings.lastHealth && backendSettings.lastHealth.backend === backendSettings.selectedBackend) {
      setHealth({
        status: backendSettings.lastHealth.status,
        message: backendSettings.lastHealth.message,
      });
      return () => {
        cancelled = true;
      };
    }
    TURBO_BACKENDS[plan.selectedBackend].healthCheck().then((result) => {
      if (!cancelled) setHealth(result);
    });
    return () => {
      cancelled = true;
    };
  }, [backendSettings.lastHealth, backendSettings.selectedBackend, plan.selectedBackend]);

  return (
    <section className="rail-section turbo-panel" aria-labelledby="turboforge-title">
      <h3 id="turboforge-title">{Icon.bolt()} TurboForge</h3>
      <p className="turbo-copy">
        TurboForge helps workflows feel faster and fail less by planning renders, caching setup work, and showing measured speedups.
      </p>

      <label className="field">
        <span className="field-label">Performance preset</span>
        <select value={turboPresetId} onChange={(event) => setTurboPreset(event.target.value as TurboPresetId)}>
          {Object.values(TURBO_PRESETS).map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.beginnerLabel}
            </option>
          ))}
        </select>
      </label>

      <div className="turbo-actions">
        <button className="btn primary" type="button" onClick={() => void runTurboBenchmark()}>
          {Icon.bolt()} Benchmark
        </button>
        <button className="btn" type="button" onClick={() => createTurboPlan()}>
          Plan
        </button>
        <button className="btn" type="button" onClick={clearTurboCache}>
          Clear cache
        </button>
      </div>

      <dl className="turbo-metrics">
        <div><dt>Estimated render</dt><dd>{msLabel(plan.estimatedRenderTimeMs)}</dd></div>
        <div><dt>Last render</dt><dd>{msLabel(latest?.timings.totalRenderMs)}</dd></div>
        <div><dt>Measured speedup</dt><dd>{latest?.measuredSpeedupPercent === undefined ? 'Needs baseline' : `${latest.measuredSpeedupPercent.toFixed(1)}%`}</dd></div>
        <div><dt>VRAM estimate</dt><dd>{plan.estimatedVramGB.toFixed(1)} GB</dd></div>
        <div><dt>Backend health</dt><dd className={`status-${health.status}`}>{health.status}</dd></div>
        <div><dt>Selected backend</dt><dd>{backendSettings.selectedBackend}</dd></div>
        <div><dt>Model compatibility</dt><dd>{modelOk ? 'Ready' : 'Needs attention'}</dd></div>
        <div><dt>LoRA overhead</dt><dd>{msLabel(loraOverhead)}</dd></div>
        <div><dt>Cache status</dt><dd>{plan.cacheStatus}</dd></div>
        <div><dt>Compile status</dt><dd>{plan.compileCacheStatus}</dd></div>
      </dl>

      {plan.warnings.length > 0 ? (
        <div className="turbo-warnings" role="status" aria-live="polite">
          {plan.warnings.map((warning) => (
            <div key={`${warning.code}-${warning.message}`} className={`health-item ${warning.severity}`}>
              {warning.severity === 'error' ? Icon.error() : Icon.warning()}
              <span>{warning.message}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="health-empty">{Icon.ok()} Plan looks ready.</div>
      )}

      <details className="expert-settings">
        <summary>Expert settings</summary>
        <dl className="detail-grid">
          <dt>Precision</dt><dd>{plan.optimizationFlags.precision}</dd>
          <dt>Attention backend</dt><dd>{plan.optimizationFlags.xformers ? 'xFormers' : plan.optimizationFlags.scaledDotProductAttention ? 'Scaled dot-product' : 'Default'}</dd>
          <dt>Compile mode</dt><dd>{plan.optimizationFlags.torchCompile ? 'torch.compile' : 'Off'}</dd>
          <dt>TensorRT</dt><dd>{plan.optimizationFlags.tensorRtEngine ? 'Requested' : 'Off'}</dd>
          <dt>ONNX</dt><dd>{plan.optimizationFlags.onnxRuntime ? 'Requested' : 'Off'}</dd>
          <dt>Offload</dt><dd>{plan.optimizationFlags.cpuOffload ? 'CPU' : plan.optimizationFlags.gpuOffload ? 'GPU' : 'None'}</dd>
          <dt>Cache key</dt><dd className="mono">{plan.cacheKey}</dd>
          <dt>Scheduler</dt><dd>{String(sampler?.params.sampler ?? 'euler_a')}</dd>
          <dt>Step count</dt><dd>{plan.steps}</dd>
          <dt>Resolution bucket</dt><dd>{plan.resolution.width}x{plan.resolution.height}</dd>
          <dt>Batch size</dt><dd>{plan.batchSize}</dd>
          <dt>Video chunk size</dt><dd>{plan.frameCount ? '24 frames' : 'Image render'}</dd>
          <dt>Encoder</dt><dd>{plan.optimizationFlags.encoderPreset}</dd>
          <dt>ComfyUI URL</dt><dd>{backendSettings.comfyUrl}</dd>
        </dl>
      </details>
    </section>
  );
}
