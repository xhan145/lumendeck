import { useMemo } from 'react';
import { buildRenderJob } from '../bridge/adapter';
import { findAsset } from '../core/shelf';
import { useStudio } from '../state/store';
import {
  HARDWARE_PROFILE_IDS,
  estimateVramBudget,
  getHardwareProfile,
  isConstrainedProfile,
  type EffectiveProfileId,
  type HardwareProfileId,
  type MemoryBudgetRequest,
} from '../core/hardware';

const PROFILE_LABELS: Record<HardwareProfileId, string> = {
  auto: 'Automatic',
  gtx_1650_4gb: 'GTX 1650 4GB',
  balanced: 'Balanced',
  high_performance: 'High Performance',
  cpu: 'CPU Mode',
};

function yn(value: boolean | undefined): string {
  if (value === undefined) return 'unknown';
  return value ? 'on' : 'off';
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/**
 * Hardware / performance profile selector + optimization status. Honesty rules:
 * limits are only shown as enforced when the active profile actually enforces
 * them (constrained profiles), the optimization rows are labelled as applying
 * to LOCAL bridge renders only, and the VRAM figure is an estimate — never a
 * guarantee.
 */
export function HardwareProfilePanel() {
  const {
    appSettings,
    setHardwareProfile,
    hardwareDiagnostics,
    workflow,
    shelf,
    backendSettings,
  } = useStudio();
  const diag = hardwareDiagnostics();
  const selected = appSettings.hardwareProfile;
  const effective = diag.effectiveProfile as EffectiveProfileId;
  const profile = getHardwareProfile(effective);
  const constrained = isConstrainedProfile(effective);
  const isFourGb = effective === 'gtx_1650_4gb';
  const resolvedHint = selected === 'auto' ? ` → ${PROFILE_LABELS[effective] ?? effective}` : '';
  const localBridge = backendSettings.selectedBackend === 'bridge';

  // Deterministic VRAM estimate for the CURRENT workflow under the active
  // profile (constrained profiles only — unconstrained profiles impose no budget).
  const budget = useMemo(() => {
    if (!constrained || profile.vramBudgetMb == null) return null;
    const job = buildRenderJob(workflow);
    const mem = profile.memoryOptimizations;
    const request: MemoryBudgetRequest = {
      profileId: effective,
      modelFamily: (findAsset(shelf, job.modelId ?? '')?.family ?? 'Unknown') as MemoryBudgetRequest['modelFamily'],
      width: job.width,
      height: job.height,
      batchSize: 1,
      controlNetCount: job.controlNets?.length ?? 0,
      loraCount: job.loras.length,
      vaeMode: mem.vaeTiling ? 'tiled' : mem.vaeSlicing ? 'sliced' : 'default',
      upscaler: (job.hiresScale ?? 1) > 1,
      refiner: false,
      livePreview: false,
      cpuOffload: mem.modelCpuOffload,
    };
    return estimateVramBudget(request);
  }, [constrained, effective, profile, workflow, shelf]);

  return (
    <article className="card page-card">
      <div className="page-card-head">
        <h2>Hardware Profile</h2>
        <span className="chip">{isFourGb ? profile.statusLabel : PROFILE_LABELS[effective] ?? effective}</span>
      </div>

      <label className="field">
        <span className="field-label">Profile{resolvedHint && <span className="field-help">Automatic{resolvedHint}</span>}</span>
        <select
          value={selected}
          onChange={(event) => setHardwareProfile(event.target.value as HardwareProfileId)}
          aria-label="Hardware profile"
        >
          {HARDWARE_PROFILE_IDS.map((id) => (
            <option key={id} value={id}>{PROFILE_LABELS[id]}</option>
          ))}
        </select>
      </label>

      <p className="field-help">{profile.description}</p>
      {isFourGb && (
        <p className="field-help">
          Uses conservative memory settings for GTX 1650-class GPUs. Generation may be slower because some model
          components can be moved to system memory. Limits are estimates that reduce out-of-memory risk — they
          cannot guarantee a render never exceeds 4 GB.
        </p>
      )}
      {!localBridge && (
        <p className="field-help">
          Hardware profiles shape <b>local Diffusers bridge</b> renders only — the current backend
          ({backendSettings.selectedBackend}) ignores them, so nothing below constrains it.
        </p>
      )}

      {budget && (
        <div
          className={`backend-health status-${budget.status === 'safe' ? 'healthy' : budget.status === 'warning' ? 'degraded' : 'unavailable'}`}
          role="status"
        >
          <strong>{budget.status}</strong>
          <span>
            Current workflow: ~{budget.estimatedVramMb} MB of the {profile.vramBudgetMb} MB budget
            (deterministic estimate, not a measurement).
            {budget.recommendedChanges.length > 0 ? ` ${budget.recommendedChanges[0]}` : ''}
          </span>
        </div>
      )}

      <p className="field-help">Planned optimizations for local Diffusers renders (applied by the worker at render time):</p>
      <dl className="page-metrics">
        <Metric label="Detected GPU" value={diag.gpuName ?? 'None detected'} />
        <Metric label="Total VRAM" value={diag.totalVramMb != null ? `${diag.totalVramMb} MB` : 'unknown'} />
        <Metric label="Available VRAM" value={diag.freeVramMb != null ? `${diag.freeVramMb} MB` : 'unknown'} />
        <Metric label="Active device" value={diag.cuda ? 'cuda' : 'cpu'} />
        <Metric label="Precision" value={diag.precision ?? 'unknown'} />
        <Metric label="CPU offload" value={yn(diag.modelCpuOffload)} />
        <Metric label="Sequential offload" value={yn(diag.sequentialCpuOffload)} />
        <Metric label="Attention slicing" value={yn(diag.attentionSlicing)} />
        <Metric label="VAE slicing / tiling" value={`${yn(diag.vaeSlicing)} / ${yn(diag.vaeTiling)}`} />
        <Metric
          label="Resolution limit"
          value={constrained && diag.resolutionLimit != null ? `${diag.resolutionLimit}px (enforced)` : 'none (not enforced)'}
        />
        <Metric label="Last render fallback" value={diag.fallbackOccurred ? 'yes' : 'no'} />
      </dl>

      {isFourGb && <p className="chip">{profile.statusLabel}</p>}
    </article>
  );
}
