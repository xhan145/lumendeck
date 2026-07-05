/** Socket (port) data types carried along graph edges. */
export type SocketType =
  | 'conditioning'
  | 'model'
  | 'lora_stack'
  | 'control'
  | 'latent'
  | 'image'
  | 'media'
  | 'manifest';

export type CapsuleKind =
  | 'prompt'
  | 'model'
  | 'loraRack'
  | 'control'
  | 'sampler'
  | 'video'
  | 'canvas'
  | 'queue'
  | 'export'
  | 'manifest';

export interface SocketDef {
  id: string;
  label: string;
  type: SocketType;
}

export interface ParamDef {
  id: string;
  label: string;
  kind: 'text' | 'textarea' | 'number' | 'select' | 'seed' | 'toggle';
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
  default: unknown;
  help?: string;
}

export interface CapsuleDef {
  kind: CapsuleKind;
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

export interface RackPreset {
  id: string;
  name: string;
  slots: LoraSlot[];
}
