import type { VideoBenchmarkMetrics, VideoOptimizationSettings } from './types';

export const DEFAULT_VIDEO_OPTIMIZATION: VideoOptimizationSettings = {
  draftFpsMode: true,
  lowFramePreview: true,
  keyframeOnlyPreview: false,
  chunkedRendering: true,
  resumeFromFailedChunk: true,
  cachedConditioningFrames: true,
  cachedPromptEmbeddingsPerSegment: true,
  frameInterpolation: false,
  videoUpscale: false,
  encoderPreset: 'balanced',
  chunkSizeFrames: 24,
};

export function createVideoBenchmarkMetrics(input: {
  totalRenderTimeMs: number;
  encodeTimeMs: number;
  frameCount: number;
  fps: number;
  width: number;
  height: number;
  chunkCount: number;
  failedChunkCount?: number;
  resumedChunkCount?: number;
  peakMemoryGB?: number;
}): VideoBenchmarkMetrics {
  return {
    secondsPerFrame: input.frameCount > 0 ? input.totalRenderTimeMs / 1000 / input.frameCount : 0,
    totalRenderTimeMs: input.totalRenderTimeMs,
    encodeTimeMs: input.encodeTimeMs,
    peakMemoryGB: input.peakMemoryGB,
    chunkCount: input.chunkCount,
    failedChunkCount: input.failedChunkCount ?? 0,
    resumedChunkCount: input.resumedChunkCount ?? 0,
    fps: input.fps,
    durationSeconds: input.fps > 0 ? input.frameCount / input.fps : 0,
    resolution: { width: input.width, height: input.height },
  };
}
