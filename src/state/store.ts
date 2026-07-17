import { create } from 'zustand';
import { buildRenderJob, isArchiveResult, normalizeProgress, type BackendAdapter, type RenderProgressCallback, type SvdModelInfo, type AnimateStillOptions } from '../bridge/adapter';
import { CloudAdapter } from '../bridge/cloudAdapter';
import { ComfyAdapter } from '../bridge/comfyAdapter';
import { HttpAdapter, type BridgeModelFolderStatus, type BridgeModelStatus } from '../bridge/httpAdapter';
import { MockAdapter } from '../bridge/mockAdapter';
import { checkHealth, VRAM_BUDGET_GB, type HealthIssue } from '../core/health';
import { buildManifest, type ExportManifest } from '../core/manifest';
import { findAsset, type ModelAsset } from '../core/shelf';
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
  setNodeDepth as setNodeDepthWf,
  removeNode,
  uid,
  updateNodeParam,
} from '../core/workflow';
import { DEMO_SHELF } from '../data/demoShelf';
import { TEMPLATES } from '../data/templates';
import type { LumenFile } from '../core/lumenFile';
import { TURBO_BACKENDS } from '../turboForge/backends';
import { clearBenchmarks, loadBenchmarks, measuredSpeedupPercent, saveBenchmark } from '../turboForge/benchmarks';
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
import {
  applyProfileToJob,
  classifyBackendError,
  classifyModelCompatibility,
  getHardwareProfile,
  isConstrainedProfile,
  planSafeRetry,
  resolveEffectiveProfile,
  selectOptimizations,
  snapshotFromBridgeStatus,
  type CompatibilityInput,
  type EffectiveProfileId,
  type HardwareProfileId,
  type HardwareSnapshot,
} from '../core/hardware';
import type { DiagnosticsHardware } from '../core/diagnostics';
import { loadPersisted, savePersisted, persistedProjection, takeLegacyGallery, clearLegacyGallery } from './persistence';
import { resolveGalleryStore, type Collection } from './galleryDb';
import {
  addRender as addRenderOp,
  removeRender as removeRenderOp,
  createCollection as createCollectionOp,
  renameCollection as renameCollectionOp,
  deleteCollection as deleteCollectionOp,
  assignToCollection as assignToCollectionOp,
  addTag as addTagOp,
  removeTag as removeTagOp,
  migrateLegacyGallery,
} from '../core/gallery/ops';
import { APP_VERSION } from './storeConstants';
import { DEFAULT_APP_SETTINGS, sanitizeAppSettings, type AppSettings } from './appSettings';
import { hydratePromptTools, type PromptToolsState } from './promptTools';
import { deletePreset as deletePresetPure, savePreset as savePresetPure, findPreset, type PromptPreset } from '../core/prompt/presets';
import type { WildcardSet } from '../core/prompt/wildcards';
import { record as recordHistoryPure, toggleFavorite as toggleFavoritePure, type PromptHistoryEntry } from '../core/prompt/history';
import { planVariations, type VariationAxis } from '../core/prompt/variations';
import { defaultTransport, hydrateMotion, makeClip } from './motion';
import { sampleClip, trackKey } from '../core/motion/interpolate';
import { applyPatches, buildMotionRenderJobs } from '../core/motion/renderPlan';
import {
  buildEvolveKnobs,
  crossover,
  genomeToPatches,
  mutate,
  randomGenome,
  seedFromString,
  selectTopK,
  type Genome,
  type KnobDesc,
} from '../core/evolve/genome';
import { mulberry32 } from '../core/prompt/wildcards';
import { isBindable } from '../core/motion/binding';
import type { Keyframe, MotionClip, MotionState, MotionTrack, OrbMotion, TransportState } from '../core/motion/types';
import { hydrateField, type Anchor, type FieldState, type Ghost } from './field';
import { fieldProfile, profileHasAxes, type FieldProfile } from '../core/field/fieldProfile';
import { applyField } from '../core/field/applyField';
import {
  applyPresetAxes,
  cloneBundle,
  fieldProfileFromPreset,
  type AxisBundle,
  type FieldPreset,
} from '../core/field/presets';
import { buildPreviewJob } from '../core/field/preview';
import { fanOutRackPatches, isRackAggregatePatch } from '../core/field/rackFanout';
import { pathToClip, type PathSample } from '../core/field/pathToClip';
import { estimateFamilyFromModelId, type ControlNetFamily } from '../core/controlnet';
import { defaultAudioState, hydrateAudio, SENSITIVITY_MIN, SENSITIVITY_MAX, type AudioSourceKind, type AudioState } from './audio';
import { hydrateNodeMeta, seedNodeMeta, touchNode, type NodeMetaMap } from './nodeMeta';
import { AudioEngine, type AudioSource } from '../audio/engine';
import { computeBands, scaleBands } from '../core/audio/bands';
import { audioToClip, type AudioSample } from '../core/audio/audioToClip';
import type { AudioMapping } from '../core/audio/mapping';
import {
  buildAnalysisContext,
  hydrateCreative,
  type CreativeState,
} from './creative';
import { hydrateShares, addShare, removeShare, type PublishedShare } from './shares';
import { unpublishShowcase, type UnpublishResult } from '../bridge/publish';
import { downloadJson, downloadBase64, slugify } from '../bridge/exporter';
import type {
  CreativeRecipe,
  EntropyAction,
  EntropyItem,
  ProjectBrain,
  ProjectType,
} from '../core/creative/types';
import {
  createBrain,
  recordEvent,
  touchOpened,
  updateBrain,
  buildProjectFile,
  type ProjectFile,
} from '../core/creative/brain';
import {
  applyRecipe as applyRecipePure,
  createRecipe as createRecipePure,
  duplicateRecipe as duplicateRecipePure,
  markRecipeUsed,
  updateRecipe as updateRecipePure,
} from '../core/creative/recipes';
import { buildReleasePack, packExportRecord, type ReleasePack } from '../core/creative/releasePack';
import { analyzePortfolio, type PortfolioReport } from '../core/creative/portfolio';
import { generateSocialCaptions } from '../core/creative/generate';
import { creativeId } from '../core/creative/brain';
import type { AnalysisContext } from '../core/creative/context';
import { buildCreativeDemo } from '../data/creativeDemo';

// Re-export the field slice types so the 3D UI (Graph3DView) imports them from the
// store alongside the actions, matching the motion slice's ergonomics.
export type { Ghost, Anchor, FieldState } from './field';
export type { AudioState } from './audio';
export type { AudioSource } from '../audio/engine';
export type { CreativeState } from './creative';

export type ViewId =
  | 'mission'
  | 'constellation'
  | 'overview'
  | 'craft'
  | 'projects'
  | 'recipes'
  | 'entropy'
  | 'proof'
  | 'guide'
  | 'recipe'
  | 'graph'
  | 'shelf'
  | 'gallery'
  | 'controls'
  | 'settings'
  | 'diagnostics'
  | 'performance'
  | 'support'
  | 'credits';

export interface GalleryItem {
  id: string;
  dataUrl: string;
  mediaType?: 'image' | 'video';
  mimeType?: string;
  extension?: string;
  createdAt: string;
  manifest: ExportManifest;
  selectedBackend?: RenderBackendId;
  actualBackend?: string;
  renderMode?: 'real' | 'mock' | 'procedural' | 'fallback' | 'unknown';
  fallback?: boolean;
  fallbackReason?: string;
  /** Collection this render belongs to; `null`/absent = uncategorized. */
  collectionId?: string | null;
  /** Free-form organization tags (deduped, case-insensitive). */
  tags?: string[];
}

export type { Collection } from './galleryDb';

export interface QueueJob {
  id: string;
  status: 'running' | 'done' | 'done_with_warning' | 'error';
  progress: number;
  label: string;
  phase?: string;
  previewDataUrl?: string;
  error?: string;
  fallback?: boolean;
  fallbackReason?: string;
  /** non-fatal render warning, e.g. skipped ControlNets */
  warning?: string;
  actualBackend?: string;
}

/** One scored candidate in an evolve generation (image + the genome that made it). */
export interface EvolveCandidateView {
  /** the candidate's index in the population sent to the backend (maps to a genome) */
  genomeIndex: number;
  /** the render knobs that produced this candidate (adopt/breed reuse it) */
  genome: Genome;
  dataUrl: string;
  score: number;
  breakdown: { clip: number | null; aesthetic: number };
}

/** One generation's population of scored candidates. */
export interface EvolveGeneration {
  candidates: EvolveCandidateView[];
}

/** The best candidate seen across the whole run (what "Adopt best" writes). */
export interface EvolveBest {
  dataUrl: string;
  score: number;
  breakdown: { clip: number | null; aesthetic: number };
  genome: Genome;
  generation: number;
  genomeIndex: number;
}

/**
 * Ephemeral Auto-Evolve slice (NEVER persisted — the candidate images are large
 * base64 blobs and belong in the durable Gallery only on Adopt). Holds the run
 * config, every generation's scored candidates, the running best, and the
 * interactive parent-pick state.
 */
export interface EvolveState {
  mode: 'auto' | 'interactive';
  /** objective weights (raw slider values; the server renormalizes + zeroes clip when off) */
  weights: { clip: number; aesthetic: number };
  population: number;
  generations: number;
  running: boolean;
  /** false when the backend could not load CLIP — surfaced as a LOUD banner */
  clipAvailable: boolean;
  fallbackReason: string | null;
  generationsData: EvolveGeneration[];
  best: EvolveBest | null;
  /** interactive: candidate genomeIndices in the LAST generation chosen as parents */
  selectedParents: number[];
  /** interactive: true while waiting for the user to pick parents + breed onward */
  awaitingParents: boolean;
  status: string | null;
  error: string | null;
  /** 0..1 progress of the generation currently rendering */
  progress: number;
}

/** Population/generation clamps (mirrored server-side per the integration contract). */
export const EVOLVE_POP_MIN = 2;
export const EVOLVE_POP_MAX = 8;
export const EVOLVE_GEN_MIN = 1;
export const EVOLVE_GEN_MAX = 6;
/** Per-gene mutation magnitude when breeding the next generation. */
const EVOLVE_MUTATION_RATE = 0.25;

function defaultEvolveState(): EvolveState {
  return {
    mode: 'auto',
    weights: { clip: 0.6, aesthetic: 0.4 },
    population: 4,
    generations: 3,
    running: false,
    clipAvailable: true,
    fallbackReason: null,
    generationsData: [],
    best: null,
    selectedParents: [],
    awaitingParents: false,
    status: null,
    error: null,
    progress: 0,
  };
}

interface StudioState {
  workflow: Workflow;
  shelf: ModelAsset[];
  shelfSource: 'demo' | 'bridge';
  health: HealthIssue[];
  /** Per-node activity metadata (createdAt / lastActiveAt) for the luminosity glow. */
  nodeMeta: NodeMetaMap;
  view: ViewId;
  selectedNodeId: string | null;
  rackPresets: RackPreset[];
  promptTools: PromptToolsState;
  /** Persisted motion clips + active clip (see src/state/motion.ts). */
  motion: MotionState;
  /** Render-Space Ghost Controller: ghosts + anchors (see src/state/field.ts). */
  field: FieldState;
  /** Ephemeral Auto-Evolve slice: search config + scored generations (NEVER persisted). */
  evolve: EvolveState;
  /** Audio Reactivity slice: source/running (ephemeral) + mapping/sensitivity (see src/state/audio.ts). */
  audio: AudioState;
  /**
   * Ephemeral playhead/transport — NEVER persisted. Carries both the live state
   * (playing/t/playbackRate) and the transport actions; the 3D/UI layer runs the
   * actual rAF advance and calls seek. Playback never auto-writes workflow params.
   */
  transport: TransportState & {
    play(): void;
    pause(): void;
    stop(): void;
    seek(t: number): void;
    setRate(r: number): void;
  };
  gallery: GalleryItem[];
  collections: Collection[];
  /** false until the gallery has been hydrated from IndexedDB at startup. */
  galleryReady: boolean;
  /** false when IndexedDB is unavailable and the gallery is memory-only this session. */
  galleryDurable: boolean;
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
  appSettings: AppSettings;
  queuePaused: boolean;
  controlStatus: string | null;
  turboPresetId: TurboPresetId;
  turboBackendId: BackendId;
  turboBenchmarks: BenchmarkResult[];
  turboLastPlan: RenderPlan | null;
  turboLastBenchmark: BenchmarkResult | null;
  turboBusy: boolean;
  turboError: string | null;
  /**
   * Ephemeral last-render hardware event (NEVER persisted). Records whether the
   * last render hit a CUDA OOM, whether it fell back, and whether the one-time
   * safe retry ran. Feeds diagnostics + the profile status panel.
   */
  hardwareEvent: { oomCategory: 'cuda_oom' | 'other' | 'none'; fallbackOccurred: boolean; safeRetryUsed: boolean };

  setView(view: ViewId): void;
  updateAppSettings(settings: Partial<AppSettings>): void;
  resetAppSettings(): void;
  /** Select the hardware profile (persists via appSettings; never crashes on unknown ids). */
  setHardwareProfile(id: HardwareProfileId): void;
  /** Build a hardware snapshot from the current bridge status (null when unknown). */
  hardwareSnapshot(): HardwareSnapshot | null;
  /** Resolve the selected profile to a concrete effective profile via detection. */
  effectiveHardwareProfile(): EffectiveProfileId;
  /** Assemble redacted hardware diagnostics for the Diagnostics page. */
  hardwareDiagnostics(): DiagnosticsHardware;
  selectNode(id: string | null): void;
  setWorkflow(wf: Workflow): void;
  updateParam(nodeId: string, paramId: string, value: unknown): void;
  moveNodeTo(nodeId: string, x: number, y: number): void;
  /** Set a node's explicit world-depth (3D free-placement); non-finite clears it. */
  setNodeDepth(nodeId: string, z: number): void;
  /** Drive a node's params from a field POSITION (control-mode node drag; intensity 1). */
  controlNode(nodeId: string, pos: { x: number; y: number; z: number }): void;
  /**
   * True when a node has at least one controllable axis under the EFFECTIVE field
   * profile (the active preset if one is set, else the curated profile) — i.e.
   * whether controlNode would actually write params. The 3D control-mode gate uses
   * this so the mode decision and the field write always agree.
   */
  nodeControllable(nodeId: string): boolean;
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

  // Prompt & Creative Tooling
  savePreset(preset: PromptPreset): void;
  applyPreset(id: string): void;
  deletePreset(id: string): void;
  upsertWildcardSet(set: WildcardSet): void;
  deleteWildcardSet(name: string): void;
  recordHistory(entry: PromptHistoryEntry): void;
  toggleFavorite(id: string): void;
  loadHistoryEntry(id: string): void;
  enqueueVariations(axis: VariationAxis, count: number): Promise<void>;

