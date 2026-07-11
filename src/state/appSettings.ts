import type { ViewId } from './store';
import type { TurboPresetId } from '../turboForge/types';
import type { RenderBackendId } from '../turboForge/backends/backendSettings';

export type ThemeMode = 'dark' | 'system';
export type StartupBehavior = 'guide' | 'last-view' | 'controls';
export type VramSafetyMode = 'strict' | 'balanced' | 'off';
export type GraphMode = '2d' | '3d';
export type Graph3DStyle = 'orbs' | 'cards';
export type Graph3DEffects = 'off' | 'minimal' | 'standard' | 'rich' | 'cinematic';

export interface AppSettings {
  themeMode: ThemeMode;
  compactMode: boolean;
  startupBehavior: StartupBehavior;
  modelDirectory: string;
  loraDirectory: string;
  outputDirectory: string;
  cacheDirectory: string;
  preferredBackend: RenderBackendId;
  vramSafetyMode: VramSafetyMode;
  maxConcurrentJobs: number;
  turboAccelerationProfile: TurboPresetId;
  compileCacheEnabled: boolean;
  loraOptimizerEnabled: boolean;
  saveManifest: boolean;
  localOnlyMode: true;
  telemetryDisabled: true;
  showDiagnostics: boolean;
  apiKeys: {
    civitai: string;
    huggingface: string;
    customEndpoint: string;
  };
  lastView?: ViewId;
  /**
   * Graph editor renderer preference (2D ⇄ 3D toggle). Optional and additive:
   * state persisted before the 3D graph existed still loads; when unset,
   * GraphWorkspace defaults to '3d' ('2d' under prefers-reduced-motion).
   */
  graphMode?: GraphMode;
  /**
   * Whether the graph node palette is pinned open (auto-collapse disabled).
   * Optional and additive: state persisted before the collapsible palette
   * existed still loads; when unset, CollapsiblePalette defaults to false.
   */
  palettePinned?: boolean;
  /**
   * 3D node rendering style (gradient orbs vs the v0.12 full cards). Optional
   * and additive: when unset, Graph3DView defaults to 'orbs'.
   */
  graph3dStyle?: Graph3DStyle;
  /**
   * Constellation GPU-overhaul effects level (First Slice: gravity fabric only).
   * Optional and additive: state persisted before the overhaul still loads; when
   * unset, the 3D view treats it as 'off'. The enum is FINAL — later phases add
   * behavior behind the same four levels without a settings migration.
   */
  graph3dEffects?: Graph3DEffects;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  themeMode: 'dark',
  compactMode: false,
  startupBehavior: 'guide',
  modelDirectory: '',
  loraDirectory: '',
  outputDirectory: '',
  cacheDirectory: '',
  preferredBackend: 'bridge',
  vramSafetyMode: 'balanced',
  maxConcurrentJobs: 1,
  turboAccelerationProfile: 'fast',
  compileCacheEnabled: true,
  loraOptimizerEnabled: true,
  saveManifest: true,
  localOnlyMode: true,
  telemetryDisabled: true,
  showDiagnostics: false,
  apiKeys: {
    civitai: '',
    huggingface: '',
    customEndpoint: '',
  },
};

export function sanitizeAppSettings(settings?: Partial<AppSettings>): AppSettings {
  return {
    ...DEFAULT_APP_SETTINGS,
    ...settings,
    themeMode: settings?.themeMode === 'system' ? 'system' : 'dark',
    compactMode: Boolean(settings?.compactMode ?? DEFAULT_APP_SETTINGS.compactMode),
    startupBehavior: settings?.startupBehavior === 'last-view' || settings?.startupBehavior === 'controls'
      ? settings.startupBehavior
      : 'guide',
    preferredBackend: settings?.preferredBackend ?? DEFAULT_APP_SETTINGS.preferredBackend,
    vramSafetyMode: settings?.vramSafetyMode ?? DEFAULT_APP_SETTINGS.vramSafetyMode,
    maxConcurrentJobs: Math.max(1, Math.min(4, Number(settings?.maxConcurrentJobs ?? DEFAULT_APP_SETTINGS.maxConcurrentJobs))),
    turboAccelerationProfile: settings?.turboAccelerationProfile ?? DEFAULT_APP_SETTINGS.turboAccelerationProfile,
    compileCacheEnabled: settings?.compileCacheEnabled ?? DEFAULT_APP_SETTINGS.compileCacheEnabled,
    loraOptimizerEnabled: settings?.loraOptimizerEnabled ?? DEFAULT_APP_SETTINGS.loraOptimizerEnabled,
    saveManifest: settings?.saveManifest ?? DEFAULT_APP_SETTINGS.saveManifest,
    localOnlyMode: true,
    telemetryDisabled: true,
    showDiagnostics: Boolean(settings?.showDiagnostics ?? DEFAULT_APP_SETTINGS.showDiagnostics),
    apiKeys: {
      civitai: settings?.apiKeys?.civitai ?? '',
      huggingface: settings?.apiKeys?.huggingface ?? '',
      customEndpoint: settings?.apiKeys?.customEndpoint ?? '',
    },
    graphMode: settings?.graphMode === '2d' || settings?.graphMode === '3d' ? settings.graphMode : undefined,
    palettePinned: typeof settings?.palettePinned === 'boolean' ? settings.palettePinned : undefined,
    graph3dStyle: settings?.graph3dStyle === 'orbs' || settings?.graph3dStyle === 'cards' ? settings.graph3dStyle : undefined,
    graph3dEffects:
      settings?.graph3dEffects === 'off' ||
      settings?.graph3dEffects === 'minimal' ||
      settings?.graph3dEffects === 'standard' ||
      settings?.graph3dEffects === 'rich' ||
      settings?.graph3dEffects === 'cinematic'
        ? settings.graph3dEffects
        : undefined,
  };
}
