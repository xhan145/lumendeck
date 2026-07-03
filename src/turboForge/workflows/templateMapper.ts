import type { RenderJob } from '../../bridge/adapter';
import { checkpointNameFromJob, type ComfyWorkflowTemplate } from './comfyWorkflowTemplates';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function replaceToken(value: string, job: RenderJob): JsonValue {
  const replacements: Record<string, JsonValue> = {
    '{{prompt}}': job.prompt,
    '{{negativePrompt}}': job.negativePrompt,
    '{{seed}}': job.seed,
    '{{steps}}': job.steps,
    '{{cfg}}': job.cfg,
    '{{width}}': job.width,
    '{{height}}': job.height,
    '{{checkpointName}}': checkpointNameFromJob(job),
  };
  if (value in replacements) return replacements[value];
  return value.replace(/\{\{prompt\}\}/g, job.prompt).replace(/\{\{negativePrompt\}\}/g, job.negativePrompt);
}

function mapValue(value: unknown, job: RenderJob): JsonValue {
  if (typeof value === 'string') return replaceToken(value, job);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => mapValue(item, job));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, mapValue(item, job)]));
  }
  return null;
}

export function mapComfyTemplate(template: ComfyWorkflowTemplate, job: RenderJob): Record<string, unknown> {
  return mapValue(template.workflow, job) as Record<string, unknown>;
}
