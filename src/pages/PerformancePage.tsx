import { useMemo } from 'react';
import { findNode } from '../core/workflow';
import { useStudio } from '../state/store';
import { TURBO_PRESETS } from '../turboForge/presets';
import { createRenderPlan } from '../turboForge/renderPlanner';
import { TurboForgePanel } from '../components/TurboForgePanel';
import { HardwareProfilePanel } from '../components/HardwareProfilePanel';

const PRESET_COPY: Record<string, string> = {
  safe: 'Safe: most reliable.',
  fast: 'Fast: good default.',
  turbo: 'Turbo: faster if the model/backend supports it.',
  forge: 'Forge: aggressive compile/cache path.',
  eco: 'Eco: lower memory.',
  draft: 'Draft: fast preview.',
  final: 'Final: quality export.',
};

function msLabel(ms?: number): string {
  if (!ms) return 'No measurement';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export function PerformancePage() {
  const {
    backendSettings,
    bridgeModelStatus,
    shelf,
    turboBackendId,
    turboBenchmarks,
    turboLastBenchmark,
    turboLastPlan,
    turboPresetId,
    workflow,
  } = useStudio();
  const plan = useMemo(
    () => turboLastPlan ?? createRenderPlan(workflow, shelf, { presetId: turboPresetId, backendId: turboBackendId, history: turboBenchmarks }),
    [shelf, turboBackendId, turboBenchmarks, turboLastPlan, turboPresetId, workflow],
  );
  const latest = turboLastBenchmark ?? turboBenchmarks[0];
  const model = findNode(workflow, 'model');
  const selectedModel = shelf.find((asset) => asset.id === String(model?.params.assetId ?? ''));

  return (
    <main className="studio-page performance-page scroll" aria-label="Performance">
      <div className="studio-page-inner">
        <header className="page-hero">
          <div>
            <p className="page-kicker">Performance</p>
            <h1>TurboForge Bench & Plan</h1>
            <p>Plan acceleration, inspect real benchmark history, and keep speed claims separate from measurements.</p>
          </div>
        </header>

        <section className="page-grid">
          <article className="card page-card wide">
            <TurboForgePanel />
          </article>

          <HardwareProfilePanel />

          <article className="card page-card">
            <div className="page-card-head">
              <h2>Last Render Plan</h2>
              <span className="chip">{plan.selectedPreset}</span>
            </div>
            <dl className="page-metrics">
              <Metric label="Selected backend" value={backendSettings.selectedBackend} />
              <Metric label="Turbo backend" value={plan.selectedBackend} />
              <Metric label="Model" value={selectedModel?.name ?? plan.selectedModel ?? 'No model selected'} />
              <Metric label="Preset" value={TURBO_PRESETS[plan.selectedPreset]?.beginnerLabel ?? plan.selectedPreset} />
              <Metric label="Steps" value={`${plan.steps}`} />
              <Metric label="Resolution" value={`${plan.resolution.width}x${plan.resolution.height}`} />
              <Metric label="VRAM estimate" value={`${plan.estimatedVramGB.toFixed(1)} GB`} />
              <Metric label="Warnings" value={`${plan.warnings.length}`} />
            </dl>
            {plan.warnings.length ? (
              <ul className="guide-issue-list">
                {plan.warnings.map((warning) => <li key={`${warning.code}-${warning.message}`}>{warning.message}</li>)}
              </ul>
            ) : <p className="field-help">The current plan has no blocking warnings.</p>}
          </article>

          <article className="card page-card">
            <div className="page-card-head">
              <h2>Optimization Flags</h2>
              <span className="chip">{plan.cacheStatus}</span>
            </div>
            <dl className="page-metrics">
              <Metric label="Precision" value={plan.optimizationFlags.precision} />
              <Metric label="xFormers" value={plan.optimizationFlags.xformers ? 'on' : 'off'} />
              <Metric label="SDPA" value={plan.optimizationFlags.scaledDotProductAttention ? 'on' : 'off'} />
              <Metric label="torch.compile" value={plan.optimizationFlags.torchCompile ? 'on' : 'off'} />
              <Metric label="TensorRT" value={plan.optimizationFlags.tensorRtEngine ? 'requested' : 'off'} />
              <Metric label="ONNX" value={plan.optimizationFlags.onnxRuntime ? 'requested' : 'off'} />
              <Metric label="Compile/cache" value={plan.compileCacheStatus} />
              <Metric label="CUDA" value={bridgeModelStatus?.cuda ? 'available' : 'not confirmed'} />
            </dl>
          </article>

          <article className="card page-card">
            <div className="page-card-head">
              <h2>Benchmark History</h2>
              <span className="chip">{turboBenchmarks.length} runs</span>
            </div>
            <dl className="page-metrics">
              <Metric label="Last benchmark" value={latest ? new Date(latest.createdAt).toLocaleString() : 'No benchmark yet'} />
              <Metric label="Total render" value={msLabel(latest?.timings.totalRenderMs)} />
              <Metric label="Backend request" value={msLabel(latest?.timings.backendRequestMs)} />
              <Metric label="Queue / wait" value={msLabel(latest?.timings.renderQueueMs)} />
              <Metric label="Output fetch" value={msLabel(latest?.timings.outputFetchMs)} />
              <Metric label="Model load" value={msLabel(latest?.timings.modelLoadMs)} />
              <Metric label="LoRA load" value={msLabel(latest?.timings.loraLoadMs)} />
              <Metric label="Measured speedup" value={latest?.measuredSpeedupPercent === undefined ? 'No baseline' : `${latest.measuredSpeedupPercent.toFixed(1)}%`} />
            </dl>
            <p className="field-help">Speedup is shown only when a matching baseline exists. Estimates are planning hints, not benchmark numbers.</p>
          </article>

          <article className="card page-card wide">
            <div className="page-card-head">
              <h2>Preset Guide</h2>
              <span className="chip">plain English</span>
            </div>
            <div className="preset-guide-grid">
              {Object.entries(PRESET_COPY).map(([id, copy]) => (
                <div key={id} className={`preset-guide-tile ${id === turboPresetId ? 'active' : ''}`}>
                  <strong>{id}</strong>
                  <span>{copy}</span>
                </div>
              ))}
            </div>
          </article>
        </section>
      </div>
    </main>
  );
}
