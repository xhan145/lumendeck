import { create } from 'zustand';
import { buildRenderJob, normalizeProgress, type BackendAdapter } from '../bridge/adapter';
import { ComfyAdapter } from '../bridge/comfyAdapter';
import { HttpAdapter, type BridgeModelFolderStatus, type BridgeModelStatus } from '../bridge/httpAdapter';
import { MockAdapter } from '../bridge/mockAdapter';
import { checkHealth, type HealthIssue } from '../core/health';
import { buildManifest, type ExportManifest } from '../core/manifest';
import type { ModelAsset } from '../core/shelf';
import type { CapsuleKind, LoraSlot, RackPreset, SocketRef, Workflow } from '../core/types';
import {
  addNode,
  autoLayout,
  connect,
  createDefaultWorkflow,
  createNode,
  disconnect,
  duplicateNode,
  findNode,
  moveNode,
  removeNode,
  uid,
  updateNodeParam,
} from '../core/workflow';
import { DEMO_SHELF } from '../data/demoShelf';
import { TEMPLATES } from '../data/templates';
import type { LumenFile } from '../core/lumenFile';
import { TURBO_BACKENDS } from '../turboForge/backends';
import { loadBenchmarks, measuredSpeedupPercent, saveBenchmark } from '../turboForge/benchmarks';
import { turboCompileCache } from '../turboForge/cache';
import { findCapability, buildCapabilityMatrix } from '../turboForge/modelMatrix';
import { collectBrowserHardwareInfo, TurboProfiler } from '../turboForge/profiler';
import { createRenderPlan } from '../turboForge/renderPlanner';
import type { BenchmarkResult, BackendId, RenderPlan, TurboForgeManifestData, TurboPresetId } from '../turboForge/types';
import { withTurboForgeManifest } from '../turboForge/manifest';
import {
  DEFAULT_BACKEND_SETTINGS,
  sanitizeBackendSettings,
  settingsBackendToTurboBackend,
  type BackendSettings,
  type RenderBackendId,
} from '../turboForge/backends/backendSettings';
import { loadPersisted, savePersisted } from './persistence';
import { APP_VERSION } from './storeConstants';

export type ViewId = 'guide' | 'recipe' | 'graph' | 'shelf' | 'gallery';

export interface GalleryItem {
  id: string;
  dataUrl: string;
  mediaType?: 'image' | 'video';
  mimeType?: string;
  extension?: string;
  createdAt: string;
  manifest: ExportManifest;
}

export interface QueueJob {
  id: string;
  status: 'running' | 'done' | 'error';
  progress: number;
  label: string;
  phase?: string;
  previewDataUrl?: string;
  error?: string;
}

interface StudioState {
  workflow: Workflow;
  shelf: ModelAsset[];
  shelfSource: 'demo' | 'bridge';
  health: HealthIssue[];
  view: ViewId;
  selectedNodeId: string | null;
  rackPresets: RackPreset[];
  gallery: GalleryItem[];
  queue: QueueJob[];
  adapterId: RenderBackendId;
  bridgeOnline: boolean;
  bridgeModelStatus: BridgeModelStatus | null;
  bridgeModelBusy: boolean;
  bridgeModelError: string | null;
  bridgeModelFolderStatus: BridgeModelFolderStatus | null;
  bridgeModelFolderBusy: boolean;
  bridgeModelFolderError: string | null;
  backendSettings: BackendSettings;
  turboPresetId: TurboPresetId;
  turboBackendId: BackendId;
  turboBenchmarks: BenchmarkResult[];
  turboLastPlan: RenderPlan | null;
  turboLastBenchmark: BenchmarkResult | null;
  turboBusy: boolean;
  turboError: string | null;

  setView(view: ViewId): void;
  selectNode(id: string | null): void;
  setWorkflow(wf: Workflow): void;
  updateParam(nodeId: string, paramId: string, value: unknown): void;
  moveNodeTo(nodeId: string, x: number, y: number): void;
  connectSockets(from: SocketRef, to: SocketRef): void;
  disconnectEdge(edgeId: string): void;
  addCapsule(kind: CapsuleKind, x: number, y: number): void;
  duplicateCapsule(nodeId: string): void;
  autoLayoutGraph(): void;
  removeCapsule(nodeId: string): void;
  resetWorkflow(): void;

