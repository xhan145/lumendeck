import type { BridgeModelFolderStatus, BridgeModelStatus } from '../bridge/httpAdapter';
import type { BackendSettings } from '../turboForge/backends/backendSettings';
import type { GalleryItem, QueueJob } from '../state/store';
import type { HealthIssue } from './health';
import { fallbackReasonFor, isFallbackRender, renderBackendLabel } from './renderHonesty';
import { estimateGalleryStorage } from './storageStatus';

export interface DiagnosticsReportInput {
  appVersion: string;
  now?: Date;
  selectedBackend: string;
  bridgeOnline: boolean;
  backendSettings: BackendSettings;
  bridgeModelStatus: BridgeModelStatus | null;
  bridgeModelError: string | null;
  bridgeModelFolderStatus: BridgeModelFolderStatus | null;
  bridgeModelFolderError: string | null;
  shelfSource: string;
  assetCount: number;
  health: HealthIssue[];
  queue: QueueJob[];
  gallery: GalleryItem[];
}

const SECRET_PATTERNS = [
  /(hf_[A-Za-z0-9_\\-]+)/g,
  /(civitai[_-]?token[=:]\s*)[^\s&]+/gi,
  /(token[=:]\s*)[^\s&]+/gi,
  /(key[=:]\s*)[^\s&]+/gi,
];

export function redactSecrets(value: unknown): string {
  let text = String(value ?? '');
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (_match, prefix) => prefix && String(prefix).includes('=') ? `${prefix}[redacted]` : '[redacted]');
  }
  return text;
}

function line(label: string, value: unknown): string {
  return `${label}: ${redactSecrets(value ?? 'unknown')}`;
}

export function formatDiagnosticsReport(input: DiagnosticsReportInput): string {
  const model = input.bridgeModelStatus;
  const folder = input.bridgeModelFolderStatus;
  const latestJob = input.queue[0];
  const latestFallback = input.gallery.find((item) => isFallbackRender(item));
  const storage = estimateGalleryStorage(input.gallery);
  const healthErrors = input.health.filter((issue) => issue.severity === 'error');
  const healthWarnings = input.health.filter((issue) => issue.severity !== 'error');

  return [
    'LumenDeck Diagnostics',
    line('Generated', (input.now ?? new Date()).toISOString()),
    line('App version', input.appVersion),
    '',
    '[Backend]',
    line('Selected backend', input.selectedBackend),
    line('Bridge online', input.bridgeOnline),
    line('Bridge URL', input.backendSettings.bridgeUrl),
    line('ComfyUI URL', input.backendSettings.comfyUrl),
    line('Bridge renderer', input.backendSettings.bridgeRenderer),
    line('Fallback to mock', input.backendSettings.fallbackToMock),
    line('Last health status', input.backendSettings.lastHealth?.status ?? 'not tested'),
    line('Last health message', input.backendSettings.lastHealth?.message ?? 'none'),
    '',
    '[Diffusers]',
    line('Model ID', model?.modelId ?? 'unknown'),
    line('Dependencies ready', model?.dependenciesReady ?? 'unknown'),
    line('Loaded', model?.loaded ?? 'unknown'),
    line('Model cached', model?.modelCached ?? 'unknown'),
    line('Device', model?.device ?? 'unknown'),
    line('CUDA', model?.cuda ?? 'unknown'),
    line('Cache directory', model?.cacheDir ?? 'unknown'),
    line('Installable', model?.installable ?? 'unknown'),
    line('Managed runtime path', model?.managedRuntime?.path ?? 'unknown'),
    line('Managed Python', model?.managedRuntime?.python ?? 'unknown'),
    line('Status message', model?.message ?? input.bridgeModelError ?? 'none'),
    '',
    '[Model folder]',
    line('Configured folder', folder?.configured ?? 'unknown'),
    line('Active folder', folder?.active ?? 'unknown'),
    line('Shelf source', input.shelfSource),
    line('Asset count', folder?.assetCount ?? input.assetCount),
    line('Checkpoint count', folder?.checkpointCount ?? 'unknown'),
    line('LoRA count', folder?.loraCount ?? 'unknown'),
    line('Folder error', input.bridgeModelFolderError ?? 'none'),
    '',
    '[Queue and health]',
    line('Queue size', input.queue.length),
    line('Latest job', latestJob ? `${latestJob.status} ${latestJob.phase ?? ''} ${latestJob.error ?? ''}`.trim() : 'none'),
    line('Health errors', healthErrors.length),
    line('Health warnings', healthWarnings.length),
    line('Last fallback', latestFallback ? renderBackendLabel(latestFallback) : 'none'),
    line('Last fallback reason', latestFallback ? fallbackReasonFor(latestFallback) : 'none'),
    '',
    '[Storage]',
    line('Gallery items', storage.itemCount),
    line('Approximate gallery size', storage.approximateLabel),
    line('Persistence mode', storage.persistenceMode),
    line('Planned desktop gallery path', storage.plannedDesktopPath),
    '',
    '[Local logs]',
    'Bridge worker logs are expected under %LOCALAPPDATA%\\LumenDeck\\diffusers-runtime\\worker.log when the managed runtime writes them.',
  ].join('\n');
}
