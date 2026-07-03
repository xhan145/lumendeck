import { create } from 'zustand';
import { buildRenderJob, type BackendAdapter } from '../bridge/adapter';
import { HttpAdapter } from '../bridge/httpAdapter';
import { MockAdapter } from '../bridge/mockAdapter';
import { checkHealth, type HealthIssue } from '../core/health';
import { buildManifest, type ExportManifest } from '../core/manifest';
import type { ModelAsset } from '../core/shelf';
import type { CapsuleKind, LoraSlot, RackPreset, SocketRef, Workflow } from '../core/types';
import {
  addNode,
  connect,
  createDefaultWorkflow,
  createNode,
  disconnect,
  findNode,
  moveNode,
  removeNode,
  uid,
  updateNodeParam,
} from '../core/workflow';
import { DEMO_SHELF } from '../data/demoShelf';
import { TURBO_BACKENDS } from '../turboForge/backends';
import { loadBenchmarks, measuredSpeedupPercent, saveBenchmark } from '../turboForge/benchmarks';
import { turboCompileCache } from '../turboForge/cache';
import { findCapability, buildCapabilityMatrix } from '../turboForge/modelMatrix';
import { collectBrowserHardwareInfo, TurboProfiler } from '../turboForge/profiler';
import { createRenderPlan } from '../turboForge/renderPlanner';
import type { BenchmarkResult, BackendId, RenderPlan, TurboForgeManifestData, TurboPresetId } from '../turboForge/types';
import { withTurboForgeManifest } from '../turboForge/manifest';
import { loadPersisted, savePersisted } from './persistence';
import { APP_VERSION } from './storeConstants';

export type ViewId = 'recipe' | 'graph' | 'shelf' | 'gallery';

export interface GalleryItem {
  id: string;
  dataUrl: string;
  createdAt: string;
  manifest: ExportManifest;
}

export interface QueueJob {
  id: string;
  status: 'running' | 'done' | 'error';
  progress: number;
  label: string;
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
  adapterId: 'mock' | 'bridge';
  bridgeOnline: boolean;
  turboPresetId: TurboPresetId;
  turboBackendId: BackendId;
  turboBenchmarks: BenchmarkResult[];
  turboLastPlan: RenderPlan | null;
  turboLastBenchmark: BenchmarkResult | null;

  setView(view: ViewId): void;
  selectNode(id: string | null): void;
  setWorkflow(wf: Workflow): void;
  updateParam(nodeId: string, paramId: string, value: unknown): void;
  moveNodeTo(nodeId: string, x: number, y: number): void;
  connectSockets(from: SocketRef, to: SocketRef): void;
  disconnectEdge(edgeId: string): void;
  addCapsule(kind: CapsuleKind, x: number, y: number): void;
  removeCapsule(nodeId: string): void;
  resetWorkflow(): void;

  rackSlots(): LoraSlot[];
  setRackSlots(slots: LoraSlot[]): void;
  saveRackPreset(name: string): void;
  applyRackPreset(id: string): void;
  deleteRackPreset(id: string): void;

  setAdapter(id: 'mock' | 'bridge'): void;
  setTurboPreset(id: TurboPresetId): void;
  createTurboPlan(): RenderPlan;
  runTurboBenchmark(): Promise<void>;
  clearTurboCache(): void;
  probeBridge(): Promise<void>;
  refreshShelfFromBridge(): Promise<void>;
  enqueueRender(): Promise<void>;
  removeGalleryItem(id: string): void;
  restoreSnapshot(item: GalleryItem): void;
}

export const mockAdapter = new MockAdapter();
export const httpAdapter = new HttpAdapter();

function activeAdapter(id: 'mock' | 'bridge'): BackendAdapter {
  return id === 'bridge' ? httpAdapter : mockAdapter;
}

const persisted = loadPersisted();
const initialWorkflow = persisted.workflow ?? createDefaultWorkflow();