  rackSlots(): LoraSlot[];
  setRackSlots(slots: LoraSlot[]): void;
  saveRackPreset(name: string): void;
  applyRackPreset(id: string): void;
  deleteRackPreset(id: string): void;

  setAdapter(id: RenderBackendId): void;
  updateBackendSettings(settings: Partial<BackendSettings>): void;
  testSelectedBackend(): Promise<void>;
  setTurboPreset(id: TurboPresetId): void;
  createTurboPlan(): RenderPlan;
  runTurboBenchmark(): Promise<void>;
  clearTurboCache(): void;
  probeBridge(): Promise<void>;
  refreshShelfFromBridge(): Promise<void>;
  refreshModelFolderStatus(): Promise<void>;
  setBridgeModelFolder(path: string): Promise<void>;
  refreshBridgeModelStatus(): Promise<void>;
  installBridgeRuntime(): Promise<void>;
  downloadBridgeModel(): Promise<void>;
  enqueueRender(): Promise<void>;
  enqueueBatch(count: number): Promise<void>;
  removeGalleryItem(id: string): void;
  restoreSnapshot(item: GalleryItem): void;
  loadWorkflowFile(file: LumenFile): void;
  applyTemplate(id: string): void;
}

export const mockAdapter = new MockAdapter();
export const httpAdapter = new HttpAdapter();
export const comfyAdapter = new ComfyAdapter();

// Set once the user explicitly picks a backend this session, so the auto-detect
// in probeBridge never overrides a deliberate choice.
let userPinnedBackend = false;
// Set once the user explicitly picks a checkpoint this session, so auto-select
// never overrides a deliberate choice.
let userPinnedModel = false;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Prefer a real (diffusers) installed checkpoint, else the first installed one. */
function pickCheckpoint(shelf: ModelAsset[]): string {
  const installed = shelf.filter((a) => a.assetType === 'checkpoint' && a.installed);
  const real = installed.find((a) => a.tags?.includes('real') || a.tags?.includes('diffusers'));
  return (real ?? installed[0])?.id ?? '';
}

function isRealAsset(a: ModelAsset | undefined): boolean {
  return !!a && (a.tags?.includes('real') === true || a.tags?.includes('diffusers') === true);
}

/**
 * Point the Model capsule at a real checkpoint. Fills an empty/invalid selection
 * always; with `upgrade`, also swaps an auto-picked placeholder for a real model
 * (used on bridge refresh, gated by whether the user pinned a choice this session).
 */
function applyAutoCheckpoint(wf: Workflow, shelf: ModelAsset[], opts?: { upgrade?: boolean }): Workflow {
  const model = findNode(wf, 'model');
  if (!model) return wf;
  const current = String(model.params.assetId ?? '');
  const currentAsset = shelf.find((a) => a.id === current && a.assetType === 'checkpoint' && a.installed);
  // Keep a valid current selection unless we're allowed to upgrade a non-real one.
  if (currentAsset && !(opts?.upgrade && !isRealAsset(currentAsset))) return wf;
  const pick = pickCheckpoint(shelf);
  return pick && pick !== current ? updateNodeParam(wf, model.id, 'assetId', pick) : wf;
}

function activeAdapter(settings: BackendSettings): BackendAdapter {
  if (settings.selectedBackend === 'bridge') {
    httpAdapter.setBaseUrl(settings.bridgeUrl);
    httpAdapter.setRenderer(settings.bridgeRenderer);
    return httpAdapter;
  }
  if (settings.selectedBackend === 'comfyui') {
    comfyAdapter.setBaseUrl(settings.comfyUrl);
    return comfyAdapter;
  }
  return mockAdapter;
}

const persisted = loadPersisted();
const initialWorkflow = applyAutoCheckpoint(persisted.workflow ?? createDefaultWorkflow(), DEMO_SHELF);
const initialBackendSettings = sanitizeBackendSettings(persisted.backendSettings ?? DEFAULT_BACKEND_SETTINGS);

