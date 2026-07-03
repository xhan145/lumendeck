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
import { loadPersisted, savePersisted } from './persistence';

export const APP_VERSION = '0.1.0';

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
        const adapter = activeAdapter(adapterId);
        const result = await adapter.generate(job, (progress) => patch({ progress }));
        // Freeze the manifest with the *resolved* seed.
        const manifest = buildManifest(workflow, shelf, APP_VERSION, new Date());
        manifest.seed = result.seed;
        const item: GalleryItem = {
          id: uid('render'),
          dataUrl: result.dataUrl,
          createdAt: manifest.createdAt,
          manifest,
        };
        set({ gallery: [item, ...get().gallery] });
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