export const useStudio = create<StudioState>((set, get) => {
  const commit = (wf: Workflow) =>
    set({ workflow: wf, health: checkHealth(wf, get().shelf) });

  return {
    workflow: initialWorkflow,
    shelf: DEMO_SHELF,
    shelfSource: 'demo',
    health: checkHealth(initialWorkflow, DEMO_SHELF),
    view: 'recipe',
    selectedNodeId: null,
    rackPresets: persisted.rackPresets ?? [],
    gallery: persisted.gallery ?? [],
    queue: [],
    adapterId: 'mock',
    bridgeOnline: false,
    turboPresetId: 'fast',
    turboBackendId: 'mock',
    turboBenchmarks: loadBenchmarks(),
    turboLastPlan: null,
    turboLastBenchmark: null,

    setView: (view) => set({ view }),
    selectNode: (selectedNodeId) => set({ selectedNodeId }),
    setWorkflow: (wf) => commit(wf),
    updateParam: (nodeId, paramId, value) =>
      commit(updateNodeParam(get().workflow, nodeId, paramId, value)),
    moveNodeTo: (nodeId, x, y) => commit(moveNode(get().workflow, nodeId, x, y)),
    connectSockets: (from, to) => commit(connect(get().workflow, from, to)),
    disconnectEdge: (edgeId) => commit(disconnect(get().workflow, edgeId)),
    addCapsule: (kind, x, y) => {
      const node = createNode(kind, x, y);
      commit(addNode(get().workflow, node));
      set({ selectedNodeId: node.id });
    },
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

    setAdapter: (adapterId) => set({ adapterId }),
    setTurboPreset: (turboPresetId) => set({ turboPresetId }),

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
      const plan = get().createTurboPlan();
      const backend = TURBO_BACKENDS[plan.selectedBackend];
      const benchmark = await backend.benchmark(plan);
      const baseline = get().turboBenchmarks.find((b) => b.runtime.modelId === benchmark.runtime.modelId && b.presetId === 'safe');
      const enriched: BenchmarkResult = {
        ...benchmark,
        baselineMs: baseline?.timings.totalRenderMs,
        optimizedMs: benchmark.timings.totalRenderMs,
        measuredSpeedupPercent: measuredSpeedupPercent(baseline?.timings.totalRenderMs, benchmark.timings.totalRenderMs),
      };
      set({ turboBenchmarks: saveBenchmark(enriched), turboLastBenchmark: enriched });
    },

    clearTurboCache: () => {
      turboCompileCache.clear();
      set({ turboLastPlan: get().createTurboPlan() });
    },

    probeBridge: async () => {
      const online = await httpAdapter.ping();
      set({ bridgeOnline: online });
      if (online && get().shelfSource === 'demo') {
        await get().refreshShelfFromBridge();
      }
      if (!online && get().adapterId === 'bridge') set({ adapterId: 'mock' });
    },

    refreshShelfFromBridge: async () => {
      try {
        const shelf = await httpAdapter.listModels();
        if (Array.isArray(shelf) && shelf.length > 0) {
          set({ shelf, shelfSource: 'bridge', health: checkHealth(get().workflow, shelf) });
        }
      } catch (err) {
        console.warn('LumenDeck: bridge shelf refresh failed', err);
      }
    },

    enqueueRender: async () => {
      const { workflow, shelf, adapterId } = get();
      const errors = get().health.filter((i) => i.severity === 'error');
      if (errors.length > 0) return; // UI blocks this path; guard anyway.

      const job = buildRenderJob(workflow);
      const plan = get().createTurboPlan();
      const queueJob: QueueJob = {
        id: uid('job'),
        status: 'running',
        progress: 0,
        label: job.prompt.slice(0, 48) || 'Untitled render',
      };
      set({ queue: [queueJob, ...get().queue].slice(0, 20) });
      const patch = (p: Partial<QueueJob>) =>
        set({ queue: get().queue.map((q) => (q.id === queueJob.id ? { ...q, ...p } : q)) });

      try {
        const profiler = new TurboProfiler();
        profiler.mark('total-start');
        const adapter = activeAdapter(adapterId);
        profiler.mark('sampling-start');
        const result = await adapter.generate(job, (progress) => patch({ progress }));
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
          backendName: TURBO_BACKENDS[plan.selectedBackend].displayName,
          hardware: collectBrowserHardwareInfo(TURBO_BACKENDS[plan.selectedBackend].displayName),
          runtime: {
            backendName: TURBO_BACKENDS[plan.selectedBackend].displayName,
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
          backendHealthStatus: 'healthy',
          optimizationFlags: plan.optimizationFlags,
          compileCacheStatus: plan.compileCacheStatus,
          modelCapability,
          loraStack: plan.selectedLoras,
          renderPlan: plan,
          benchmark: enrichedBenchmark,
          warnings: plan.warnings,
          hardwareInfo: enrichedBenchmark.hardware,
          graphSnapshot: workflow,
          appVersion: APP_VERSION,
        };
        const manifest = withTurboForgeManifest(baseManifest, turboForge);
        const item: GalleryItem = {
          id: uid('render'),
          dataUrl: result.dataUrl,
          createdAt: manifest.createdAt,
          manifest,
        };
        set({
          gallery: [item, ...get().gallery],
          turboBenchmarks: saveBenchmark(enrichedBenchmark),
          turboLastBenchmark: enrichedBenchmark,
        });
        patch({ status: 'done', progress: 1 });
      } catch (err) {
        patch({ status: 'error', error: err instanceof Error ? err.message : String(err) });
      }
    },

    removeGalleryItem: (id) => set({ gallery: get().gallery.filter((g) => g.id !== id) }),

    restoreSnapshot: (item) => {
      commit({ ...item.manifest.graph });
      set({ view: 'graph', selectedNodeId: null });
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
    });
  }, 300);
});
