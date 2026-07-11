import { useStudio } from '../state/store';
import {
  HARDWARE_PROFILE_IDS,
  getHardwareProfile,
  type EffectiveProfileId,
  type HardwareProfileId,
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
 * Hardware / performance profile selector + active-optimizations status. Reads
 * the resolved diagnostics object from the store (redacted; no prompts/images)
 * and shows which low-VRAM optimizations are actually active.
 */
export function HardwareProfilePanel() {
  const { appSettings, setHardwareProfile, hardwareDiagnostics } = useStudio();
  const diag = hardwareDiagnostics();
  const selected = appSettings.hardwareProfile;
  const effective = diag.effectiveProfile as EffectiveProfileId;
  const profile = getHardwareProfile(effective);
  const isFourGb = effective === 'gtx_1650_4gb';
  const resolvedHint = selected === 'auto' ? ` → ${PROFILE_LABELS[effective] ?? effective}` : '';

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
          components can be moved to system memory.
        </p>
      )}

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
        <Metric label="Resolution limit" value={diag.resolutionLimit != null ? `${diag.resolutionLimit}px` : 'none'} />
        <Metric label="Batch limit" value={`${profile.defaults.batchSize}`} />
        <Metric label="Resident on GPU" value={profile.defaults.keepSingleModelOnGpu ? 'Active model only' : 'Multiple allowed'} />
        <Metric label="Last render fallback" value={diag.fallbackOccurred ? 'yes' : 'no'} />
      </dl>

      {isFourGb && <p className="chip">{profile.statusLabel}</p>}
    </article>
  );
}