  // Motion Engine — clip/track authoring (persisted) + ephemeral transport.
  createClip(name?: string): void;
  deleteClip(id: string): void;
  setActiveClip(id: string | null): void;
  addTrack(nodeId: string, param: string): void;
  removeTrack(trackId: string): void;
  /** Add a keyframe (id auto-generated). Returns the new keyframe's stable id. */
  addKeyframe(trackId: string, t: number, value: number): string;
  /** Patch a keyframe found BY STABLE ID (drag/re-sort safe — never by index). */
  updateKeyframe(trackId: string, kfId: string, patch: Partial<Keyframe>): void;
  /** Remove a keyframe found BY STABLE ID. */
  removeKeyframe(trackId: string, kfId: string): void;
  setClipDuration(id: string, duration: number): void;
  setClipFps(id: string, fps: number): void;
  setClipLoop(id: string, loop: boolean): void;
  setOrbMotion(nodeId: string, orbMotion: OrbMotion): void;
  /** Sample the active clip at `atT` and commit each track's value into its capsule param (undo-safe, one commit). */
  bakeClipToWorkflow(atT: number): void;
  /**
   * Render the active motion clip: build per-frame jobs, run the active backend's
   * renderMotion, and land the resulting video in the Gallery with a motion
   * manifest. Progress is reported through `onProgress`. Returns the fallback
   * reason string when the backend produced a placeholder (else null); throws on
   * a hard failure (surfaced by the caller). Never lands a silent placeholder.
   */
  renderActiveMotionClip(
    opts: { frames: number; fps: number; format: 'mp4' | 'gif' | 'webm' | 'frames' },
    onProgress?: RenderProgressCallback,
  ): Promise<{ fallbackReason: string | null; archive?: boolean }>;

  /* -------------------------------------------------- SVD "Animate this render" */
  svdModels: SvdModelInfo[];
  refreshSvdModels(): Promise<void>;
  /** Animate a gallery still into a coherent SVD clip; lands the clip in the gallery. */
  animateStill(galleryId: string, opts: Omit<AnimateStillOptions, 'jobId'>, onProgress?: RenderProgressCallback): Promise<{ ok: boolean; error?: string }>;

  // Render-Space Ghost Controller — spatial parameter control + path recording.
  /** The curated field profile for a node (empty {} when it has no numeric params). */
  fieldProfileFor(nodeId: string): FieldProfile;
  /** Spawn one ghost for a node (no-op if it has no drivable params or already has a ghost). */
  spawnGhost(nodeId: string): void;
  /** Move a ghost to a normalized position; writes the node's params via applyField in ONE commit. */
  moveGhost(id: string, pos: { x: number; y: number; z: number }): void;
  /** Set a ghost's [0,1] intensity; re-applies its position so params re-tint live. */
  setGhostIntensity(id: string, v: number): void;
  /** Toggle a ghost's pinned flag. */
  pinGhost(id: string): void;
  /** Remove a ghost; the node's params stay where the ghost left them. */
  collapseGhost(id: string): void;
  /** Save the ghost's current position + resolved param values as a named anchor. */
  saveAnchor(id: string, name: string): void;
  /** Restore an anchor: move its node's ghost there + write the saved values in one commit. */
  restoreAnchor(anchorId: string): void;
  /** Delete a saved anchor. */
  deleteAnchor(id: string): void;
  /** Start sampling a ghost's position over wall-clock time (starvation-safe timer). */
  startGhostRecording(id: string): void;
  /** Stop recording -> pathToClip -> add the clip to the motion slice + set active. */
  stopGhostRecording(id: string): void;
  /** Cancel all in-progress ghost recordings (no clip) — called on 3D-view unmount. */
  cancelAllGhostRecordings(): void;

  // Field Presets + Streaming Preview — curated X/Y/Z param maps + live low-res preview.
  /** Select a preset (drives the orb/ghost axes) or null for the v0.16 auto field. */
  setActiveFieldPreset(id: string | null): void;
  /** Save a custom preset from a name + all-three axis bundles; returns its new id. */
  saveFieldPreset(name: string, axes: { x: AxisBundle; y: AxisBundle; z: AxisBundle }): string;
  /** Replace one axis bundle on a preset (edit-and-keep). */
  updateFieldPresetAxis(id: string, axis: 'x' | 'y' | 'z', bundle: AxisBundle): void;
  /** Remove a preset from the list (builtins HIDE via persistence; customs delete). */
  deleteFieldPreset(id: string): void;
  /** Per-session toggle for drag-to-preview streaming (off by default). */
  setStreamingEnabled(on: boolean): void;
  /**
   * Render ONE low-res streaming preview of the active preset at `pos`: resolve
   * its axes → patches → a fast preview job → the active backend's `generate`,
   * storing the image in `field.previewImage`. A MONOTONIC token supersedes an
   * older in-flight call so only the latest position's result lands (stale results
   * are discarded). Loud, honest failure on no bridge — never a fabricated image.
   */
  runFieldPreview(pos: { x: number; y: number; z: number }): Promise<void>;
  /**
   * Promote the last-previewed position to a FULL gallery render: commit the
   * active preset's params at that position into the workflow, then run the normal
   * enqueueRender path. No-op with a loud status when no preset is active.
   */
  promoteFieldPreviewToRender(): Promise<void>;

  // Auto-Evolve — explore→score→evolve search (frontend loops /evolve-step per gen).
  /** Update the evolve config (mode/weights/population/generations), all clamped. */
  setEvolveConfig(patch: {
    mode?: 'auto' | 'interactive';
    weights?: { clip?: number; aesthetic?: number };
    population?: number;
    generations?: number;
  }): void;
  /**
   * Run the search: gen 0 = random population, then (Auto) breed+score to the
   * generation limit, or (Interactive) score one generation and wait for the user
   * to pick parents. Renders + scores each generation through the active backend's
   * `evolveStep`. Surfaces `clipAvailable=false` loudly; never a silent placeholder.
   */
  runEvolve(): Promise<void>;
  /** Interactive: toggle a candidate (by genomeIndex) as a parent for the next gen. */
  pickEvolveParent(genomeIndex: number): void;
  /** Interactive: breed the next generation from the picked parents (else the top-K). */
  evolveNextGeneration(): Promise<void>;
  /** Write the best genome's params into the workflow (one commit) + add its image to the Gallery. */
  adoptBest(): Promise<void>;
  /** Clear the current run's generations/best/status (keeps the config). */
  clearEvolve(): void;

  // Audio Reactivity — live analysis overlay + bake-to-clip (see src/state/audio.ts).
  /** Start the engine on a source; pauses motion playback first (never both drive orbs). Loud status on failure. */
  startAudio(source: AudioSource): Promise<void>;
  /** Stop the engine + any bake sampler; orbs return to rest (never persisted). */
  stopAudio(): void;
  /** Replace the editable band -> orb-channel mapping. */
  setAudioMapping(mapping: AudioMapping): void;
  /** Set the global band sensitivity (clamped). */
  setAudioSensitivity(v: number): void;
  /** Record `seconds` of bands (wall-clock sampler) -> audioToClip -> motion slice + active. */
  bakeAudioClip(seconds: number): void;

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
  pauseQueue(): void;
  resumeQueue(): void;
  cancelRunningJobs(): void;
  clearQueue(): void;
  clearLocalHistory(): void;
  setControlStatus(message: string | null): void;
  removeGalleryItem(id: string): void;
  hydrateGallery(): Promise<void>;
  createCollection(name: string): Promise<void>;
  renameCollection(id: string, name: string): Promise<void>;
  deleteCollection(id: string): Promise<void>;
  assignToCollection(itemId: string, collectionId: string | null): Promise<void>;
  addTag(itemId: string, tag: string): Promise<void>;
  removeTag(itemId: string, tag: string): Promise<void>;
  restoreSnapshot(item: GalleryItem): void;
  loadWorkflowFile(file: LumenFile): void;
  applyTemplate(id: string): void;

  /* -------------------------------------------------- Creative OS slice */
  creative: CreativeState;
  /** Live analysis context projected from gallery + brains + shelf. */
  analysisContext(): AnalysisContext;
  /** Cross-project portfolio analysis for the Studio Overview. */
  portfolioReport(): PortfolioReport;
  createProject(name: string, type: ProjectType): string;
  updateProjectBrain(id: string, mutate: (b: ProjectBrain) => ProjectBrain): void;
  deleteProject(id: string): void;
  setActiveProject(id: string | null): void;
  openProject(id: string): void;
  /** Link the newest (or a specific) gallery render to a project. */
  linkRenderToProject(projectId: string, galleryId: string): void;
  unlinkRenderFromProject(projectId: string, galleryId: string): void;
  addPromptToProject(projectId: string, text: string, negative?: string): void;
  addAssetToProject(projectId: string, label: string, kind: ProjectBrain['assets'][number]['kind'], galleryId?: string): void;
  repairProjectAsset(projectId: string, assetId: string, galleryId: string | null): void;
  archiveProjectAsset(projectId: string, assetId: string): void;
  addPublishedLink(projectId: string, label: string, url: string): void;
  markProjectShipped(projectId: string): void;
  generateProjectCaptions(projectId: string): void;
  /** Assemble + download a release pack; records an export on the brain. Returns the pack (or null if project missing). */
  buildProjectReleasePack(projectId: string): ReleasePack | null;
  exportProjectFile(projectId: string): void;
  importProjectFile(file: ProjectFile): void;

  createCreativeRecipe(name: string): string;
  updateCreativeRecipe(id: string, patch: Partial<CreativeRecipe>): void;
  duplicateCreativeRecipe(id: string): void;
  deleteCreativeRecipe(id: string): void;
  /** Apply a recipe to the live workflow (prompt/negative/model/canvas). */
  applyCreativeRecipe(id: string, subject: string): void;
  /** Turn a render (or the live prompt, or an explicit prompt text) into a reusable recipe. */
  promoteToRecipe(input: { galleryId?: string; name?: string; text?: string }): string;
  linkRecipeToProject(projectId: string, recipeId: string): void;

  /** Resolve one entropy finding via its recommended action. */
  resolveEntropyItem(item: EntropyItem, action: EntropyAction): void;
  setAiEnabled(on: boolean): void;
  seedCreativeDemo(): void;

  /* -------------------------------------------------- Published share-links */
  publishedShares: PublishedShare[];
  recordPublishedShare(input: Omit<PublishedShare, 'id' | 'publishedAt'>): void;
  /** Local-only removal ("Forget locally") — does not call the server. */
  removePublishedShare(id: string): void;
  /** Server-side unpublish; removes the local row only when the server confirms. */
  unpublishShare(id: string): Promise<UnpublishResult>;
}

export const mockAdapter = new MockAdapter();
export const httpAdapter = new HttpAdapter();
export const comfyAdapter = new ComfyAdapter();
export const cloudAdapter = new CloudAdapter();

// Durable gallery store (IndexedDB when available, in-memory fallback otherwise).
// Resolved once per session; `durable` is false in private-mode/unsupported envs.
const { store: galleryStore, durable: galleryDurable } = resolveGalleryStore();

