/**
 * Build a HardwareSnapshot from the bridge worker's status payload.
 *
 * Kept structural (no import of BridgeModelStatus) so the pure hardware module
 * never depends on the bridge layer. CUDA availability implies an NVIDIA GPU in
 * LumenDeck's stack (the managed runtime installs cu128 torch), so `nvidia`
 * mirrors `cuda`.
 */
import type { HardwareSnapshot } from './detection';

export interface BridgeHardwareFields {
  cuda?: boolean;
  cudaInitFailed?: boolean;
  device?: string;
  gpuName?: string;
  totalVramMb?: number;
  freeVramMb?: number;
  computeCapability?: string;
  bf16Supported?: boolean;
}

export function snapshotFromBridgeStatus(
  status: BridgeHardwareFields | null | undefined,
): HardwareSnapshot | null {
  if (!status) return null;
  const cuda = Boolean(status.cuda);
  return {
    nvidia: cuda,
    cuda,
    cudaInitFailed: Boolean(status.cudaInitFailed),
    deviceName: status.gpuName || status.device || undefined,
    totalVramMb: typeof status.totalVramMb === 'number' ? status.totalVramMb : undefined,
    freeVramMb: typeof status.freeVramMb === 'number' ? status.freeVramMb : undefined,
    backend: 'diffusers',
    computeCapability: status.computeCapability,
    // fp16 works on every CUDA GPU (incl. Turing GTX 1650); bf16 only when the
    // worker confirmed it via torch.cuda.is_bf16_supported().
    supportedPrecisions: { fp16: cuda, bf16: Boolean(status.bf16Supported) },
  };
}