export const useStudio = create<StudioState>((set, get) => {
  const commit = (wf: Workflow) =>
    set({ workflow: wf, health: checkHealth(wf, get().shelf), turboLastPlan: null, turboError: null });

  return {
    workflow: initialWorkflow,
    shelf: DEMO_SHELF,
    shelfSource: 'demo',
    health: checkHealth(initialWorkflow, DEMO_SHELF),
    view: 'guide',
    selectedNodeId: null,
    rackPresets: persisted.rackPresets ?? [],
    gallery: persisted.gallery ?? [],
    queue: [],
    adapterId: initialBackendSettings.selectedBackend,
    bridgeOnline: false,
    bridgeModelStatus: null,
    bridgeModelBusy: false,
    bridgeModelError: null,
    bridgeModelFolderStatus: null,
    bridgeModelFolderBusy: false,
    bridgeModelFolderError: null,
    backendSettings: initialBackendSettings,
    turboPresetId: 'fast',
    turboBackendId: settingsBackendToTurboBackend(initialBackendSettings.selectedBackend),
    turboBenchmarks: loadBenchmarks(),
    turboLastPlan: null,
    turboLastBenchmark: null,
    turboBusy: false,
    turboError: null,

    setView: (view) => set({ view }),
    selectNode: (selectedNodeId) => set({ selectedNodeId }),
    setWorkflow: (wf) => commit(wf),
    updateParam: (nodeId, paramId, value) => {
      // A deliberate checkpoint pick disables real-model auto-upgrade this session.
      if (paramId === 'assetId') {
        const node = get().workflow.nodes.find((n) => n.id === nodeId);
        if (node?.kind === 'model') userPinnedModel = true;
      }
      commit(updateNodeParam(get().workflow, nodeId, paramId, value));
    },
    moveNodeTo: (nodeId, x, y) => commit(moveNode(get().workflow, nodeId, x, y)),
    connectSockets: (from, to) => commit(connect(get().workflow, from, to)),
    disconnectEdge: (edgeId) => commit(disconnect(get().workflow, edgeId)),
    addCapsule: (kind, x, y) => {
      const node = createNode(kind, x, y);
      commit(addNode(get().workflow, node));
      set({ selectedNodeId: node.id });
    },
    duplicateCapsule: (nodeId) => {
      const before = get().workflow;
      const next = duplicateNode(before, nodeId);
      commit(next);
      const copy = next.nodes.find((node) => !before.nodes.some((old) => old.id === node.id));
      if (copy) set({ selectedNodeId: copy.id });
    },
    autoLayoutGraph: () => commit(autoLayout(get().workflow)),
    removeCapsule: (nodeId) => {
      commit(removeNode(get().workflow, nodeId));
      if (get().selectedNodeId === nodeId) set({ selectedNodeId: null });
    },
    resetWorkflow: () => commit(createDefaultWorkflow()),

    rackSlots: () => {
      const rack = findNode(get().workflow, 'loraRack');
      return ((rack?.params.slots as LoraSlot[] | undefined) ?? []);
    },
    setRackSlots: (slots) => {
      const rack = findNode(get().workflow, 'loraRack');
      if (rack) commit(updateNodeParam(get().workflow, rack.id, 'slots', slots));
    },
    saveRackPreset: (name) => {
      const preset: RackPreset = { id: uid('preset'), name, slots: get().rackSlots().map((s) => ({ ...s })) };
      set({ rackPresets: [...get().rackPresets, preset] });
    },
    applyRackPreset: (id) => {
      const preset = get().rackPresets.find((p) => p.id === id);
      if (preset) get().setRackSlots(preset.slots.map((s) => ({ ...s })));
    },
    deleteRackPreset: (id) =>
      set({ rackPresets: get().rackPresets.filter((p) => p.id !== id) }),

    setAdapter: (adapterId) => {
      userPinnedBackend = true;
      const backendSettings = sanitizeBackendSettings({ ...get().backendSettings, selectedBackend: adapterId });
      set({
        adapterId,
        backendSettings,
        turboBackendId: settingsBackendToTurboBackend(adapterId),
        turboLastPlan: null,
      });
    },
    updateBackendSettings: (settings) => {
      const backendSettings = sanitizeBackendSettings({ ...get().backendSettings, ...settings });
      if (backendSettings.selectedBackend === 'comfyui') comfyAdapter.setBaseUrl(backendSettings.comfyUrl);
      set({
        backendSettings,
        adapterId: backendSettings.selectedBackend,
        turboBackendId: settingsBackendToTurboBackend(backendSettings.selectedBackend),
        turboLastPlan: null,
      });
    },

    testSelectedBackend: async () => {
      const state = get();
      const startedAt = performance.now();
      let ok = false;
      let status: 'healthy' | 'unavailable' | 'degraded' = 'unavailable';
      let message = '';
      if (state.backendSettings.selectedBackend === 'mock') {
        ok = true;
        status = 'healthy';
        message = 'Mock backend is ready. It validates the app flow without a GPU.';
      } else if (state.backendSettings.selectedBackend === 'comfyui') {
        comfyAdapter.setBaseUrl(state.backendSettings.comfyUrl);
        const health = await comfyAdapter.health();
        ok = health.ok;
        status = health.status;
        message = health.message;
      } else {
        httpAdapter.setBaseUrl(state.backendSettings.bridgeUrl);
        ok = await httpAdapter.ping();
        status = ok ? 'healthy' : 'unavailable';
        message = ok ? 'Local Diffusers bridge is reachable.' : 'Local Diffusers bridge is offline at the configured bridge URL.';
      }
      const backendSettings = sanitizeBackendSettings({
        ...state.backendSettings,
        lastHealth: {
          backend: state.backendSettings.selectedBackend,
          ok,
          status,
          message,
          elapsedMs: Math.round(performance.now() - startedAt),
          checkedAt: new Date().toISOString(),
        },
      });
      set({ backendSettings, bridgeOnline: ok });
      if (ok && state.backendSettings.selectedBackend === 'bridge') void get().refreshBridgeModelStatus();
    },
    setTurboPreset: (turboPresetId) => set({ turboPresetId, turboLastPlan: null, turboError: null }),

    createTurboPlan: () => {
      const state = get();
      const plan = createRenderPlan(state.workflow, state.shelf, {
        presetId: state.turboPresetId,
        backendId: state.turboBackendId,
        history: state.turboBenchmarks,
      });
      set({ turboLastPlan: plan });
      return plan;
    },

    runTurboBenchmark: async () => {
      set({ turboBusy: true, turboError: null });
      try {
        const state = get();
        const plan = get().createTurboPlan();
        const adapter = activeAdapter(state.backendSettings);
        const job = buildRenderJob(state.workflow);
        const startedAt = performance.now();
        const result = await adapter.generate(job);
        const elapsedMs = performance.now() - startedAt;
        const timings = {
          ...result.backendTimings,
          totalRenderMs: result.backendTimings?.totalRenderMs ?? result.backendTimings?.backendRequestMs ?? elapsedMs,
        };
        const matrix = buildCapabilityMatrix(get().shelf);
        const modelCapability = findCapability(matrix, plan.selectedModel);
        const benchmark: BenchmarkResult = {
          id: `bench_${plan.id}`,
          createdAt: new Date().toISOString(),
          presetId: plan.selectedPreset,
          backendId: plan.selectedBackend,
          backendName: adapter.label,
          hardware: collectBrowserHardwareInfo(adapter.label),
          runtime: {
            backendName: adapter.label,
            precisionMode: plan.optimizationFlags.precision,
            modelId: plan.selectedModel,
            modelHash: modelCapability?.fileHash ?? null,
            loraStack: plan.selectedLoras,
            resolution: plan.resolution,
            steps: plan.steps,
            frameCount: plan.frameCount,
            fps: plan.fps,
            seed: result.seed,
            batchSize: plan.batchSize,
            dateTime: new Date().toISOString(),
          },
          timings,
          optimizedMs: timings.totalRenderMs,
        };
        const baseline = get().turboBenchmarks.find((b) => b.runtime.modelId === benchmark.runtime.modelId && b.presetId === 'safe');
        const enriched: BenchmarkResult = {
          ...benchmark,
          baselineMs: baseline?.timings.totalRenderMs,
          optimizedMs: benchmark.timings.totalRenderMs,
          measuredSpeedupPercent: measuredSpeedupPercent(baseline?.timings.totalRenderMs, benchmark.timings.totalRenderMs),
        };
        set({ turboBenchmarks: saveBenchmark(enriched), turboLastBenchmark: enriched, turboBusy: false, turboError: null });
      } catch (err) {
        set({ turboBusy: false, turboError: err instanceof Error ? err.message : String(err) });
      }
    },

    clearTurboCache: () => {
      turboCompileCache.clear();
      set({ turboLastPlan: get().createTurboPlan() });
    },

    probeBridge: async () => {
      // The bundled sidecar takes ~1s to boot; retry with backoff before giving up.
      httpAdapter.setBaseUrl(get().backendSettings.bridgeUrl);
      let online = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        online = await httpAdapter.ping();
        if (online) break;
        await sleep(800);
      }
      set({ bridgeOnline: online });
      if (online && get().shelfSource === 'demo') {
        await get().refreshShelfFromBridge();
      }
      if (online) {
        await Promise.all([get().refreshBridgeModelStatus(), get().refreshModelFolderStatus()]);
      }
      // Auto-select the local bridge on first boot when the user hasn't chosen a backend.
      if (online && !userPinnedBackend && get().adapterId === 'mock') {
        const backendSettings = sanitizeBackendSettings({ ...get().backendSettings, selectedBackend: 'bridge' });
        set({ adapterId: 'bridge', backendSettings, turboBackendId: settingsBackendToTurboBackend('bridge') });
      }
      if (!online && get().adapterId === 'bridge') set({ adapterId: 'mock' });
    },

    refreshShelfFromBridge: async () => {
      try {
        const shelf = await httpAdapter.listModels();
        if (Array.isArray(shelf) && shelf.length > 0) {
          const workflow = applyAutoCheckpoint(get().workflow, shelf, { upgrade: !userPinnedModel });
          set({ shelf, shelfSource: 'bridge', workflow, health: checkHealth(workflow, shelf) });
        }
      } catch (err) {
        console.warn('LumenDeck: bridge shelf refresh failed', err);
      }
    },

    refreshModelFolderStatus: async () => {
      try {
        httpAdapter.setBaseUrl(get().backendSettings.bridgeUrl);
        const bridgeModelFolderStatus = await httpAdapter.modelFolderStatus();
        set({ bridgeModelFolderStatus, bridgeModelFolderError: null });
      } catch (err) {
        set({
          bridgeModelFolderError: err instanceof Error ? err.message : String(err),
          bridgeModelFolderStatus: null,
        });
      }
    },

    setBridgeModelFolder: async (path) => {
      set({ bridgeModelFolderBusy: true, bridgeModelFolderError: null });
      try {
        httpAdapter.setBaseUrl(get().backendSettings.bridgeUrl);
        const bridgeModelFolderStatus = await httpAdapter.setModelFolder(path);
        const shelf = await httpAdapter.listModels();
        const workflow = applyAutoCheckpoint(get().workflow, shelf, { upgrade: !userPinnedModel });
        set({
          bridgeModelFolderStatus,
          bridgeModelFolderBusy: false,
          bridgeModelFolderError: null,
          shelf,
          shelfSource: 'bridge',
          workflow,
          health: checkHealth(workflow, shelf),
          turboLastPlan: null,
          turboError: null,
        });
      } catch (err) {
        const status = err instanceof Error && 'status' in err ? (err as Error & { status?: BridgeModelFolderStatus }).status : undefined;
        set({
          bridgeModelFolderStatus: status ?? get().bridgeModelFolderStatus,
          bridgeModelFolderBusy: false,
          bridgeModelFolderError: err instanceof Error ? err.message : String(err),
        });
      }
    },

    refreshBridgeModelStatus: async () => {
      try {
        httpAdapter.setBaseUrl(get().backendSettings.bridgeUrl);
        const bridgeModelStatus = await httpAdapter.diffusersStatus();
        set({ bridgeModelStatus, bridgeModelError: null });
      } catch (err) {
        set({
          bridgeModelError: err instanceof Error ? err.message : String(err),
          bridgeModelStatus: null,
        });
      }
    },

    downloadBridgeModel: async () => {
      set({ bridgeModelBusy: true, bridgeModelError: null });
      try {
        httpAdapter.setBaseUrl(get().backendSettings.bridgeUrl);
        const bridgeModelStatus = await httpAdapter.downloadDiffusersModel();
        set({
          bridgeModelStatus,
          bridgeModelBusy: false,
          bridgeModelError: null,
          backendSettings: sanitizeBackendSettings({ ...get().backendSettings, selectedBackend: 'bridge', bridgeRenderer: 'diffusers' }),
          adapterId: 'bridge',
          turboBackendId: settingsBackendToTurboBackend('bridge'),
        });
      } catch (err) {
        const status = err instanceof Error && 'status' in err ? (err as Error & { status?: BridgeModelStatus }).status : undefined;
        set({
          bridgeModelStatus: status ?? get().bridgeModelStatus,
          bridgeModelBusy: false,
          bridgeModelError: err instanceof Error ? err.message : String(err),
        });
      }
    },

    installBridgeRuntime: async () => {
      set({ bridgeModelBusy: true, bridgeModelError: null });
      try {
        httpAdapter.setBaseUrl(get().backendSettings.bridgeUrl);
        const bridgeModelStatus = await httpAdapter.installDiffusersRuntime();
        set({
          bridgeModelStatus,
          bridgeModelBusy: false,
          bridgeModelError: null,
          backendSettings: sanitizeBackendSettings({ ...get().backendSettings, selectedBackend: 'bridge', bridgeRenderer: 'diffusers' }),
          adapterId: 'bridge',
          turboBackendId: settingsBackendToTurboBackend('bridge'),
        });
      } catch (err) {
        const status = err instanceof Error && 'status' in err ? (err as Error & { status?: BridgeModelStatus }).status : undefined;
        set({
          bridgeModelStatus: status ?? get().bridgeModelStatus,
          bridgeModelBusy: false,
          bridgeModelError: err instanceof Error ? err.message : String(err),
        });
      }
    },

    enqueueRender: async () => {
      const { workflow, shelf, backendSettings } = get();
      const errors = get().health.filter((i) => i.severity === 'error');
      if (errors.length > 0) return; // UI blocks this path; guard anyway.

      const job = buildRenderJob(workflow);
      const plan = get().createTurboPlan();
      const queueJob: QueueJob = {
        id: uid('job'),
        status: 'running',
        progress: 0,
        label: `${job.output === 'video' ? 'Video' : 'Image'}: ${job.prompt.slice(0, 48) || 'Untitled render'}`,
      };
      set({ queue: [queueJob, ...get().queue].slice(0, 20) });
      const patch = (p: Partial<QueueJob>) =>
        set({ queue: get().queue.map((q) => (q.id === queueJob.id ? { ...q, ...p } : q)) });

      try {
        const profiler = new TurboProfiler();
        profiler.mark('total-start');
        const adapter = activeAdapter(backendSettings);
        profiler.mark('sampling-start');
        profiler.mark('backend-start');
        let result;
        let usedFallback = false;
        try {
          result = await adapter.generate(job, (update) => {
            const progress = normalizeProgress(update);
            patch({ progress: progress.progress, phase: progress.phase, previewDataUrl: progress.previewDataUrl });
          });
        } catch (error) {
          if (!backendSettings.fallbackToMock || backendSettings.selectedBackend === 'mock') throw error;
          usedFallback = true;
          patch({ error: `${error instanceof Error ? error.message : String(error)} Falling back to mock backend.` });
          result = await mockAdapter.generate(job, (update) => {
            const progress = normalizeProgress(update);
            patch({ progress: progress.progress, phase: progress.phase, previewDataUrl: progress.previewDataUrl });
          });
        }
        // Bridge produced a procedural placeholder when a real render was expected —
        // surface it loudly instead of pretending the render succeeded.
        if (result.fallback) {
          patch({ error: `Real render failed — showing procedural placeholder. ${result.fallbackReason ?? ''}`.trim() });
        }
        profiler.measure('backendRequestMs', 'backend-start');
        for (const [key, value] of Object.entries(result.backendTimings ?? {})) {
          profiler.set(key as keyof NonNullable<typeof result.backendTimings>, Number(value));
        }
        profiler.measure('samplingMs', 'sampling-start');
        profiler.set('modelLoadMs', 0);
        profiler.set('loraLoadMs', plan.selectedLoras.length * 5);
        profiler.set('promptEncodingMs', 0);
        profiler.set('imagePreprocessingMs', plan.requiredPreprocessing.includes('conditioning preprocessing') ? 10 : 0);
        profiler.set('vaeDecodeMs', 0);
        profiler.set('saveExportMs', 0);
        profiler.measure('totalRenderMs', 'total-start');
        // Freeze the manifest with the *resolved* seed.
        const baseManifest = buildManifest(workflow, shelf, APP_VERSION, new Date());
        baseManifest.seed = result.seed;
        const matrix = buildCapabilityMatrix(shelf);
        const modelCapability = findCapability(matrix, plan.selectedModel);
        const benchmark: BenchmarkResult = {
          id: `bench_${queueJob.id}`,
          createdAt: baseManifest.createdAt,
          presetId: plan.selectedPreset,
          backendId: plan.selectedBackend,
          backendName: usedFallback ? 'Mock backend fallback' : TURBO_BACKENDS[plan.selectedBackend].displayName,
          hardware: collectBrowserHardwareInfo(usedFallback ? 'Mock backend fallback' : TURBO_BACKENDS[plan.selectedBackend].displayName),
          runtime: {
            backendName: usedFallback ? 'Mock backend fallback' : TURBO_BACKENDS[plan.selectedBackend].displayName,
            precisionMode: plan.optimizationFlags.precision,
            modelId: plan.selectedModel,
            modelHash: modelCapability?.fileHash ?? null,
            loraStack: plan.selectedLoras,
            resolution: plan.resolution,
            steps: plan.steps,
            frameCount: plan.frameCount,
            fps: plan.fps,
            seed: result.seed,
            batchSize: plan.batchSize,
            dateTime: baseManifest.createdAt,
          },
          timings: profiler.snapshot(),
          optimizedMs: profiler.snapshot().totalRenderMs,
        };
        const baseline = get().turboBenchmarks.find((b) => b.runtime.modelId === benchmark.runtime.modelId && b.presetId === 'safe');
        const enrichedBenchmark: BenchmarkResult = {
          ...benchmark,
          baselineMs: baseline?.timings.totalRenderMs,
          measuredSpeedupPercent: measuredSpeedupPercent(baseline?.timings.totalRenderMs, benchmark.timings.totalRenderMs),
        };
        const turboForge: TurboForgeManifestData = {
          preset: plan.selectedPreset,
          backendId: plan.selectedBackend,
          backendHealthStatus: usedFallback ? 'degraded' : 'healthy',
          optimizationFlags: plan.optimizationFlags,
          compileCacheStatus: plan.compileCacheStatus,
          modelCapability,
          loraStack: plan.selectedLoras,
          renderPlan: plan,
          benchmark: enrichedBenchmark,
          warnings: usedFallback
            ? [
                ...plan.warnings,
                {
                  code: 'backend-fallback',
                  severity: 'warning',
                  message: 'The selected backend failed, so LumenDeck used the mock backend fallback.',
                  recommendedFix: 'Start ComfyUI, check the backend URL, or switch to Mock.',
                },
              ]
            : plan.warnings,
          hardwareInfo: enrichedBenchmark.hardware,
          graphSnapshot: workflow,
          appVersion: APP_VERSION,
        };
        const manifest = withTurboForgeManifest(baseManifest, turboForge);
        const item: GalleryItem = {
          id: uid('render'),
          dataUrl: result.dataUrl,
          mediaType: result.mediaType,
          mimeType: result.mimeType,
          extension: result.extension,
          createdAt: manifest.createdAt,
          manifest,
        };
        set({
          gallery: [item, ...get().gallery],
          turboBenchmarks: saveBenchmark(enrichedBenchmark),
          turboLastBenchmark: enrichedBenchmark,
        });
        patch({ status: 'done', progress: 1, phase: 'done', previewDataUrl: result.dataUrl });
      } catch (err) {
        patch({ status: 'error', error: err instanceof Error ? err.message : String(err) });
      }
    },

    enqueueBatch: async (count) => {
      // Seed grid: run N renders back to back. A random seed (-1) yields N
      // variations; a fixed seed repeats it. Errors in one don't stop the batch.
      const n = Math.max(1, Math.min(16, Math.floor(count)));
      for (let i = 0; i < n; i++) {
        try {
          await get().enqueueRender();
        } catch {
          // enqueueRender records its own error on the queue item; keep going.
        }
      }
    },

    removeGalleryItem: (id) => set({ gallery: get().gallery.filter((g) => g.id !== id) }),

    restoreSnapshot: (item) => {
      commit({ ...item.manifest.graph });
      set({ view: 'graph', selectedNodeId: null });
    },

    loadWorkflowFile: (file) => {
      commit(file.workflow);
      if (file.rackPresets?.length) set({ rackPresets: file.rackPresets });
      set({ selectedNodeId: null, view: 'recipe' });
    },

    applyTemplate: (id) => {
      const template = TEMPLATES.find((t) => t.id === id);
      if (template) {
        commit(template.build());
        set({ selectedNodeId: null, view: 'recipe' });
      }
    },
  };
});

// Persist on every relevant change (cheap JSON writes, debounced by microtask batching).
let saveTimer: ReturnType<typeof setTimeout> | null = null;
useStudio.subscribe((state) => {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    savePersisted({
      workflow: state.workflow,
      rackPresets: state.rackPresets,
      gallery: state.gallery.slice(0, 24),
      backendSettings: state.backendSettings,
    });
  }, 300);
});