// Set once the user explicitly picks a backend this session, so the auto-detect
// in probeBridge never overrides a deliberate choice.
let userPinnedBackend = false;
// Set once the user explicitly picks a checkpoint this session, so auto-select
// never overrides a deliberate choice.
let userPinnedModel = false;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Active ghost-recording sessions, keyed by ghost id. Kept OUTSIDE store state
 * (never persisted, never part of the render projection) — the samples buffer and
 * the timer handle are pure runtime plumbing. The stepper is wall-clock based (a
 * plain interval sampling performance.now() deltas), NOT a bare rAF loop, so a
 * hidden/occluded/headless window still records the path (mirrors the Motion
 * Engine's starvation-safe stepper rationale in playbackClock.ts).
 */
interface GhostRecording {
  samples: PathSample[];
  timer: ReturnType<typeof setInterval>;
  startedAt: number;
}
const ghostRecordings = new Map<string, GhostRecording>();
/** Sample cadence for ghost path recording (~15Hz — plenty for value curves). */
const GHOST_RECORD_INTERVAL_MS = 66;

/**
 * Field streaming-preview supersede state, kept OUTSIDE store state (never
 * persisted, never part of the render projection). `fieldPreviewToken` is a
 * monotonic counter: each `runFieldPreview` captures the token it bumped to, and
 * a result only writes `previewImage` if its token is STILL the latest — so a
 * newer settled position discards a stale in-flight render. (Promotion reads the
 * ACTIVE GHOST's position, not a streamed midpoint — see promoteFieldPreviewToRender.)
 */
let fieldPreviewToken = 0;
/** Monotonic wall clock in ms (performance.now when present, else Date.now). */
const wallNow = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();

/**
 * The single, module-level audio engine (AudioContext + AnalyserNode). Kept
 * OUTSIDE store state — it is imperative browser plumbing, never persisted and
 * never part of the render projection. The reactive tick in Graph3DView reads
 * frames via `readAudioFrequency()`; stopAudio() + 3D-view unmount tear it down.
 */
const audioEngine = new AudioEngine();

/**
 * Active audio-bake session (module-level, like ghostRecordings): a wall-clock
 * setInterval sampling `performance.now()` deltas — NOT a bare rAF — so the
 * capture window is honored even if the tab is occluded. Null when not baking.
 */
interface AudioBake {
  samples: AudioSample[];
  timer: ReturnType<typeof setInterval>;
  startedAt: number;
}
let audioBake: AudioBake | null = null;
/** Sample cadence for audio baking (~15Hz — plenty for value curves). */
const AUDIO_BAKE_INTERVAL_MS = 66;

/** Read the current byte FFT from the shared engine (empty when stopped). */
export function readAudioFrequency(): Uint8Array {
  return audioEngine.read();
}

/** The node an audio clip bakes onto: the first mapped target, else the sampler, else the first node. */
function primaryAudioNodeId(mapping: AudioMapping, workflow: Workflow): string {
  return (
    mapping.targets[0]?.nodeId ??
    workflow.nodes.find((n) => n.kind === 'sampler')?.id ??
    workflow.nodes[0]?.id ??
    ''
  );
}

/** Tear down an in-progress audio bake sampler (idempotent). */
function stopAudioBake(): void {
  if (audioBake) {
    clearInterval(audioBake.timer);
    audioBake = null;
  }
}

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

/**
 * Effective GPU VRAM budget in GB for health checks, from the active hardware
 * profile. Profiles without a VRAM budget (High Performance / CPU) fall back to
 * the default 8 GB, so users who did not opt into a constrained profile keep the
 * existing warning behavior.
 */
function hardwareBudgetGB(appSettings: AppSettings, bridgeModelStatus: BridgeModelStatus | null): number {
  const effective = resolveEffectiveProfile(appSettings.hardwareProfile, snapshotFromBridgeStatus(bridgeModelStatus));
  const mb = getHardwareProfile(effective).vramBudgetMb;
  return mb != null ? mb / 1024 : VRAM_BUDGET_GB;
}

/**
 * Hardware-profile compatibility issues for the CURRENT workflow: when a
 * constrained profile is active, surface the classification verdict (video/Flux
 * unsupported, SDXL needs offload, ...) as a health warning BEFORE a render is
 * spent. Unconstrained profiles return [] so existing behavior is untouched.
 */
function hardwareHealthIssues(
  wf: Workflow,
  shelf: ModelAsset[],
  appSettings: AppSettings,
  bridgeModelStatus: BridgeModelStatus | null,
): HealthIssue[] {
  const profileId = resolveEffectiveProfile(appSettings.hardwareProfile, snapshotFromBridgeStatus(bridgeModelStatus));
  const profile = getHardwareProfile(profileId);
  // Only CONSTRAINED profiles surface compatibility issues — `balanced` carries
  // an advisory 8GB budget but never reins in jobs, and warning ordinary 8GB
  // SDXL users would break "unconstrained behavior is unchanged".
  if (!isConstrainedProfile(profileId)) return [];
  const job = buildRenderJob(wf);
  const family = (findAsset(shelf, job.modelId ?? '')?.family ?? 'Unknown') as CompatibilityInput['modelFamily'];
  const compat = classifyModelCompatibility({
    profileId,
    modelFamily: family,
    isVideo: job.output === 'video',
    controlNetCount: job.controlNets?.length ?? 0,
    loraCount: job.loras.length,
    refiner: false,
    upscaler: (job.hiresScale ?? 1) > 1,
  });
  if (compat.category === 'recommended' || compat.category === 'compatible-limited') return [];
  return [{
    id: 'hardware-compat',
    severity: 'warning',
    code: 'hardware-compat',
    message: `${profile.name}: ${compat.label}. ${compat.reasons.join(' ')}`,
  }];
}

/** Health = the graph checks (profile-aware VRAM budget) + hardware compatibility. */
function computeHealth(
  wf: Workflow,
  shelf: ModelAsset[],
  appSettings: AppSettings,
  bridgeModelStatus: BridgeModelStatus | null,
): HealthIssue[] {
  return [
    ...checkHealth(wf, shelf, hardwareBudgetGB(appSettings, bridgeModelStatus)),
    ...hardwareHealthIssues(wf, shelf, appSettings, bridgeModelStatus),
  ];
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
  if (settings.selectedBackend === 'cloud') {
    // Cloud calls are proxied through the LOCAL bridge so keys stay off the browser.
    cloudAdapter.setBaseUrl(settings.bridgeUrl);
    cloudAdapter.setProvider(settings.cloudProvider);
    cloudAdapter.setModel(settings.cloudModel);
    return cloudAdapter;
  }
  return mockAdapter;
}

const persisted = loadPersisted();
const initialPromptTools = hydratePromptTools(persisted.promptTools);
const initialWorkflow = applyAutoCheckpoint(persisted.workflow ?? createDefaultWorkflow(), DEMO_SHELF);
const initialMotion = hydrateMotion(persisted.motion, initialWorkflow);
const initialField = hydrateField(persisted.field);
const initialAudio = hydrateAudio(persisted.audio, initialWorkflow);
const initialNodeMeta = seedNodeMeta(
  hydrateNodeMeta(persisted.nodeMeta),
  initialWorkflow.nodes.map((n) => n.id),
  Date.now(),
);
const initialBackendSettings = sanitizeBackendSettings(persisted.backendSettings ?? DEFAULT_BACKEND_SETTINGS);
const initialAppSettings = sanitizeAppSettings(persisted.appSettings ?? DEFAULT_APP_SETTINGS);
const initialShares = hydrateShares(persisted.shares);
const initialCreative = hydrateCreative(persisted.creative);
const initialView: ViewId = initialAppSettings.startupBehavior === 'controls'
  ? 'controls'
  : initialAppSettings.startupBehavior === 'last-view' && initialAppSettings.lastView
    ? initialAppSettings.lastView
    : 'mission';

export const useStudio = create<StudioState>((set, get) => {
  /**
   * Commit a workflow mutation (+ recompute health), stamping luminosity activity
   * in the SAME set. A node counts as "active" when it is brand-new OR its params
   * object reference changed — updateNodeParam preserves the reference of every
   * UNCHANGED node, so this diff catches EVERY edit path (inspector, ghost drags,
   * presets, history, bake, rack edits, …) and node creation, without threading
   * ids through each action. Move/connect/layout leave params refs intact, so
   * they are correctly NOT treated as activity.
   */
  const commit = (wf: Workflow) => {
    const prev = new Map(get().workflow.nodes.map((n) => [n.id, n]));
    const now = Date.now();
    let nodeMeta = get().nodeMeta;
    for (const n of wf.nodes) {
      const before = prev.get(n.id);
      if (!before || before.params !== n.params) nodeMeta = touchNode(nodeMeta, n.id, now);
    }
    set({ workflow: wf, health: computeHealth(wf, get().shelf, get().appSettings, get().bridgeModelStatus), turboLastPlan: null, turboError: null, nodeMeta });
  };

  // ---- Motion helpers (keep the actions terse; all pure list edits) ----
  const setMotion = (motion: MotionState) => set({ motion });
  const mapClips = (fn: (clip: MotionClip) => MotionClip) =>
    setMotion({ ...get().motion, clips: get().motion.clips.map(fn) });
  /** Edit exactly the clip with `id`, leaving others untouched. */
  const editClip = (id: string, fn: (clip: MotionClip) => MotionClip) =>
    mapClips((c) => (c.id === id ? fn(c) : c));
  /** Edit whichever clip owns `trackId` (and that track), leaving others untouched. */
  const editTrack = (trackId: string, fn: (track: MotionTrack) => MotionTrack) =>
    mapClips((c) =>
      c.tracks.some((t) => t.id === trackId)
        ? { ...c, tracks: c.tracks.map((t) => (t.id === trackId ? fn(t) : t)) }
        : c,
    );
  const activeClip = () => get().motion.clips.find((c) => c.id === get().motion.activeClipId) ?? null;
  /** Replace transport state while preserving the bound method references. */
  const patchTransport = (patch: Partial<TransportState>) =>
    set({ transport: { ...get().transport, ...patch } });

  // ---- Field / Ghost helpers ----
  const setField = (field: FieldState) => set({ field });
  const editGhost = (id: string, fn: (g: Ghost) => Ghost) =>
    setField({ ...get().field, ghosts: get().field.ghosts.map((g) => (g.id === id ? fn(g) : g)) });
  const findGhost = (id: string): Ghost | undefined => get().field.ghosts.find((g) => g.id === id);
  /** The model family for range adaptation, derived from the Model capsule's asset id. */
  const currentFamily = (): ControlNetFamily => {
    const model = findNode(get().workflow, 'model');
    return estimateFamilyFromModelId(String(model?.params.assetId ?? ''));
  };
  /** The positive prompt text for prompt-marker biasing (empty when absent). */
  const currentPromptText = (): string =>
    String(findNode(get().workflow, 'prompt')?.params.positive ?? '');
  /** The active field preset (null when none selected or the id no longer resolves). */
  const activeFieldPreset = (): FieldPreset | null => {
    const id = get().field.activePresetId;
    if (!id) return null;
    return get().field.presets.find((p) => p.id === id) ?? null;
  };
  /**
   * Build a node's field profile. When a preset is ACTIVE it supplies the axes
   * (filtered to the params this node's kind owns), so the ghost/orb navigate the
   * preset's field; with no preset this is the unchanged v0.16 curated profile.
   */
  const profileForNode = (nodeId: string): FieldProfile => {
    const node = get().workflow.nodes.find((n) => n.id === nodeId);
    if (!node) return {};
    const preset = activeFieldPreset();
    if (preset) return fieldProfileFromPreset(preset, node.kind);
    return fieldProfile(node.kind, currentFamily(), node.params, currentPromptText());
  };
  /** Write a ghost's field patches into the workflow in ONE commit (gradient/ring re-tint). */
  /**
   * Apply a field POSITION to a node's params in ONE commit (gradient + ring
   * re-tint), via the same applyField + rack-fanout path the ghost uses. Shared
   * by the ghost drag AND direct 3D node control (control-mode node drag), so
   * both drive parameters identically. No-op when the node has no field profile.
   */
  const applyFieldPosToNode = (nodeId: string, pos: { x: number; y: number; z: number }, intensity: number) => {
    const node = get().workflow.nodes.find((n) => n.id === nodeId);
    const patches = applyField(pos, intensity, profileForNode(nodeId), nodeId);
    if (patches.length === 0) return;
    let next = get().workflow;
    for (const p of patches) next = updateNodeParam(next, p.nodeId, p.param, p.value);
    // A loraRack/controlNetRack aggregate weight/strength is a DEAD value that
    // buildRenderJob never reads (it reads per-slot); fan it into the enabled slots
    // so the drag actually moves the render (see rackFanout.ts).
    if (node && (node.kind === 'loraRack' || node.kind === 'controlNetRack')) {
      const aggParam = node.kind === 'loraRack' ? 'weight' : 'strength';
      const rackPatches = patches
        .filter((p) => p.param === aggParam)
        .map((p) => ({ node: node.kind as string, param: p.param, value: p.value }));
      if (rackPatches.length > 0) next = fanOutRackPatches(next, rackPatches);
    }
    commit(next);
  };

  const applyGhostToWorkflow = (ghost: Ghost) => applyFieldPosToNode(ghost.nodeId, ghost.pos, ghost.intensity);

  // ---- Auto-Evolve helpers ------------------------------------------------
  const evClampInt = (v: number, lo: number, hi: number): number =>
    Math.max(lo, Math.min(hi, Math.round(Number.isFinite(v) ? v : lo)));
  const evClamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0);
  const setEvolve = (patch: Partial<EvolveState>) => set({ evolve: { ...get().evolve, ...patch } });
  /** The sampler node id the search drives (evolve targets the sampler's knobs). */
  const evolveNodeId = (): string | null => findNode(get().workflow, 'sampler')?.id ?? null;
  /** The nodes a genome writes: sampler (cfg/steps/seed) + optional Load Image (strength). */
  const evolveNodes = (): { sampler: string; imageLoader?: string } | null => {
    const sampler = findNode(get().workflow, 'sampler')?.id;
    if (!sampler) return null;
    const img = findNode(get().workflow, 'imageLoader');
    return { sampler, imageLoader: img?.id };
  };
  /** True when the selected checkpoint is a turbo/LCM model (guidance pinned, few steps). */
  const currentIsTurbo = (): boolean => {
    const id = String(findNode(get().workflow, 'model')?.params.assetId ?? '');
    return /turbo|lcm|lightning/i.test(id);
  };
  /** True when the Load Image capsule carries an init image (img2img active). */
  const currentHasInitImage = (): boolean =>
    Boolean(String(findNode(get().workflow, 'imageLoader')?.params.image ?? ''));
  /** The evolve knobs that actually affect THIS model+workflow (no inert dimensions). */
  const evolveKnobs = (): KnobDesc[] =>
    buildEvolveKnobs({ family: currentFamily(), isTurbo: currentIsTurbo(), hasInitImage: currentHasInitImage() });
  /** The positive prompt CLIP scores candidates against. */
  const evolvePromptText = (): string => String(findNode(get().workflow, 'prompt')?.params.positive ?? '');
  /** Build one RenderJob per genome from the CURRENT base workflow (reuses buildRenderJob). */
  const buildEvolveJobs = (genomes: Genome[], nodes: { sampler: string; imageLoader?: string }, knobs: KnobDesc[]) => {
    const wf = get().workflow;
    const wildcards = get().promptTools.wildcardSets;
    // Evolve runs on the local bridge only (the UI gates it) — every genome job
    // gets the same hardware-profile treatment as a single render. Without it,
    // the worker's mem-folded pipe cache key mismatches and each evolve render
    // forces a full-VRAM legacy reload (guaranteed OOM on the 4GB profile).
    const snapshot = get().hardwareSnapshot();
    const profile = resolveEffectiveProfile(get().appSettings.hardwareProfile, snapshot);
    return genomes.map((g) =>
      applyProfileToJob(buildRenderJob(applyPatches(wf, genomeToPatches(g, knobs, nodes)), wildcards), profile, snapshot),
    );
  };
  /**
   * Breed the next generation: elitism (carry the single best parent unchanged) +
   * mutated uniform crossovers to fill the population. Deterministic given `rng`.
   */
  const breedGenomes = (parents: EvolveCandidateView[], knobs: KnobDesc[], population: number, rng: () => number): Genome[] => {
    const pool = parents.length > 0 ? parents : [];
    if (pool.length === 0) return Array.from({ length: population }, () => randomGenome(knobs, rng));
    const next: Genome[] = [pool[0].genome.slice()]; // elitism
    while (next.length < population) {
      const a = pool[Math.floor(rng() * pool.length)] ?? pool[0];
      const b = pool[Math.floor(rng() * pool.length)] ?? pool[0];
      next.push(mutate(crossover(a.genome, b.genome, knobs, rng), knobs, EVOLVE_MUTATION_RATE, rng));
    }
    return next.slice(0, population);
  };
  /**
   * Render + score ONE generation through the active backend's `evolveStep`, map
   * each candidate back to its genome, append it, and update the running best +
   * clipAvailable/fallbackReason. Returns the scored candidates (null on no sampler).
   */
  const runEvolveGeneration = async (genomes: Genome[], genIndex: number): Promise<EvolveCandidateView[] | null> => {
    const nodes = evolveNodes();
    if (!nodes) { setEvolve({ error: 'Add a Sampler capsule to evolve its render params.' }); return null; }
    const knobs = evolveKnobs();
    const jobs = buildEvolveJobs(genomes, nodes, knobs);
    const adapter = activeAdapter(get().backendSettings);
    const result = await adapter.evolveStep(
      jobs,
      { prompt: evolvePromptText(), weights: get().evolve.weights },
      (update) => setEvolve({ progress: normalizeProgress(update).progress }),
    );
    const views: EvolveCandidateView[] = result.candidates.map((c) => ({
      genomeIndex: c.index,
      genome: genomes[c.index] ?? genomes[0] ?? [],
      dataUrl: c.dataUrl,
      score: c.score,
      breakdown: c.breakdown,
    }));
    let best = get().evolve.best;
    for (const v of views) {
      if (!best || v.score > best.score) {
        best = { dataUrl: v.dataUrl, score: v.score, breakdown: v.breakdown, genome: v.genome, generation: genIndex, genomeIndex: v.genomeIndex };
      }
    }
    setEvolve({
      generationsData: [...get().evolve.generationsData, { candidates: views }],
      best,
      clipAvailable: result.clipAvailable,
      fallbackReason: result.fallbackReason ?? null,
      progress: 1,
    });
    return views;
  };

  // ---- Creative OS helpers (terse pure list edits on the creative slice) ----
  const setCreative = (patch: Partial<CreativeState>) => set({ creative: { ...get().creative, ...patch } });
  const editBrain = (id: string, fn: (b: ProjectBrain) => ProjectBrain) =>
    setCreative({ brains: get().creative.brains.map((b) => (b.id === id ? fn(b) : b)) });
  const getBrain = (id: string): ProjectBrain | undefined => get().creative.brains.find((b) => b.id === id);

  return {
    workflow: initialWorkflow,
    shelf: DEMO_SHELF,
    shelfSource: 'demo',
    health: computeHealth(initialWorkflow, DEMO_SHELF, initialAppSettings, null),
    nodeMeta: initialNodeMeta,
    view: initialView,
    selectedNodeId: null,
    rackPresets: persisted.rackPresets ?? [],
    promptTools: initialPromptTools,
    motion: initialMotion,
    field: initialField,
    evolve: defaultEvolveState(),
    audio: initialAudio,
    transport: {
      ...defaultTransport(),
      // Transport actions only mutate the ephemeral playhead (they preserve these
      // method refs via patchTransport). The 3D/UI layer runs the rAF advance and
      // calls seek. Playback NEVER commits sampled values (see bakeClipToWorkflow).
      // Starting playback STOPS audio first — the two must never both drive orbs.
      play: () => {
        if (get().audio.running) get().stopAudio();
        patchTransport({ playing: true });
      },
      pause: () => patchTransport({ playing: false }),
      stop: () => patchTransport({ playing: false, t: 0 }),
      seek: (t) => patchTransport({ t: Math.max(0, t) }),
      setRate: (r) => patchTransport({ playbackRate: Math.max(0, r) }),
    },
    gallery: [],
    collections: [],
    galleryReady: false,
    galleryDurable,
    creative: initialCreative,
    publishedShares: initialShares,
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
    svdModels: [],
    appSettings: initialAppSettings,
    queuePaused: false,
    controlStatus: null,
    turboPresetId: 'fast',
    turboBackendId: settingsBackendToTurboBackend(initialBackendSettings.selectedBackend),
    turboBenchmarks: loadBenchmarks(),
    turboLastPlan: null,
    turboLastBenchmark: null,
    turboBusy: false,
    turboError: null,
    hardwareEvent: { oomCategory: 'none', fallbackOccurred: false, safeRetryUsed: false },

    setView: (view) => set({ view, appSettings: { ...get().appSettings, lastView: view } }),
    updateAppSettings: (settings) => set({ appSettings: sanitizeAppSettings({ ...get().appSettings, ...settings }) }),
    resetAppSettings: () => set({ appSettings: DEFAULT_APP_SETTINGS, controlStatus: 'Settings reset to defaults.' }),
    setHardwareProfile: (id) => {
      // sanitizeAppSettings guards unknown ids → 'auto', so this never crashes.
      const appSettings = sanitizeAppSettings({ ...get().appSettings, hardwareProfile: id });
      // Recompute health so VRAM warnings reflect the new profile's budget.
      set({ appSettings, health: computeHealth(get().workflow, get().shelf, appSettings, get().bridgeModelStatus) });
    },
    hardwareSnapshot: () => snapshotFromBridgeStatus(get().bridgeModelStatus),
    effectiveHardwareProfile: () =>
      resolveEffectiveProfile(get().appSettings.hardwareProfile, snapshotFromBridgeStatus(get().bridgeModelStatus)),
    hardwareDiagnostics: () => {
      const snapshot = snapshotFromBridgeStatus(get().bridgeModelStatus);
      const selected = get().appSettings.hardwareProfile;
      const effective = resolveEffectiveProfile(selected, snapshot);
      const profile = getHardwareProfile(effective);
      const directive = selectOptimizations(effective, { hw: snapshot });
      const canvas = findNode(get().workflow, 'canvas');
      const model = findNode(get().workflow, 'model');
      const checkpoint = findAsset(get().shelf, String(model?.params.assetId ?? ''));
      const event = get().hardwareEvent;
      return {
        selectedProfile: selected,
        effectiveProfile: effective,
        gpuName: snapshot?.deviceName,
        totalVramMb: snapshot?.totalVramMb,
        freeVramMb: snapshot?.freeVramMb,
        backend: snapshot?.backend,
        cuda: snapshot?.cuda,
        computeCapability: snapshot?.computeCapability,
        precision: directive.precision,
        modelCpuOffload: directive.modelCpuOffload,
        sequentialCpuOffload: directive.sequentialCpuOffload,
        attentionSlicing: directive.attentionSlicing,
        vaeSlicing: directive.vaeSlicing,
        vaeTiling: directive.vaeTiling,
        resolutionLimit: profile.defaults.maxResolution,
        requestedResolution: canvas ? `${Number(canvas.params.width ?? 0)}x${Number(canvas.params.height ?? 0)}` : undefined,
        requestedBatch: canvas ? Number(canvas.params.batch ?? 1) : undefined,
        activeModelFamily: checkpoint?.family,
        oomCategory: event.oomCategory,
        fallbackOccurred: event.fallbackOccurred,
      };
    },
    selectNode: (selectedNodeId) => set({ selectedNodeId }),
    setWorkflow: (wf) => commit(wf),
    updateParam: (nodeId, paramId, value) => {
      // A deliberate checkpoint pick disables real-model auto-upgrade this session.
      if (paramId === 'assetId') {
        const node = get().workflow.nodes.find((n) => n.id === nodeId);
        if (node?.kind === 'model') userPinnedModel = true;
      }
      commit(updateNodeParam(get().workflow, nodeId, paramId, value)); // commit's diff stamps this node
    },
    moveNodeTo: (nodeId, x, y) => commit(moveNode(get().workflow, nodeId, x, y)),
    setNodeDepth: (nodeId, z) => commit(setNodeDepthWf(get().workflow, nodeId, z)),
    controlNode: (nodeId, pos) => applyFieldPosToNode(nodeId, pos, 1),
    nodeControllable: (nodeId) => {
      const p = profileForNode(nodeId); // preset-aware, same source controlNode writes through
      return !!(p.x || p.y || p.z);
    },
    connectSockets: (from, to) => commit(connect(get().workflow, from, to)),
    disconnectEdge: (edgeId) => commit(disconnect(get().workflow, edgeId)),
    addCapsule: (kind, x, y) => {
      const node = createNode(kind, x, y);
      commit(addNode(get().workflow, node)); // commit's diff stamps the new node
      set({ selectedNodeId: node.id });
    },
    duplicateCapsule: (nodeId) => {
      const before = get().workflow;
      const next = duplicateNode(before, nodeId);
      commit(next); // commit's diff stamps the new copy
      const copy = next.nodes.find((node) => !before.nodes.some((old) => old.id === node.id));
      if (copy) set({ selectedNodeId: copy.id });
    },
    autoLayoutGraph: () => commit(autoLayout(get().workflow)),
    removeCapsule: (nodeId) => {
      // Tear down any ghost/anchors + live recording timer bound to the removed
      // node, or they orphan the field slice and leak a setInterval forever.
      for (const g of get().field.ghosts.filter((g) => g.nodeId === nodeId)) {
        const r = ghostRecordings.get(g.id);
        if (r) { clearInterval(r.timer); ghostRecordings.delete(g.id); }
      }
      setField({
        ...get().field,
        ghosts: get().field.ghosts.filter((g) => g.nodeId !== nodeId),
        anchors: get().field.anchors.filter((a) => a.nodeId !== nodeId),
      });
      commit(removeNode(get().workflow, nodeId));
      if (get().selectedNodeId === nodeId) set({ selectedNodeId: null });
    },
    resetWorkflow: () => {
      // A fresh workflow orphans every ghost/anchor; clear them + all timers.
      for (const [, r] of ghostRecordings) clearInterval(r.timer);
      ghostRecordings.clear();
      setField({ ...get().field, ghosts: [], anchors: [] });
      // A fresh workflow also orphans the audio mapping's node ids: stop any live
      // session + bake, then re-seed the default mapping against the new graph
      // (preserving the user's sensitivity).
      stopAudioBake();
      audioEngine.stop();
      const freshWorkflow = createDefaultWorkflow();
      set({
        audio: { ...defaultAudioState(freshWorkflow), sensitivity: get().audio.sensitivity },
      });
      commit(freshWorkflow);
    },

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

    // ---- Prompt & Creative Tooling ----
    savePreset: (preset) =>
      set({ promptTools: { ...get().promptTools, presets: savePresetPure(get().promptTools.presets, preset) } }),

    applyPreset: (id) => {
      const preset = findPreset(get().promptTools.presets, id);
      if (!preset) return;
      const wf = get().workflow;
      const prompt = findNode(wf, 'prompt');
      const sampler = findNode(wf, 'sampler');
      let next = wf;
      // Write prompt text into the prompt capsule via the existing node-update path.
      if (prompt) {
        next = updateNodeParam(next, prompt.id, 'positive', preset.positive);
        next = updateNodeParam(next, prompt.id, 'negative', preset.negative);
      }
      // Optional sampler settings, only for fields the preset specifies.
      if (sampler && preset.settings) {
        const s = preset.settings;
        if (s.steps !== undefined) next = updateNodeParam(next, sampler.id, 'steps', s.steps);
        if (s.cfg !== undefined) next = updateNodeParam(next, sampler.id, 'cfg', s.cfg);
        if (s.sampler !== undefined) next = updateNodeParam(next, sampler.id, 'sampler', s.sampler);
        if (s.scheduler !== undefined) next = updateNodeParam(next, sampler.id, 'scheduler', s.scheduler);
      }
      commit(next);
      set({ controlStatus: `Applied preset "${preset.name}".` });
    },

    deletePreset: (id) =>
      set({ promptTools: { ...get().promptTools, presets: deletePresetPure(get().promptTools.presets, id) } }),

    upsertWildcardSet: (setDef) => {
      const sets = get().promptTools.wildcardSets;
      const idx = sets.findIndex((s) => s.name.toLowerCase() === setDef.name.toLowerCase());
      const nextSets = idx === -1 ? [...sets, setDef] : sets.map((s, i) => (i === idx ? setDef : s));
      set({ promptTools: { ...get().promptTools, wildcardSets: nextSets } });
    },

    deleteWildcardSet: (name) =>
      set({
        promptTools: {
          ...get().promptTools,
          wildcardSets: get().promptTools.wildcardSets.filter((s) => s.name.toLowerCase() !== name.toLowerCase()),
        },
      }),

    recordHistory: (entry) =>
      set({ promptTools: { ...get().promptTools, history: recordHistoryPure(get().promptTools.history, entry) } }),

    toggleFavorite: (id) =>
      set({ promptTools: { ...get().promptTools, history: toggleFavoritePure(get().promptTools.history, id) } }),

    loadHistoryEntry: (id) => {
      const entry = get().promptTools.history.find((e) => e.id === id);
      if (!entry) return;
      const wf = get().workflow;
      const prompt = findNode(wf, 'prompt');
      const sampler = findNode(wf, 'sampler');
      let next = wf;
      if (prompt) {
        next = updateNodeParam(next, prompt.id, 'positive', entry.positive);
        next = updateNodeParam(next, prompt.id, 'negative', entry.negative);
      }
      if (sampler) next = updateNodeParam(next, sampler.id, 'seed', entry.seed);
      commit(next);
      set({ controlStatus: 'Loaded prompt from history.' });
    },

    enqueueVariations: async (axis, count) => {
      const wf = get().workflow;
      const sampler = findNode(wf, 'sampler');
      const prompt = findNode(wf, 'prompt');
      const base = {
        seed: Number(sampler?.params.seed ?? 0),
        cfg: Number(sampler?.params.cfg ?? 7),
        steps: Number(sampler?.params.steps ?? 28),
      };
      // Wildcard axis sweeps a set's values if the prompt uses a single known token.
      let wildcardValues: string[] | undefined;
      if (axis === 'wildcard') {
        const first = get().promptTools.wildcardSets[0];
        wildcardValues = first?.values;
      }
      const patches = planVariations({ base, axis, count, wildcardValues });
      // Snapshot original params to restore after the sweep (a non-destructive plan).
      const original = {
        seed: sampler ? sampler.params.seed : undefined,
        cfg: sampler ? sampler.params.cfg : undefined,
        steps: sampler ? sampler.params.steps : undefined,
        positive: prompt ? prompt.params.positive : undefined,
      };
      for (const patch of patches) {
        let next = get().workflow;
        const s = findNode(next, 'sampler');
        const p = findNode(next, 'prompt');
        if (s && patch.seed !== undefined) next = updateNodeParam(next, s.id, 'seed', patch.seed);
        if (s && patch.cfg !== undefined) next = updateNodeParam(next, s.id, 'cfg', patch.cfg);
        if (s && patch.steps !== undefined) next = updateNodeParam(next, s.id, 'steps', patch.steps);
        if (p && patch.wildcardValue) {
          next = updateNodeParam(next, p.id, 'positive', `${String(original.positive ?? '')}, ${patch.wildcardValue}`);
        }
        commit(next);
        await get().enqueueRender();
      }
      // Restore the original sampler/prompt params after the sweep.
      let restored = get().workflow;
      const s = findNode(restored, 'sampler');
      const p = findNode(restored, 'prompt');
      if (s) {
        if (original.seed !== undefined) restored = updateNodeParam(restored, s.id, 'seed', original.seed);
        if (original.cfg !== undefined) restored = updateNodeParam(restored, s.id, 'cfg', original.cfg);
        if (original.steps !== undefined) restored = updateNodeParam(restored, s.id, 'steps', original.steps);
      }
      if (p && original.positive !== undefined) restored = updateNodeParam(restored, p.id, 'positive', original.positive);
      commit(restored);
    },

    // ---- Motion Engine ----
    createClip: (name) => {
      const clip = makeClip(name);
      setMotion({ clips: [...get().motion.clips, clip], activeClipId: clip.id });
    },
    deleteClip: (id) => {
      const wasActive = get().motion.activeClipId === id;
      const clips = get().motion.clips.filter((c) => c.id !== id);
      const activeClipId = wasActive ? (clips[0]?.id ?? null) : get().motion.activeClipId;
      setMotion({ clips, activeClipId });
      // Deleting the clip that is currently playing must never leave the transport
      // "playing" a clip that no longer exists (which would strand the playback
      // loop). Stop + rewind so we cleanly return to idle.
      if (wasActive && get().transport.playing) patchTransport({ playing: false, t: 0 });
    },
    setActiveClip: (id) => setMotion({ ...get().motion, activeClipId: id }),

    addTrack: (nodeId, param) => {
      const clip = activeClip();
      if (!clip) return;
      const node = get().workflow.nodes.find((n) => n.id === nodeId);
      // Only bind to a real numeric ParamDef on the node's capsule.
      if (!node || !isBindable(node.kind, param)) return;
      // One track per (node, param); don't duplicate.
      if (clip.tracks.some((t) => t.nodeId === nodeId && t.param === param)) return;
      const track: MotionTrack = { id: uid('track'), nodeId, param, keyframes: [] };
      editClip(clip.id, (c) => ({ ...c, tracks: [...c.tracks, track] }));
    },
    removeTrack: (trackId) =>
      mapClips((c) => ({ ...c, tracks: c.tracks.filter((t) => t.id !== trackId) })),

    addKeyframe: (trackId, t, value) => {
      // Mint the stable id up front so we can return it to the caller (the UI
      // may want to focus/select the freshly-added keyframe).
      const id = uid('kf');
      editTrack(trackId, (track) => {
        // Replace an existing keyframe at the same time; else insert in t-order.
        const rest = track.keyframes.filter((k) => k.t !== t);
        const kf: Keyframe = { id, t, value };
        const keyframes = [...rest, kf].sort((a, b) => a.t - b.t);
        return { ...track, keyframes };
      });
      return id;
    },
    updateKeyframe: (trackId, kfId, patch) =>
      editTrack(trackId, (track) => {
        if (!track.keyframes.some((k) => k.id === kfId)) return track;
        // Find BY ID (never index): the array is sorted by t, so a dragged/nudged
        // keyframe's index shifts when it crosses a neighbor — index-based edits
        // would corrupt the wrong keyframe. `id` is drag/re-sort safe.
        const keyframes = track.keyframes.map((k) => (k.id === kfId ? { ...k, ...patch } : k));
        // A time edit may reorder keyframes; keep them sorted by t.
        if (patch.t !== undefined) keyframes.sort((a, b) => a.t - b.t);
        return { ...track, keyframes };
      }),
    removeKeyframe: (trackId, kfId) =>
      editTrack(trackId, (track) => ({
        ...track,
        keyframes: track.keyframes.filter((k) => k.id !== kfId),
      })),

    setClipDuration: (id, duration) =>
      editClip(id, (c) => ({ ...c, duration: Math.max(0, duration) })),
    setClipFps: (id, fps) =>
      editClip(id, (c) => ({ ...c, fps: Math.max(1, Math.round(fps)) })),
    setClipLoop: (id, loop) => editClip(id, (c) => ({ ...c, loop })),

    setOrbMotion: (nodeId, orbMotion) => {
      const clip = activeClip();
      if (!clip) return;
      editClip(clip.id, (c) => ({ ...c, orbMotions: { ...c.orbMotions, [nodeId]: orbMotion } }));
    },

    bakeClipToWorkflow: (atT) => {
      const clip = activeClip();
      if (!clip) return;
      const values = sampleClip(clip, atT);
      if (values.size === 0) return;
      // Fold every sampled track value into ONE workflow commit so undo restores
      // the whole bake at once (never auto-write during playback — bake is explicit).
      let next = get().workflow;
      for (const track of clip.tracks) {
        const v = values.get(trackKey(track.nodeId, track.param));
        if (v != null) next = updateNodeParam(next, track.nodeId, track.param, v);
      }
      commit(next);
      set({ controlStatus: `Baked "${clip.name}" @ ${atT.toFixed(2)}s into the workflow.` });
    },

    renderActiveMotionClip: async (opts, onProgress) => {
      const clip = activeClip();
      if (!clip) throw new Error('No active motion clip to render.');
      const frames = Math.max(1, Math.floor(opts.frames));
      const { workflow, shelf, backendSettings } = get();
      // Build one RenderJob per animated frame from the CURRENT base workflow.
      const { jobs: rawJobs, frameTimes } = buildMotionRenderJobs(
        workflow,
        clip,
        { frames },
        get().promptTools.wildcardSets,
      );
      // Motion clips render frame-by-frame on the local bridge — give every
      // frame the same hardware-profile treatment as a single render (and keep
      // the worker's pipe cache key consistent with still renders). Non-bridge
      // backends are untouched.
      const motionSnapshot = backendSettings.selectedBackend === 'bridge' ? get().hardwareSnapshot() : null;
      const motionProfile = resolveEffectiveProfile(get().appSettings.hardwareProfile, motionSnapshot);
      const jobs = backendSettings.selectedBackend === 'bridge'
        ? rawJobs.map((j) => applyProfileToJob(j, motionProfile, motionSnapshot))
        : rawJobs;
      const adapter = activeAdapter(backendSettings);
      const result = await adapter.renderMotion(
        jobs,
        { fps: opts.fps, format: opts.format },
        onProgress,
      );
      // Frame-sequence export is an ARCHIVE (a ZIP of PNGs), not gallery media —
      // download it straight to disk and stop; it never enters the gallery.
      if (isArchiveResult(result)) {
        const slug = slugify(clip.name, 'frames');
        const b64 = result.dataUrl.slice(result.dataUrl.indexOf(',') + 1);
        downloadBase64(b64, `${slug}.frames.zip`, 'application/zip');
        set({
          controlStatus: `Exported ${frames} frame${frames === 1 ? '' : 's'} of "${clip.name}" → ${slug}.frames.zip`,
        });
        return { fallbackReason: null, archive: true };
      }
      // Reproducible motion manifest: base workflow + the animated clip fields.
      const durationSec = frameTimes.length > 0 ? frameTimes[frameTimes.length - 1] : clip.duration;
      const manifest = buildManifest(
        workflow,
        shelf,
        APP_VERSION,
        new Date(),
        get().promptTools.wildcardSets,
        { clipId: clip.id, clipName: clip.name, frames, fps: opts.fps, durationSec },
      );
      manifest.seed = typeof result.seed === 'number' ? result.seed : Number(result.seed) || 0;
      // buildManifest reads media from the base (image-mode) workflow, so it would
      // report this N-frame video as a still image. Correct it to the real video
      // metadata so the Gallery caption shows "N frames @ M fps".
      manifest.media = { type: 'video', format: result.extension, frameCount: frames, fps: opts.fps };
      const fallbackReason = result.fallback ? (result.fallbackReason ?? 'Backend returned a placeholder render.') : null;
      manifest.render = {
        selectedBackend: backendSettings.selectedBackend,
        actualBackend: result.fallback ? 'procedural' : backendSettings.selectedBackend,
        mode: result.fallback ? 'fallback' : backendSettings.selectedBackend === 'mock' ? 'mock' : 'real',
        fallback: Boolean(result.fallback),
        fallbackReason: fallbackReason ?? undefined,
        bridgeRenderer: backendSettings.bridgeRenderer,
      };
      const item: GalleryItem = {
        id: uid('render'),
        dataUrl: result.dataUrl,
        mediaType: result.mediaType as 'image' | 'video', // archive never reaches the gallery (downloaded earlier)
        mimeType: result.mimeType,
        extension: result.extension,
        createdAt: manifest.createdAt,
        manifest,
        selectedBackend: backendSettings.selectedBackend,
        actualBackend: result.fallback ? 'procedural' : backendSettings.selectedBackend,
        renderMode: result.fallback ? 'fallback' : backendSettings.selectedBackend === 'mock' ? 'mock' : 'real',
        fallback: Boolean(result.fallback),
        fallbackReason: fallbackReason ?? undefined,
        collectionId: null,
        tags: [`Motion: ${clip.name}`],
      };
      const nextGallery = await addRenderOp(galleryStore, get().gallery, item);
      set({
        gallery: nextGallery,
        controlStatus: fallbackReason
          ? `Rendered "${clip.name}" (placeholder): ${fallbackReason}`
          : `Rendered motion clip "${clip.name}" (${frames} frames) into the Gallery.`,
      });
      return { fallbackReason };
    },

    // ---- SVD "Animate this render" -----------------------------------------
    refreshSvdModels: async () => {
      try {
        const models = await activeAdapter(get().backendSettings).listSvdModels();
        set({ svdModels: models });
      } catch {
        set({ svdModels: [] });
      }
    },
    animateStill: async (galleryId, opts, onProgress) => {
      if (!opts.modelPath) return { ok: false, error: 'No SVD model — put a Stable Video Diffusion model in your models folder.' };
      const source = get().gallery.find((g) => g.id === galleryId);
      if (!source) return { ok: false, error: 'That render is no longer in the gallery.' };
      const comma = source.dataUrl.indexOf(',');
      const imageBase64 = comma >= 0 ? source.dataUrl.slice(comma + 1) : source.dataUrl;
      const { backendSettings } = get();
      try {
        const result = await activeAdapter(backendSettings).animateStill(imageBase64, { ...opts, jobId: uid('svd') }, onProgress);
        const createdAt = new Date().toISOString();
        const fallbackReason = result.fallback ? (result.fallbackReason ?? 'Backend returned a placeholder clip.') : undefined;
        const mode: 'fallback' | 'mock' | 'real' = result.fallback ? 'fallback' : backendSettings.selectedBackend === 'mock' ? 'mock' : 'real';
        const actualBackend = result.fallback ? 'procedural' : backendSettings.selectedBackend;
        // Carry lineage (prompt/graph/model) but DROP the source still's own render
        // provenance (turboForge/evolve/motion) so the SVD clip isn't mislabeled.
        const { turboForge: _tf, evolve: _ev, motion: _mo, ...baseManifest } =
          source.manifest as ExportManifest & { turboForge?: unknown; evolve?: unknown; motion?: unknown };
        void _tf; void _ev; void _mo;
        const manifest = {
          ...baseManifest,
          createdAt,
          seed: typeof result.seed === 'number' ? result.seed : Number(result.seed) || 0,
          media: { type: 'video' as const, format: result.extension, frameCount: opts.frames, fps: opts.fps },
          svdSource: galleryId,
          render: {
            selectedBackend: backendSettings.selectedBackend,
            actualBackend,
            mode,
            fallback: Boolean(result.fallback),
            fallbackReason,
            bridgeRenderer: backendSettings.bridgeRenderer,
          },
        };
        const item: GalleryItem = {
          id: uid('render'),
          dataUrl: result.dataUrl,
          mediaType: 'video',
          mimeType: result.mimeType,
          extension: result.extension,
          createdAt,
          manifest,
          selectedBackend: backendSettings.selectedBackend,
          actualBackend,
          renderMode: mode,
          fallback: Boolean(result.fallback),
          fallbackReason,
          collectionId: null,
          tags: ['SVD animate'],
        };
        const nextGallery = await addRenderOp(galleryStore, get().gallery, item);
        set({ gallery: nextGallery });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    // ---- Auto-Evolve --------------------------------------------------------
    setEvolveConfig: (patch) => {
      const ev = get().evolve;
      const weights = patch.weights
        ? {
            clip: patch.weights.clip != null ? evClamp01(patch.weights.clip) : ev.weights.clip,
            aesthetic: patch.weights.aesthetic != null ? evClamp01(patch.weights.aesthetic) : ev.weights.aesthetic,
          }
        : ev.weights;
      setEvolve({
        mode: patch.mode ?? ev.mode,
        population: patch.population != null ? evClampInt(patch.population, EVOLVE_POP_MIN, EVOLVE_POP_MAX) : ev.population,
        generations: patch.generations != null ? evClampInt(patch.generations, EVOLVE_GEN_MIN, EVOLVE_GEN_MAX) : ev.generations,
        weights,
      });
    },

    runEvolve: async () => {
      const ev = get().evolve;
      if (ev.running) return;
      if (!evolveNodeId()) { setEvolve({ error: 'Add a Sampler capsule to evolve its render params.' }); return; }
      const knobs = evolveKnobs();
      const population = evClampInt(ev.population, EVOLVE_POP_MIN, EVOLVE_POP_MAX);
      const generations = evClampInt(ev.generations, EVOLVE_GEN_MIN, EVOLVE_GEN_MAX);
      // Deterministic per-run rng seeded from the prompt (spec: never Math.random
      // in the search path). Same prompt => same starting population.
      const rng = mulberry32(seedFromString(evolvePromptText() || 'lumendeck-evolve'));
      setEvolve({
        running: true, error: null, status: 'Rendering generation 1…',
        generationsData: [], best: null, selectedParents: [], awaitingParents: false,
        progress: 0, population, generations, clipAvailable: true, fallbackReason: null,
      });
      try {
        let genomes = Array.from({ length: population }, () => randomGenome(knobs, rng));
        const first = await runEvolveGeneration(genomes, 0);
        if (!first) { setEvolve({ running: false }); return; }
        if (get().evolve.mode === 'interactive') {
          setEvolve({ running: false, awaitingParents: generations > 1, status: generations > 1 ? 'Pick parent(s), then breed the next generation.' : 'Single-generation run complete. Adopt the best.' });
          return;
        }
        for (let gen = 1; gen < generations; gen++) {
          setEvolve({ status: `Rendering generation ${gen + 1}…`, progress: 0 });
          const prev = get().evolve.generationsData[gen - 1]?.candidates ?? [];
          const elite = selectTopK(prev, Math.max(1, Math.ceil(population / 2)));
          genomes = breedGenomes(elite, knobs, population, rng);
          const bred = await runEvolveGeneration(genomes, gen);
          if (!bred) break;
        }
        const best = get().evolve.best;
        setEvolve({ running: false, status: best ? `Evolve complete — best score ${best.score.toFixed(3)}. Adopt it or run again.` : 'Evolve complete.' });
      } catch (err) {
        setEvolve({ running: false, error: err instanceof Error ? err.message : String(err) });
      }
    },

    pickEvolveParent: (genomeIndex) => {
      const sel = get().evolve.selectedParents;
      const next = sel.includes(genomeIndex) ? sel.filter((i) => i !== genomeIndex) : [...sel, genomeIndex];
      setEvolve({ selectedParents: next });
    },

    evolveNextGeneration: async () => {
      const ev = get().evolve;
      if (ev.running || !ev.awaitingParents) return;
      const lastGen = ev.generationsData[ev.generationsData.length - 1];
      if (!lastGen) return;
      if (ev.generationsData.length >= ev.generations) {
        setEvolve({ awaitingParents: false, status: 'Reached the generation limit. Adopt the best or clear.' });
        return;
      }
      const knobs = evolveKnobs();
      const rng = mulberry32(seedFromString(`${evolvePromptText()}:${ev.generationsData.length}`));
      // Parents = the user's picks, else the top half of the last generation.
      const parents = ev.selectedParents.length > 0
        ? lastGen.candidates.filter((c) => ev.selectedParents.includes(c.genomeIndex))
        : selectTopK(lastGen.candidates, Math.max(1, Math.ceil(ev.population / 2)));
      const genIndex = ev.generationsData.length;
      setEvolve({ running: true, awaitingParents: false, error: null, status: `Breeding generation ${genIndex + 1}…`, progress: 0 });
      try {
        const genomes = breedGenomes(parents, knobs, ev.population, rng);
        const bred = await runEvolveGeneration(genomes, genIndex);
        if (!bred) { setEvolve({ running: false }); return; }
        const done = get().evolve.generationsData.length >= get().evolve.generations;
        setEvolve({
          running: false, selectedParents: [], awaitingParents: !done,
          status: done ? 'Reached the generation limit. Adopt the best or clear.' : 'Pick parent(s) for the next generation.',
        });
      } catch (err) {
        setEvolve({ running: false, error: err instanceof Error ? err.message : String(err) });
      }
    },

    adoptBest: async () => {
      const ev = get().evolve;
      const best = ev.best;
      const nodes = evolveNodes();
      if (!best) { setEvolve({ error: 'Run an evolve first, then adopt the best candidate.' }); return; }
      if (!nodes) { setEvolve({ error: 'No Sampler capsule to adopt the evolved params into.' }); return; }
      const knobs = evolveKnobs();
      // Write the winning genome's params into the workflow in ONE commit (undo-safe).
      let next = get().workflow;
      for (const p of genomeToPatches(best.genome, knobs, nodes)) next = updateNodeParam(next, p.nodeId, p.param, p.value);
      commit(next);
      // Land the winning image in the durable Gallery with an evolve manifest.
      const { shelf, backendSettings } = get();
      const manifest = buildManifest(
        next, shelf, APP_VERSION, new Date(), get().promptTools.wildcardSets, undefined,
        { generations: ev.generations, population: ev.population, weights: ev.weights, score: best.score },
      );
      const seedIdx = knobs.findIndex((k) => k.param === 'seed');
      if (seedIdx >= 0 && best.genome[seedIdx] != null) manifest.seed = Math.round(best.genome[seedIdx]);
      const isMock = backendSettings.selectedBackend === 'mock';
      const mockReason = 'Adopted a procedural Mock candidate (no real CLIP/aesthetic objective).';
      manifest.render = {
        selectedBackend: backendSettings.selectedBackend,
        actualBackend: backendSettings.selectedBackend,
        mode: isMock ? 'mock' : 'real',
        fallback: isMock,
        fallbackReason: isMock ? mockReason : undefined,
        bridgeRenderer: backendSettings.bridgeRenderer,
      };
      const item: GalleryItem = {
        id: uid('render'),
        dataUrl: best.dataUrl,
        mediaType: 'image',
        mimeType: 'image/png',
        extension: 'png',
        createdAt: manifest.createdAt,
        manifest,
        selectedBackend: backendSettings.selectedBackend,
        actualBackend: backendSettings.selectedBackend,
        renderMode: isMock ? 'mock' : 'real',
        fallback: isMock,
        fallbackReason: isMock ? mockReason : undefined,
        collectionId: null,
        tags: ['Evolve'],
      };
      const nextGallery = await addRenderOp(galleryStore, get().gallery, item);
      set({
        gallery: nextGallery,
        controlStatus: `Adopted the best evolve candidate (score ${best.score.toFixed(3)}) into the workflow + Gallery.`,
      });
      setEvolve({ status: `Adopted best (score ${best.score.toFixed(3)}) — params written + image saved to the Gallery.` });
    },

    clearEvolve: () => setEvolve({
      running: false, generationsData: [], best: null, selectedParents: [], awaitingParents: false,
      status: null, error: null, progress: 0, clipAvailable: true, fallbackReason: null,
    }),

    // ---- Render-Space Ghost Controller ----
    fieldProfileFor: (nodeId) => profileForNode(nodeId),

    spawnGhost: (nodeId) => {
      // One ghost per node; never spawn onto a node with no drivable params.
      if (get().field.ghosts.some((g) => g.nodeId === nodeId)) return;
      if (!profileHasAxes(profileForNode(nodeId))) return;
      const ghost: Ghost = {
        id: uid('ghost'),
        nodeId,
        // Start centered (midpoint) at full intensity so it parks on the node's
        // current "middle" without lurching the params on spawn.
        pos: { x: 0.5, y: 0.5, z: 0.5 },
        intensity: 1,
        pinned: false,
        recording: false,
      };
      setField({ ...get().field, ghosts: [...get().field.ghosts, ghost] });
    },

    moveGhost: (id, pos) => {
      const ghost = findGhost(id);
      if (!ghost) return;
      const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
      const next: Ghost = { ...ghost, pos: { x: clamp01(pos.x), y: clamp01(pos.y), z: clamp01(pos.z) } };
      editGhost(id, () => next);
      // Write the node's params via applyField in ONE commit (gradient + ring re-tint).
      applyGhostToWorkflow(next);
    },

    setGhostIntensity: (id, v) => {
      const ghost = findGhost(id);
      if (!ghost) return;
      const intensity = v < 0 ? 0 : v > 1 ? 1 : v;
      const next: Ghost = { ...ghost, intensity };
      editGhost(id, () => next);
      // Intensity scales displacement from the midpoint, so re-apply so params re-tint.
      applyGhostToWorkflow(next);
    },

    pinGhost: (id) => editGhost(id, (g) => ({ ...g, pinned: !g.pinned })),

    collapseGhost: (id) => {
      // A recording in progress must be torn down cleanly (no orphaned timer).
      const rec = ghostRecordings.get(id);
      if (rec) {
        clearInterval(rec.timer);
        ghostRecordings.delete(id);
      }
      // Params stay where the ghost left them — only the ghost is removed.
      setField({ ...get().field, ghosts: get().field.ghosts.filter((g) => g.id !== id) });
    },

    saveAnchor: (id, name) => {
      const ghost = findGhost(id);
      if (!ghost) return;
      const values = applyField(ghost.pos, ghost.intensity, profileForNode(ghost.nodeId), ghost.nodeId);
      const anchor: Anchor = {
        id: uid('anchor'),
        nodeId: ghost.nodeId,
        name: name && name.trim() ? name.trim() : 'Anchor',
        pos: { ...ghost.pos },
        values,
      };
      setField({ ...get().field, anchors: [...get().field.anchors, anchor] });
      set({ controlStatus: `Saved anchor "${anchor.name}".` });
    },

    restoreAnchor: (anchorId) => {
      const anchor = get().field.anchors.find((a) => a.id === anchorId);
      if (!anchor) return;
      // Move the node's ghost (if any) back to the anchor position, then write the
      // saved param values in ONE commit so restore is exact + undo-safe.
      const ghost = get().field.ghosts.find((g) => g.nodeId === anchor.nodeId);
      if (ghost) editGhost(ghost.id, (g) => ({ ...g, pos: { ...anchor.pos } }));
      if (anchor.values.length > 0) {
        let next = get().workflow;
        for (const v of anchor.values) next = updateNodeParam(next, v.nodeId, v.param, v.value);
        commit(next);
      }
      set({ controlStatus: `Restored anchor "${anchor.name}".` });
    },

    deleteAnchor: (id) =>
      setField({ ...get().field, anchors: get().field.anchors.filter((a) => a.id !== id) }),

    startGhostRecording: (id) => {
      const ghost = findGhost(id);
      if (!ghost) return;
      // Idempotent: a second start on an already-recording ghost is a no-op.
      if (ghostRecordings.has(id)) return;
      const startedAt = wallNow();
      // Seed with the current position at t=0 so a clip always has an opening frame.
      const samples: PathSample[] = [{ t: 0, pos: { ...ghost.pos } }];
      const timer = setInterval(() => {
        const g = findGhost(id);
        const rec = ghostRecordings.get(id);
        if (!g || !rec) return;
        // Wall-clock time: sample WHERE the ghost is NOW at REAL elapsed seconds,
        // independent of how many timer ticks fired (starvation-safe).
        rec.samples.push({ t: (wallNow() - rec.startedAt) / 1000, pos: { ...g.pos } });
      }, GHOST_RECORD_INTERVAL_MS);
      ghostRecordings.set(id, { samples, timer, startedAt });
      editGhost(id, (g) => ({ ...g, recording: true }));
    },

    stopGhostRecording: (id) => {
      const rec = ghostRecordings.get(id);
      const ghost = findGhost(id);
      if (rec) {
        clearInterval(rec.timer);
        ghostRecordings.delete(id);
      }
      if (ghost) editGhost(id, (g) => ({ ...g, recording: false }));
      if (!rec || !ghost) return;
      // Capture a final sample at the true stop time so the last drag position lands.
      const samples = [...rec.samples, { t: (wallNow() - rec.startedAt) / 1000, pos: { ...ghost.pos } }];
      const clip = pathToClip(samples, profileForNode(ghost.nodeId), ghost.nodeId);
      if (clip.tracks.length === 0) {
        set({ controlStatus: 'Ghost recording produced no drivable tracks.' });
        return;
      }
      // Land the recorded clip in the motion slice + make it active (plays via
      // Phase 1, renders via Phase 2 unchanged — spatial performance -> animation).
      setMotion({ clips: [...get().motion.clips, clip], activeClipId: clip.id });
      set({ controlStatus: `Recorded ghost path into "${clip.name}" (${samples.length} samples).` });
    },

    cancelAllGhostRecordings: () => {
      // Called when the 3D view unmounts (view switch / 2D-3D toggle): stop the
      // module-level sampler timers so they don't run headless forever, and clear
      // the transient recording flags. Discards in-progress paths (no clip) — you
      // left the view, so nothing is finalized.
      if (ghostRecordings.size === 0) return;
      for (const [, r] of ghostRecordings) clearInterval(r.timer);
      ghostRecordings.clear();
      setField({
        ...get().field,
        ghosts: get().field.ghosts.map((g) => (g.recording ? { ...g, recording: false } : g)),
      });
    },

    // ---- Field Presets + Streaming Preview ----
    setActiveFieldPreset: (id) => {
      // Ignore an id that doesn't resolve; null always clears back to the auto field.
      if (id !== null && !get().field.presets.some((p) => p.id === id)) return;
      setField({ ...get().field, activePresetId: id });
    },

    saveFieldPreset: (name, axes) => {
      const id = uid('fpreset');
      const preset: FieldPreset = {
        id,
        name: name && name.trim() ? name.trim() : 'Custom preset',
        description: 'Custom field preset.',
        builtin: false,
        axes: { x: cloneBundle(axes.x), y: cloneBundle(axes.y), z: cloneBundle(axes.z) },
      };
      setField({ ...get().field, presets: [...get().field.presets, preset] });
      return id;
    },

    updateFieldPresetAxis: (id, axis, bundle) => {
      setField({
        ...get().field,
        presets: get().field.presets.map((p) =>
          p.id === id ? { ...p, axes: { ...p.axes, [axis]: cloneBundle(bundle) } } : p,
        ),
      });
    },

    deleteFieldPreset: (id) => {
      // Builtins HIDE (removed from the runtime list; persistence records the id as
      // hidden). Customs are gone for good. Clear the active id if it was deleted.
      const presets = get().field.presets.filter((p) => p.id !== id);
      const activePresetId = get().field.activePresetId === id ? null : get().field.activePresetId;
      setField({ ...get().field, presets, activePresetId });
    },

    setStreamingEnabled: (on) => setField({ ...get().field, streamingEnabled: !!on }),

    runFieldPreview: async (pos) => {
      const preset = activeFieldPreset();
      if (!preset) {
        set({ controlStatus: 'Pick a field preset before starting a live preview.' });
        return;
      }
      if (get().backendSettings.selectedBackend === 'cloud') {
        // Streaming previews render one frame per pointer move — on the Cloud
        // backend every frame would spend PAID provider credits. Refuse loudly.
        set({
          controlStatus:
            'Live field previews are disabled on the Cloud backend — each frame would spend paid API credits. Switch to the local bridge for streaming previews.',
        });
        return;
      }
      // Bump + capture the supersede token: only the latest call may write the image.
      const token = ++fieldPreviewToken;
      setField({ ...get().field, previewPending: true });
      try {
        const patches = applyPresetAxes(preset, pos, 1);
        const job = buildPreviewJob(get().workflow, patches, {
          size: 320,
          steps: 4,
          wildcardSets: get().promptTools.wildcardSets,
        });
        const adapter = activeAdapter(get().backendSettings);
        const result = await adapter.generate(job);
        // A newer position superseded this one: drop the stale result (the render
        // may have finished, but the latest position must win the preview).
        if (token !== fieldPreviewToken) return;
        setField({ ...get().field, previewImage: result.dataUrl, previewPending: false });
      } catch (err) {
        // Only the latest in-flight call clears pending + posts the loud error, so a
        // superseded failure never overwrites a newer render's state.
        if (token !== fieldPreviewToken) return;
        setField({ ...get().field, previewPending: false });
        set({
          controlStatus: `Live preview needs the bridge — ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },

    promoteFieldPreviewToRender: async () => {
      const preset = activeFieldPreset();
      if (!preset) {
        set({ controlStatus: 'Pick a field preset before promoting a preview to a full render.' });
        return;
      }
      // Render the ACTIVE GHOST's real position — NOT a streaming midpoint. With
      // streaming off, `lastFieldPreviewPos` was never set past its {0.5} default,
      // so promoting it committed the field MIDPOINT over the ghost's real params.
      const ghost = get().field.ghosts[0];
      if (!ghost) {
        set({ controlStatus: 'Move a ghost into the field first to promote its position to a full render.' });
        return;
      }
      // Resolve the preset at the ghost's position + intensity, fan the rack
      // aggregates into their enabled slots, apply the rest directly, then run the
      // normal full-res gallery render (identical to the Render button path).
      const patches = applyPresetAxes(preset, ghost.pos, ghost.intensity);
      let next = fanOutRackPatches(get().workflow, patches);
      for (const p of patches) {
        if (isRackAggregatePatch(p)) continue;
        const node = findNode(next, p.node);
        if (node) next = updateNodeParam(next, node.id, p.param, p.value);
      }
      commit(next);
      await get().enqueueRender();
    },

    // ---- Audio Reactivity ----
    startAudio: async (source) => {
      // Audio and motion playback must NEVER both drive orbs — pause playback first.
      if (get().transport.playing) get().transport.pause();
      const kind: AudioSourceKind = 'mic' in source ? 'mic' : 'tone' in source ? 'tone' : 'file';
      try {
        await audioEngine.start(source);
        set({
          audio: { ...get().audio, running: true, source: kind },
          controlStatus: `Audio reactive: listening (${kind}).`,
        });
      } catch (err) {
        // Loud status, engine stays stopped, orbs never react to a fake signal.
        audioEngine.stop();
        set({
          audio: { ...get().audio, running: false, source: null },
          controlStatus: `Audio error — ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },

    stopAudio: () => {
      // Cancel any in-progress bake sampler + release the engine (mic tracks +
      // AudioContext) so nothing leaks; orbs settle back on the next idle flush.
      stopAudioBake();
      audioEngine.stop();
      set({ audio: { ...get().audio, running: false, source: null } });
    },

    setAudioMapping: (mapping) => set({ audio: { ...get().audio, mapping } }),

    setAudioSensitivity: (v) => {
      const sensitivity = v < SENSITIVITY_MIN ? SENSITIVITY_MIN : v > SENSITIVITY_MAX ? SENSITIVITY_MAX : v;
      set({ audio: { ...get().audio, sensitivity } });
    },

    bakeAudioClip: (seconds) => {
      if (!get().audio.running) {
        set({ controlStatus: 'Start audio before baking a reactive clip.' });
        return;
      }
      if (audioBake) return; // a bake is already running — ignore a re-trigger
      const nodeId = primaryAudioNodeId(get().audio.mapping, get().workflow);
      const windowMs = Math.max(0.1, seconds) * 1000;
      const startedAt = wallNow();
      // Seed a t=0 sample so a clip always has an opening frame.
      const seed: AudioSample = { t: 0, bands: scaleBands(computeBands(audioEngine.read()), get().audio.sensitivity) };
      const samples: AudioSample[] = [seed];
      const timer = setInterval(() => {
        const rec = audioBake;
        if (!rec) return;
        // Wall-clock elapsed (starvation-safe): sample bands NOW at REAL seconds.
        const elapsed = wallNow() - rec.startedAt;
        const bands = scaleBands(computeBands(audioEngine.read()), get().audio.sensitivity);
        rec.samples.push({ t: elapsed / 1000, bands });
        if (elapsed >= windowMs) {
          clearInterval(rec.timer);
          audioBake = null;
          const clip = audioToClip(rec.samples, get().audio.mapping, nodeId);
          if (clip.tracks.length === 0) {
            set({ controlStatus: 'Audio bake produced no tracks (map a band to this node first).' });
            return;
          }
          // Land the capture in the motion slice + make it active (plays via
          // Phase 1, renders via Phase 2 unchanged).
          setMotion({ clips: [...get().motion.clips, clip], activeClipId: clip.id });
          set({ controlStatus: `Baked ${seconds}s of audio into "${clip.name}" (${rec.samples.length} samples).` });
        }
      }, AUDIO_BAKE_INTERVAL_MS);
      audioBake = { samples, timer, startedAt };
      set({ controlStatus: `Baking ${seconds}s of audio…` });
    },

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
        appSettings: sanitizeAppSettings({ ...get().appSettings, preferredBackend: backendSettings.selectedBackend }),
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
      // bridgeOnline mirrors `ok` except where a branch distinguishes "backend
      // configured" from "bridge reachable" (the cloud branch sets this).
      let bridgeReachable: boolean | null = null;
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
      } else if (state.backendSettings.selectedBackend === 'cloud') {
        cloudAdapter.setBaseUrl(state.backendSettings.bridgeUrl);
        const reachable = await cloudAdapter.ping();
        // The bridge itself is online whenever it answered — a missing provider
        // key must NOT flip bridgeOnline (other UI reads it for bridge features).
        bridgeReachable = reachable;
        if (!reachable) {
          ok = false;
          status = 'unavailable';
          message = 'Local bridge is offline — the Cloud backend calls providers through it.';
        } else {
          try {
            const providers = await cloudAdapter.listProviders();
            const chosen = providers.find((p) => p.id === state.backendSettings.cloudProvider);
            const hasModel = Boolean(state.backendSettings.cloudModel);
            ok = Boolean(chosen?.hasKey) && hasModel;
            status = ok ? 'healthy' : 'degraded';
            message = !chosen
              ? 'Pick a cloud provider and save its API key.'
              : !chosen.hasKey
                ? `No API key saved for ${chosen.label}. Add one in the Cloud section below.`
                : !hasModel
                  ? `Pick a model for ${chosen.label} before rendering.`
                  : `${chosen.label} is configured and ready.`;
          } catch (exc) {
            ok = false;
            status = 'degraded';
            message = `Bridge is reachable but /cloud/providers failed: ${exc instanceof Error ? exc.message : String(exc)}`;
          }
        }
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
      set({ backendSettings, bridgeOnline: bridgeReachable ?? ok });
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
        // Benchmarks measure the REAL render path — include the hardware-profile
        // treatment when (and only when) benchmarking the local bridge.
        const benchSnapshot = state.backendSettings.selectedBackend === 'bridge' ? get().hardwareSnapshot() : null;
        const benchBase = buildRenderJob(state.workflow, state.promptTools.wildcardSets);
        const job = state.backendSettings.selectedBackend === 'bridge'
          ? applyProfileToJob(
              benchBase,
              resolveEffectiveProfile(state.appSettings.hardwareProfile, benchSnapshot),
              benchSnapshot,
            )
          : benchBase;
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
          set({ shelf, shelfSource: 'bridge', workflow, health: computeHealth(workflow, shelf, get().appSettings, get().bridgeModelStatus) });
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
          health: computeHealth(workflow, shelf, get().appSettings, get().bridgeModelStatus),
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
        // The snapshot can flip auto's effective profile (and the VRAM budget), so
        // health must be recomputed the moment the new status lands.
        set({
          bridgeModelStatus,
          bridgeModelError: null,
          health: computeHealth(get().workflow, get().shelf, get().appSettings, bridgeModelStatus),
        });
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
      if (get().queuePaused) {
        set({ controlStatus: 'Queue is paused. Resume the queue before starting a render.' });
        return;
      }
      const { workflow, shelf, backendSettings } = get();
      const errors = get().health.filter((i) => i.severity === 'error');
      if (errors.length > 0) return; // UI blocks this path; guard anyway.

      // Apply the active hardware profile ONLY when the job renders on the LOCAL
      // bridge: mock is procedural, cloud runs on datacenter GPUs, and ComfyUI
      // manages its own VRAM — a local 4GB profile must never clamp those jobs
      // (or leak its directive into their payloads). On the bridge, constrained
      // profiles (GTX 1650 4GB / CPU) clamp resolution aspect-preserving, disable
      // hires, and attach the low-VRAM directive the worker honors; unconstrained
      // profiles leave the job unchanged.
      const isLocalBridgeJob = backendSettings.selectedBackend === 'bridge';
      const baseJob = buildRenderJob(workflow, get().promptTools.wildcardSets);
      const snapshot = isLocalBridgeJob ? get().hardwareSnapshot() : null;
      const job = isLocalBridgeJob
        ? applyProfileToJob(
            baseJob,
            resolveEffectiveProfile(get().appSettings.hardwareProfile, snapshot),
            snapshot,
          )
        : baseJob;
      // Each render owns its hardware event — a stale OOM/retry report from the
      // previous render must never survive into this one's diagnostics.
      set({ hardwareEvent: { oomCategory: 'none', fallbackOccurred: false, safeRetryUsed: false } });
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

      let oomCategory: 'cuda_oom' | 'other' | 'none' = 'none';
      let safeRetryUsed = false;
      const retryWarning = 'GPU ran out of memory — retried once with safe 4GB settings (512×512, CPU offload).';
      try {
        const profiler = new TurboProfiler();
        profiler.mark('total-start');
        const adapter = activeAdapter(backendSettings);
        profiler.mark('sampling-start');
        profiler.mark('backend-start');
        let result;
        let usedFallback = false;
        let fallbackReason = '';
        // The dimensions/settings that ACTUALLY rendered (profile clamp already in
        // `job`; a safe retry swaps this to the 512x512 retry job) — the manifest
        // must describe this, not the workflow's requested canvas.
        let executedJob = job;
        const onProgress = (update: Parameters<RenderProgressCallback>[0]) => {
          const progress = normalizeProgress(update);
          patch({ progress: progress.progress, phase: progress.phase, previewDataUrl: progress.previewDataUrl });
        };
        try {
          result = await adapter.generate(job, onProgress);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // bridgeRenderer='diffusers' surfaces a CUDA OOM as a thrown 503 instead
          // of a fallback result — give those users the same single safe retry
          // BEFORE any mock substitution.
          const thrownRetry = isLocalBridgeJob && classifyBackendError(message) === 'cuda_oom'
            ? planSafeRetry(job, 0, 'cuda_oom')
            : null;
          if (thrownRetry) {
            oomCategory = 'cuda_oom';
            safeRetryUsed = true; // set BEFORE the await: a retry that throws still ran
            patch({ phase: 'retrying', warning: retryWarning });
            try {
              result = await adapter.generate(thrownRetry, onProgress);
              executedJob = thrownRetry;
            } catch {
              // retry failed too — fall through to the mock fallback / rethrow below
            }
          }
          if (!result) {
            if (!backendSettings.fallbackToMock || backendSettings.selectedBackend === 'mock') throw error;
            usedFallback = true;
            fallbackReason = `${message} Falling back to mock backend.`;
            patch({ error: fallbackReason, fallback: true, fallbackReason });
            result = await mockAdapter.generate(job, onProgress);
          }
        }
        // Classify a fallback result's reason (the worker's own errorCategory wins
        // when the bridge forwarded one; otherwise precise OOM signatures).
        if (!usedFallback && result.fallback && oomCategory === 'none') {
          oomCategory = classifyBackendError(result.fallbackReason, result.fallbackCategory);
        }
        // One-time safe retry (LOCAL bridge only): when a real GPU render exhausts
        // VRAM the bridge returns a procedural placeholder with the OOM reason.
        // Retry EXACTLY once with conservative 4GB settings (512x512, hires off,
        // aggressive offload). This never persists settings — it is a transient
        // job override. attempt is fixed at 0, so planSafeRetry cannot loop.
        if (!usedFallback && !safeRetryUsed && result.fallback && oomCategory === 'cuda_oom' && isLocalBridgeJob) {
          const retryJob = planSafeRetry(job, 0, 'cuda_oom');
          if (retryJob) {
            safeRetryUsed = true; // BEFORE the await: a retry that throws still ran
            patch({ phase: 'retrying', warning: retryWarning });
            try {
              const retryResult = await adapter.generate(retryJob, onProgress);
              // Keep the retry only if it actually rendered (didn't OOM again).
              if (!retryResult.fallback) {
                result = retryResult;
                executedJob = retryJob;
              }
            } catch {
              // Retry failed too — keep the original procedural placeholder below.
            }
          }
        }
        set({
          hardwareEvent: { oomCategory, fallbackOccurred: Boolean(result.fallback) || usedFallback, safeRetryUsed },
        });
        // Bridge produced a procedural placeholder when a real render was expected —
        // surface it loudly instead of pretending the render succeeded.
        if (result.fallback) {
          fallbackReason = `Real render failed - showing procedural placeholder. ${result.fallbackReason ?? ''}`.trim();
          patch({ error: fallbackReason, fallback: true, fallbackReason, actualBackend: 'procedural' });
        }
        // Some/all requested ControlNets were unsupported for the loaded model
        // family — the render still succeeded, but say so loudly (never silent).
        const droppedControls = result.droppedControls ?? [];
        const droppedMessage = droppedControls.length > 0
          ? `Skipped controls: ${droppedControls.map((d) => `${d.type} (${d.reason})`).join(', ')}`
          : '';
        if (droppedMessage) patch({ warning: droppedMessage });
        const fallback = usedFallback || Boolean(result.fallback);
        const actualBackend = usedFallback ? 'mock' : result.fallback ? 'procedural' : backendSettings.selectedBackend;
        const renderMode = fallback
          ? 'fallback'
          : backendSettings.selectedBackend === 'mock'
            ? 'mock'
            : backendSettings.selectedBackend === 'bridge' && backendSettings.bridgeRenderer === 'procedural'
              ? 'procedural'
              : 'real';
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
        const baseManifest = buildManifest(workflow, shelf, APP_VERSION, new Date(), get().promptTools.wildcardSets);
        baseManifest.seed = result.seed;
        // Record this render in prompt history (original + resolved prompt, actual seed, model).
        get().recordHistory({
          id: uid('hist'),
          positive: String(findNode(workflow, 'prompt')?.params.positive ?? job.prompt),
          negative: job.negativePrompt,
          resolved: job.resolvedPrompt,
          seed: result.seed,
          modelId: job.modelId ?? undefined,
          at: baseManifest.createdAt,
          favorite: false,
        });
        const matrix = buildCapabilityMatrix(shelf);
        const modelCapability = findCapability(matrix, plan.selectedModel);
        const benchmark: BenchmarkResult = {
          id: `bench_${queueJob.id}`,
          createdAt: baseManifest.createdAt,
          presetId: plan.selectedPreset,
          backendId: plan.selectedBackend,
          backendName: fallback ? `${actualBackend} fallback` : TURBO_BACKENDS[plan.selectedBackend].displayName,
          hardware: collectBrowserHardwareInfo(fallback ? `${actualBackend} fallback` : TURBO_BACKENDS[plan.selectedBackend].displayName),
          runtime: {
            backendName: fallback ? `${actualBackend} fallback` : TURBO_BACKENDS[plan.selectedBackend].displayName,
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
          backendHealthStatus: fallback ? 'degraded' : 'healthy',
          optimizationFlags: plan.optimizationFlags,
          compileCacheStatus: plan.compileCacheStatus,
          modelCapability,
          loraStack: plan.selectedLoras,
          renderPlan: plan,
          benchmark: enrichedBenchmark,
          warnings: fallback
            ? [
                ...plan.warnings,
                {
                  code: 'backend-fallback',
                  severity: 'warning',
                  message: fallbackReason || 'The selected backend returned a fallback render.',
                  recommendedFix: actualBackend === 'procedural'
                    ? 'Install the Diffusers runtime/model or change the bridge renderer to diffusers after setup.'
                    : 'Start ComfyUI, check the backend URL, or switch to Mock for demos.',
                },
              ]
            : plan.warnings,
          hardwareInfo: enrichedBenchmark.hardware,
          graphSnapshot: workflow,
          appVersion: APP_VERSION,
        };
        const manifest = withTurboForgeManifest(baseManifest, turboForge);
        manifest.render = {
          selectedBackend: backendSettings.selectedBackend,
          actualBackend,
          mode: renderMode,
          fallback,
          fallbackReason: fallback ? fallbackReason || result.fallbackReason : undefined,
          bridgeRenderer: backendSettings.bridgeRenderer,
          // Provider provenance only when the provider actually made the image —
          // a fallback render never touched the cloud.
          ...(backendSettings.selectedBackend === 'cloud' && !fallback
            ? { cloudProvider: backendSettings.cloudProvider, cloudModel: backendSettings.cloudModel }
            : {}),
          // Honesty: what actually rendered can differ from the workflow canvas
          // (hardware-profile clamp, or the 512x512 safe retry) — record it.
          ...(manifest.canvas.width !== executedJob.width || manifest.canvas.height !== executedJob.height
            ? { actualWidth: executedJob.width, actualHeight: executedJob.height }
            : {}),
          ...(safeRetryUsed ? { safeRetryUsed: true } : {}),
        };
        if (result.mediaType === 'video' && manifest.media.type !== 'video') {
          // A provider returned a video for an image-mode workflow (e.g. a Cloud
          // video model): correct the media record so the Gallery caption is honest.
          manifest.media = { type: 'video', format: result.extension, frameCount: Math.max(1, job.frameCount), fps: job.fps || 0 };
        }
        const item: GalleryItem = {
          id: uid('render'),
          dataUrl: result.dataUrl,
          mediaType: result.mediaType as 'image' | 'video', // archive never reaches the gallery (downloaded earlier)
          mimeType: result.mimeType,
          extension: result.extension,
          createdAt: manifest.createdAt,
          manifest,
          selectedBackend: backendSettings.selectedBackend,
          actualBackend,
          renderMode,
          fallback,
          fallbackReason: fallback ? fallbackReason || result.fallbackReason : undefined,
          collectionId: null,
          tags: [],
        };
        // Route the gallery insert through the durable (IDB-backed) write-through.
        const nextGallery = await addRenderOp(galleryStore, get().gallery, item);
        set({
          gallery: nextGallery,
          turboBenchmarks: saveBenchmark(enrichedBenchmark),
          turboLastBenchmark: enrichedBenchmark,
        });
        patch({
          status: fallback || droppedMessage || safeRetryUsed ? 'done_with_warning' : 'done',
          progress: 1,
          phase: fallback || droppedMessage || safeRetryUsed ? 'done with warning' : 'done',
          previewDataUrl: result.dataUrl,
          fallback,
          fallbackReason: fallback ? fallbackReason || result.fallbackReason : undefined,
          // A successful safe retry shrank the render — that must stay visible.
          warning: droppedMessage || (safeRetryUsed ? retryWarning : undefined),
          actualBackend,
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        // A thrown render must still stamp this render's hardware event (a stale
        // OOM report from the previous render would mislead diagnostics).
        set({ hardwareEvent: { oomCategory: classifyBackendError(errorMessage), fallbackOccurred: false, safeRetryUsed } });
        patch({ status: 'error', error: errorMessage });
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

    pauseQueue: () => set({ queuePaused: true, controlStatus: 'Queue paused. Running backend requests are not interrupted yet.' }),
    resumeQueue: () => set({ queuePaused: false, controlStatus: 'Queue resumed.' }),
    cancelRunningJobs: () => set({
      queue: get().queue.map((job) => job.status === 'running'
        ? { ...job, status: 'error', error: 'Cancelled locally. Backend cancellation is not connected yet.', phase: 'cancelled' }
        : job),
      controlStatus: 'Running jobs were marked cancelled locally. Native/backend cancellation is not connected yet.',
    }),
    clearQueue: () => set({ queue: [], controlStatus: 'Queue cleared.' }),
    clearLocalHistory: () => {
      clearBenchmarks();
      // Purge the durable gallery too so "clear" is honest (write-through).
      const current = get().gallery;
      void Promise.all(current.map((g) => galleryStore.deleteRender(g.id))).catch(() => {});
      set({
        gallery: [],
        turboBenchmarks: [],
        turboLastBenchmark: null,
        queue: [],
        controlStatus: 'Local gallery, queue, and benchmark history cleared.',
      });
    },
    setControlStatus: (message) => set({ controlStatus: message }),

    removeGalleryItem: (id) => {
      void removeRenderOp(galleryStore, get().gallery, id).then((gallery) => set({ gallery }));
    },

    hydrateGallery: async () => {
      // One-time lossless migration: if IDB has no renders but a legacy
      // localStorage gallery exists, copy it in, THEN clear the legacy blob.
      try {
        const legacy = takeLegacyGallery();
        const result = await migrateLegacyGallery(galleryStore, legacy);
        if (result.didMigrate) clearLegacyGallery();
      } catch (err) {
        console.warn('LumenDeck: gallery migration failed (continuing).', err);
      }
      try {
        const [gallery, collections] = await Promise.all([
          galleryStore.allRenders(),
          galleryStore.allCollections(),
        ]);
        set({ gallery, collections, galleryReady: true });
      } catch (err) {
        console.warn('LumenDeck: gallery hydrate failed (in-memory this session).', err);
        set({ galleryReady: true });
      }
    },

    createCollection: async (name) => {
      const { collections } = await createCollectionOp(galleryStore, get().collections, name);
      set({ collections });
    },
    renameCollection: async (id, name) => {
      const collections = await renameCollectionOp(galleryStore, get().collections, id, name);
      set({ collections });
    },
    deleteCollection: async (id) => {
      const { collections, gallery } = await deleteCollectionOp(galleryStore, get().collections, get().gallery, id);
      set({ collections, gallery });
    },
    assignToCollection: async (itemId, collectionId) => {
      const gallery = await assignToCollectionOp(galleryStore, get().gallery, itemId, collectionId);
      set({ gallery });
    },
    addTag: async (itemId, tag) => {
      const gallery = await addTagOp(galleryStore, get().gallery, itemId, tag);
      set({ gallery });
    },
    removeTag: async (itemId, tag) => {
      const gallery = await removeTagOp(galleryStore, get().gallery, itemId, tag);
      set({ gallery });
    },

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

    /* ------------------------------------------------ Creative OS actions */
    analysisContext: () => buildAnalysisContext(get().gallery, get().creative.brains, get().shelf),
    portfolioReport: () =>
      analyzePortfolio(
        get().creative.brains,
        get().creative.recipes,
        buildAnalysisContext(get().gallery, get().creative.brains, get().shelf),
        new Date(),
      ),

    createProject: (name, type) => {
      const brain = createBrain(name, type, new Date());
      setCreative({ brains: [...get().creative.brains, brain], activeProjectId: brain.id });
      return brain.id;
    },

    updateProjectBrain: (id, mutate) => {
      setCreative({ brains: get().creative.brains.map((b) => (b.id === id ? mutate(b) : b)) });
    },

    deleteProject: (id) => {
      const brains = get().creative.brains.filter((b) => b.id !== id);
      const activeProjectId = get().creative.activeProjectId === id ? (brains[0]?.id ?? null) : get().creative.activeProjectId;
      setCreative({ brains, activeProjectId });
    },

    setActiveProject: (id) => setCreative({ activeProjectId: id }),

    openProject: (id) => {
      editBrain(id, (b) => touchOpened(b, new Date()));
      setCreative({ activeProjectId: id });
      set({ view: 'projects' });
    },

    linkRenderToProject: (projectId, galleryId) => {
      editBrain(projectId, (b) => {
        if (b.renders.includes(galleryId)) return b;
        return recordEvent({ ...b, renders: [...b.renders, galleryId] }, 'render-linked', 'Linked a render', new Date(), galleryId);
      });
    },

    unlinkRenderFromProject: (projectId, galleryId) => {
      editBrain(projectId, (b) =>
        recordEvent({ ...b, renders: b.renders.filter((r) => r !== galleryId) }, 'render-unlinked', 'Unlinked a render', new Date(), galleryId),
      );
    },

    addPromptToProject: (projectId, text, negative) => {
      const prompt = { id: creativeId('pr'), text, negative, addedAt: new Date().toISOString() };
      editBrain(projectId, (b) => recordEvent({ ...b, prompts: [...b.prompts, prompt] }, 'prompt-added', `Added prompt: ${text.slice(0, 32)}`, new Date(), prompt.id));
    },

    addAssetToProject: (projectId, label, kind, galleryId) => {
      const asset = { id: creativeId('as'), label, kind, galleryId, status: 'ok' as const, addedAt: new Date().toISOString() };
      editBrain(projectId, (b) => recordEvent({ ...b, assets: [...b.assets, asset] }, 'asset-linked', `Linked asset: ${label}`, new Date(), asset.id));
    },

    repairProjectAsset: (projectId, assetId, galleryId) => {
      editBrain(projectId, (b) =>
        recordEvent(
          { ...b, assets: b.assets.map((a) => (a.id === assetId ? { ...a, status: 'ok' as const, galleryId: galleryId ?? a.galleryId } : a)) },
          'asset-repaired',
          'Repaired an asset link',
          new Date(),
          assetId,
        ),
      );
    },

    archiveProjectAsset: (projectId, assetId) => {
      editBrain(projectId, (b) =>
        recordEvent(
          { ...b, assets: b.assets.map((a) => (a.id === assetId ? { ...a, archived: true } : a)) },
          'asset-unlinked',
          'Archived an asset',
          new Date(),
          assetId,
        ),
      );
    },

    addPublishedLink: (projectId, label, url) => {
      const link = { id: creativeId('ln'), label, url, addedAt: new Date().toISOString() };
      editBrain(projectId, (b) => recordEvent({ ...b, publishedLinks: [...b.publishedLinks, link] }, 'link-published', `Published: ${label}`, new Date(), link.id));
    },

    markProjectShipped: (projectId) => {
      editBrain(projectId, (b) => updateBrain(b, { status: 'shipped' }, new Date()));
    },

    generateProjectCaptions: (projectId) => {
      const b = getBrain(projectId);
      if (!b) return;
      const captions = generateSocialCaptions(b, 3);
      editBrain(projectId, (brain) => updateBrain(brain, { copy: { ...brain.copy, socialCaptions: captions } }, new Date(), { type: 'captions-updated', label: 'Generated social captions' }));
    },

    buildProjectReleasePack: (projectId) => {
      const b = getBrain(projectId);
      if (!b) return null;
      const now = new Date();
      const ctx = buildAnalysisContext(get().gallery, get().creative.brains, get().shelf);
      const gallery = get().gallery;
      const resolveRender = (galleryId: string) => {
        const item = gallery.find((g) => g.id === galleryId);
        if (!item) return null;
        return { dataUrl: item.dataUrl, extension: item.extension || (item.mediaType === 'video' ? 'mp4' : 'png') };
      };
      const pack = buildReleasePack(b, ctx, resolveRender, now);
      // Download the assembled ZIP (browser/Tauri webview blob-anchor path).
      try {
        if (typeof Blob !== 'undefined' && typeof URL !== 'undefined' && typeof document !== 'undefined') {
          const bytes = new Uint8Array(pack.zip);
          const blob = new Blob([bytes], { type: 'application/zip' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${pack.folderName}.zip`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
      } catch {
        /* download is best-effort; the export is still recorded */
      }
      const record = packExportRecord(pack, now);
      editBrain(projectId, (brain) => recordEvent({ ...brain, exports: [...brain.exports, record] }, 'export-built', `Built release pack (${pack.summary.present}/${pack.summary.total})`, now, record.id));
      return pack;
    },

    exportProjectFile: (projectId) => {
      const b = getBrain(projectId);
      if (!b) return;
      const file = buildProjectFile(b, get().creative.recipes, new Date());
      downloadJson(file, `${b.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project'}.lumendeck.project.json`);
    },

    importProjectFile: (file) => {
      const brains = get().creative.brains;
      const existing = brains.findIndex((b) => b.id === file.brain.id);
      const nextBrains = existing >= 0 ? brains.map((b, i) => (i === existing ? file.brain : b)) : [...brains, file.brain];
      // Merge recipes the file carried (skip ids already present).
      const have = new Set(get().creative.recipes.map((r) => r.id));
      const newRecipes = file.recipes.filter((r) => !have.has(r.id));
      setCreative({ brains: nextBrains, recipes: [...get().creative.recipes, ...newRecipes], activeProjectId: file.brain.id });
      set({ view: 'projects' });
    },

    createCreativeRecipe: (name) => {
      const recipe = createRecipePure(name, new Date());
      setCreative({ recipes: [...get().creative.recipes, recipe] });
      return recipe.id;
    },

    updateCreativeRecipe: (id, patch) => {
      setCreative({ recipes: get().creative.recipes.map((r) => (r.id === id ? updateRecipePure(r, patch, new Date()) : r)) });
    },

    duplicateCreativeRecipe: (id) => {
      const r = get().creative.recipes.find((x) => x.id === id);
      if (!r) return;
      setCreative({ recipes: [...get().creative.recipes, duplicateRecipePure(r, new Date())] });
    },

    deleteCreativeRecipe: (id) => {
      setCreative({
        recipes: get().creative.recipes.filter((r) => r.id !== id),
        brains: get().creative.brains.map((b) => (b.recipes.includes(id) ? { ...b, recipes: b.recipes.filter((x) => x !== id) } : b)),
      });
    },

    applyCreativeRecipe: (id, subject) => {
      const recipe = get().creative.recipes.find((r) => r.id === id);
      if (!recipe) return;
      const app = applyRecipePure(recipe, subject);
      const wf = get().workflow;
      const promptNode = findNode(wf, 'prompt');
      const modelNode = findNode(wf, 'model');
      const canvasNode = findNode(wf, 'canvas');
      if (promptNode) {
        get().updateParam(promptNode.id, 'positive', app.prompt);
        if (app.negativePrompt) get().updateParam(promptNode.id, 'negative', app.negativePrompt);
      }
      if (modelNode && app.modelId) get().updateParam(modelNode.id, 'assetId', app.modelId);
      if (canvasNode) {
        get().updateParam(canvasNode.id, 'width', app.canvas.width);
        get().updateParam(canvasNode.id, 'height', app.canvas.height);
      }
      setCreative({ recipes: get().creative.recipes.map((r) => (r.id === id ? markRecipeUsed(r, new Date()) : r)) });
      set({ view: 'recipe' });
    },

    promoteToRecipe: ({ galleryId, name, text }) => {
      const now = new Date();
      const wf = get().workflow;
      // Explicit `text` (e.g. promoting a stored prompt) wins over the live graph.
      let promptText = text ?? String(findNode(wf, 'prompt')?.params.positive ?? '');
      let negative = String(findNode(wf, 'prompt')?.params.negative ?? '');
      let modelId = String(findNode(wf, 'model')?.params.assetId ?? '');
      let aspect: '16:9' | '1:1' | '9:16' = '1:1';
      if (galleryId) {
        const item = get().gallery.find((g) => g.id === galleryId);
        if (item?.manifest) {
          promptText = item.manifest.resolvedPrompt || item.manifest.prompt || promptText;
          negative = item.manifest.negativePrompt || negative;
          modelId = item.manifest.model?.id || modelId;
          const c = item.manifest.canvas;
          const r = c.width / Math.max(1, c.height);
          aspect = Math.abs(r - 16 / 9) < 0.06 ? '16:9' : Math.abs(r - 9 / 16) < 0.06 ? '9:16' : '1:1';
        }
      }
      const recipe = createRecipePure(name || 'Promoted recipe', now, {
        promptTemplate: promptText,
        negativePrompt: negative,
        modelId,
        aspectRatios: [aspect],
      });
      setCreative({ recipes: [...get().creative.recipes, recipe] });
      return recipe.id;
    },

    linkRecipeToProject: (projectId, recipeId) => {
      editBrain(projectId, (b) => {
        if (b.recipes.includes(recipeId)) return b;
        return recordEvent({ ...b, recipes: [...b.recipes, recipeId] }, 'recipe-linked', 'Linked a recipe', new Date(), recipeId);
      });
    },

    resolveEntropyItem: (item, action) => {
      const now = new Date();
      switch (action) {
        case 'delete':
          if (item.ref && (item.kind === 'duplicate-render' || item.kind === 'unused-render' || item.kind === 'unlabeled-render')) {
            get().removeGalleryItem(item.ref);
          } else if (item.projectId && item.ref) {
            editBrain(item.projectId, (b) => ({
              ...b,
              assets: b.assets.filter((a) => a.id !== item.ref),
              prompts: b.prompts.filter((p) => p.id !== item.ref),
              renders: b.renders.filter((r) => r !== item.ref),
            }));
          }
          break;
        case 'archive':
          if (item.projectId && item.ref && item.kind !== 'unlabeled-render' && item.kind !== 'unused-render' && item.kind !== 'duplicate-render') {
            editBrain(item.projectId, (b) => ({ ...b, assets: b.assets.map((a) => (a.id === item.ref ? { ...a, archived: true } : a)) }));
          } else if (item.ref) {
            // Gallery-global renders (unlabeled / unused / duplicate) have no project
            // to archive into — tag them 'archived' so the finding clears on rescan.
            void get().addTag(item.ref, 'archived');
          }
          break;
        case 'retag':
          if (item.ref) void get().addTag(item.ref, 'reviewed');
          break;
        case 'repair':
          if (item.projectId && item.ref && item.kind === 'orphaned-render-link') {
            editBrain(item.projectId, (b) => recordEvent({ ...b, renders: b.renders.filter((r) => r !== item.ref) }, 'render-unlinked', 'Removed a dead render link', now, item.ref));
          } else if (item.projectId && item.ref) {
            editBrain(item.projectId, (b) => recordEvent({ ...b, assets: b.assets.map((a) => (a.id === item.ref ? { ...a, status: 'ok' as const } : a)) }, 'asset-repaired', 'Marked asset repaired', now, item.ref));
          }
          break;
        case 'promote-to-recipe':
          if (item.ref && item.kind === 'unused-render') get().promoteToRecipe({ galleryId: item.ref });
          else if (item.projectId && item.ref && item.kind === 'stale-prompt') {
            const b = getBrain(item.projectId);
            const p = b?.prompts.find((x) => x.id === item.ref);
            if (p) get().promoteToRecipe({ name: `From: ${p.text.slice(0, 24)}`, text: p.text });
          }
          break;
        case 'merge':
          // Merge = keep the first duplicate, delete this one.
          if (item.ref) get().removeGalleryItem(item.ref);
          break;
        case 'regenerate':
          // Route the user to the graph to regenerate; deterministic engines can't render.
          set({ view: 'graph' });
          break;
      }
    },

    setAiEnabled: (on) => setCreative({ aiEnabled: on }),

    seedCreativeDemo: () => {
      // Guard against a second seed (double-click / racing effect): once seeded,
      // do nothing so demo renders can never be inserted into the gallery twice.
      if (get().creative.seeded) return;
      const now = new Date();
      const { brains, recipes, renders } = buildCreativeDemo(now);
      // Skip demo brains/recipes already present so re-seeding is idempotent.
      const haveBrains = new Set(get().creative.brains.map((b) => b.id));
      const haveRecipes = new Set(get().creative.recipes.map((r) => r.id));
      const newBrains = brains.filter((b) => !haveBrains.has(b.id));
      const newRecipes = recipes.filter((r) => !haveRecipes.has(r.id));
      // Insert demo renders into the durable gallery so release-ready assets resolve.
      // The .then re-checks the LIVE gallery by id (hydrateGallery may land first)
      // so a render is never duplicated in the in-memory list.
      void Promise.all(renders.map((r) => galleryStore.putRender(r).catch(() => {})))
        .then(() => {
          const present = new Set(get().gallery.map((g) => g.id));
          const missing = renders.filter((r) => !present.has(r.id));
          if (missing.length) set({ gallery: [...missing, ...get().gallery] });
        });
      setCreative({
        brains: [...get().creative.brains, ...newBrains],
        recipes: [...get().creative.recipes, ...newRecipes],
        activeProjectId: newBrains[0]?.id ?? get().creative.activeProjectId,
        seeded: true,
      });
    },

    recordPublishedShare: (input) =>
      set({ publishedShares: addShare(get().publishedShares, input, crypto.randomUUID(), Date.now()) }),
    removePublishedShare: (id) =>
      set({ publishedShares: removeShare(get().publishedShares, id) }),
    unpublishShare: async (id) => {
      const share = get().publishedShares.find((s) => s.id === id);
      if (!share) return { ok: true, status: 200 };
      const result = await unpublishShowcase(share.path, share.token);
      if (result.ok) set({ publishedShares: removeShare(get().publishedShares, id) });
      return result;
    },
  };
});

// Persist on every relevant change (cheap JSON writes, trailing-debounced).
//
// CRITICAL: the persisted PROJECTION excludes the ephemeral transport (playhead)
// entirely, and this subscription BAILS when the projection is byte-identical to
// the last one. Without this bail, the 30Hz->now-6Hz transport.t writes during
// playback would reset the 300ms trailing debounce on every tick, so savePersisted
// would never actually fire while a clip plays (persistence starvation). Transport
// is ephemeral and must NEVER trigger a persistence save.
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let lastPersistedJson: string | null = null;
useStudio.subscribe((state) => {
  const projection = persistedProjection(state);
  const json = JSON.stringify(projection);
  // Nothing persisted changed (e.g. only transport.t advanced) -> do not touch
  // the debounce timer, so a genuine save is never starved by playback writes.
  if (json === lastPersistedJson) return;
  lastPersistedJson = json;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    savePersisted(projection);
  }, 300);
});

// Kick off async gallery hydration from IndexedDB (runs the one-time migration
// first). Guarded so a hydrate failure never blocks app startup.
void useStudio.getState().hydrateGallery();
