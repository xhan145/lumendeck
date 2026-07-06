/** Socket (port) data types carried along graph edges. */
export type SocketType =
  | 'conditioning'
  | 'model'
  | 'clip'
  | 'vae'
  | 'lora_stack'
  | 'control'
  | 'latent'
  | 'noise'
  | 'mask'
  | 'image'
  | 'media'
  | 'number'
  | 'string'
  | 'upscale_model'
  | 'manifest';

export type CapsuleKind =
  | 'prompt'
  | 'model'
  | 'checkpointLoader'
  | 'clipTextEncode'
  | 'clipSetLastLayer'
  | 'conditioningCombine'
  | 'conditioningAverage'
  | 'conditioningSetArea'
  | 'loraLoader'
  | 'loraRack'
  | 'vaeLoader'
  | 'emptyLatent'
  | 'latentNoise'
  | 'latentUpscale'
  | 'latentCrop'
  | 'latentComposite'
  | 'vaeEncode'
  | 'vaeDecode'
  | 'control'
  | 'controlNetLoader'
  | 'controlNetApply'
  | 'controlNetRack'
  | 'cannyPreprocessor'
  | 'depthPreprocessor'
  | 'posePreprocessor'
  | 'imageLoader'
  | 'imageScale'
  | 'imageCrop'
  | 'imageBlend'
  | 'imageSharpen'
  | 'imageColorCorrect'
  | 'imageToMask'
  | 'maskBlur'
  | 'maskGrow'
  | 'maskComposite'
  | 'sampler'
  | 'samplerAdvanced'
  | 'refinerSampler'
  | 'hiresFix'
  | 'upscaleModelLoader'
  | 'imageUpscaleWithModel'
  | 'faceDetailer'
  | 'previewImage'
  | 'video'
  | 'frameInterpolator'
  | 'canvas'
  | 'queue'
  | 'note'
  | 'reroute'
  | 'seed'
  | 'math'
  | 'export'
  | 'manifest';

export type CapsuleCategory =
  | 'core'
  | 'loaders'
  | 'conditioning'
  | 'latent'
  | 'control'
  | 'image'
  | 'mask'
  | 'sampling'
  | 'video'
  | 'utility'
  | 'output';

export interface SocketDef {
  id: string;
  label: string;
  type: SocketType;
}

export interface ParamDef {
  id: string;
  label: string;
  kind: 'text' | 'textarea' | 'number' | 'select' | 'seed' | 'toggle' | 'image';
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
  default: unknown;
  help?: string;
}

export interface CapsuleDef {
  kind: CapsuleKind;
  category: CapsuleCategory;
  title: string;
  /** CSS color token reference, e.g. 'var(--cap-prompt)' */
  accent: string;
  description: string;
  inputs: SocketDef[];
  outputs: SocketDef[];
  params: ParamDef[];
}

export interface WorkflowNode {
  id: string;
  kind: CapsuleKind;
  x: number;
  y: number;
  params: Record<string, unknown>;
}

export interface SocketRef {
  node: string;
  socket: string;
}

export interface WorkflowEdge {
  id: string;
  from: SocketRef;
  to: SocketRef;
}

export interface Workflow {
  id: string;
  name: string;
  /** bumped on every mutation; recorded in manifests */
  version: number;
  schemaVersion: 1;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface LoraSlot {
  assetId: string;
  weight: number;
  enabled: boolean;
}

/** One stacked ControlNet in the ControlNet Rack. Each slot carries its own control image. */
export interface ControlSlot {
  id: string;
  type: 'canny' | 'depth' | 'pose' | 'scribble' | 'lineart' | 'softedge' | 'tile';
  strength: number;
  /** base64 data URL of the control source image ('' when not uploaded yet) */
  image: string;
  enabled: boolean;
}

export interface RackPreset {
  id: string;
  name: string;
  slots: LoraSlot[];
}
