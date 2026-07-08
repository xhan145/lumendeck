/**
 * Release Pack Builder. Assembles a structured release folder for a project and
 * serializes it to a real (dependency-free) ZIP the user can download.
 *
 * Real generation is wired wherever data exists (copy from generators, images
 * from linked gallery renders, metadata from the brain). Slots with no source
 * are emitted as clearly-labeled TODO placeholder files AND surfaced as
 * `present:false` slots so the UI can show the gap instead of silently skipping.
 */
import type { AnalysisContext } from './context';
import { indexRenders } from './context';
import type { ExportRecord, ProjectBrain } from './types';
import { detectMissing } from './missing';
import { slugifyName } from './util';
import {
  generateGithubDescription,
  generateLaunchChecklist,
  generateLongDescription,
  generatePressSummary,
  generateReadmeSection,
  generateShortDescription,
  generateSocialCaptions,
  renderChecklistMarkdown,
} from './generate';
import { dataUrlToBytes, textBytes, zipSync, type ZipEntry } from './zip';
import { creativeId } from './brain';

export type SlotCategory = 'logo' | 'promo' | 'copy' | 'meta' | 'checklist';

export interface PackSlot {
  /** path inside the folder, e.g. 'promo/hero_16x9.png' */
  path: string;
  category: SlotCategory;
  /** true when real content was written; false when only a TODO placeholder */
  present: boolean;
  /** short human note shown in the UI */
  note: string;
  /** the render/asset id backing this slot, when applicable */
  ref?: string;
}

export interface ReleasePack {
  folderName: string;
  slots: PackSlot[];
  entries: ZipEntry[];
  /** the assembled ZIP bytes, ready to download */
  zip: Uint8Array;
  summary: { total: number; present: number; todo: number };
}

/** Resolve a gallery render id to its media for embedding. */
export type RenderResolver = (galleryId: string) => { dataUrl: string; extension: string } | null;

const ASPECT_FILE: Record<'16:9' | '1:1' | '9:16', string> = {
  '16:9': 'hero_16x9',
  '1:1': 'square_1x1',
  '9:16': 'vertical_9x16',
};

export function buildReleasePack(
  brain: ProjectBrain,
  ctx: AnalysisContext,
  resolveRender: RenderResolver,
  now: Date,
): ReleasePack {
  const folderName = `${slugifyName(brain.name)}-release-pack`;
  const idx = indexRenders(ctx);
  const slots: PackSlot[] = [];
  const entries: ZipEntry[] = [];

  const addText = (path: string, category: SlotCategory, text: string, present: boolean, note: string, ref?: string) => {
    entries.push({ name: `${folderName}/${path}`, data: textBytes(text) });
    slots.push({ path, category, present, note, ...(ref ? { ref } : {}) });
  };
  const addTodo = (path: string, category: SlotCategory, note: string) => {
    entries.push({
      name: `${folderName}/${path}`,
      data: textBytes(`TODO: ${note}\n\nThis slot is part of the release pack but no source exists yet.\nGenerate or link the missing piece in LumenDeck, then rebuild the pack.`),
    });
    slots.push({ path, category, present: false, note });
  };

  // ---- logo
  const logo = brain.assets.find((a) => a.kind === 'logo' && !a.archived && a.status === 'ok');
  const logoMedia = logo?.galleryId ? resolveRender(logo.galleryId) : null;
  if (logoMedia) {
    entries.push({ name: `${folderName}/logo/logo.${logoMedia.extension}`, data: dataUrlToBytes(logoMedia.dataUrl) });
    slots.push({ path: `logo/logo.${logoMedia.extension}`, category: 'logo', present: true, note: `Logo from ${logo?.label}`, ref: logo?.id });
  } else {
    addTodo('logo/logo.TODO.txt', 'logo', 'No logo asset linked. Generate one and link it as a "logo" asset.');
  }

  // ---- promo art slots (three aspects)
  (['16:9', '1:1', '9:16'] as const).forEach((aspect) => {
    const renderId = brain.renders.find((id) => idx.get(id)?.aspect === aspect);
    const media = renderId ? resolveRender(renderId) : null;
    const base = ASPECT_FILE[aspect];
    if (media) {
      entries.push({ name: `${folderName}/promo/${base}.${media.extension}`, data: dataUrlToBytes(media.dataUrl) });
      slots.push({ path: `promo/${base}.${media.extension}`, category: 'promo', present: true, note: `${aspect} promo`, ref: renderId });
    } else {
      addTodo(`promo/${base}.TODO.txt`, 'promo', `No ${aspect} promo render. Create one and link it to the project.`);
    }
  });

  // ---- copy (real generation from the brain)
  const short = generateShortDescription(brain);
  const long = generateLongDescription(brain);
  addText('copy/short-description.txt', 'copy', short, brain.copy.shortDescription.trim().length > 0 || short.length > 0, 'Short description');
  addText('copy/long-description.md', 'copy', long, brain.copy.longDescription.trim().length > 0, 'Long description');
  addText('copy/github-description.txt', 'copy', generateGithubDescription(brain), true, 'GitHub About text');
  addText('copy/press-summary.txt', 'copy', generatePressSummary(brain), brain.copy.pressSummary.trim().length > 0, 'Press / product summary');

  const captions = brain.copy.socialCaptions.length ? brain.copy.socialCaptions : generateSocialCaptions(brain);
  addText('copy/social-captions.txt', 'copy', captions.map((c, i) => `${i + 1}. ${c}`).join('\n\n'), brain.copy.socialCaptions.length > 0, 'Social captions');

  addText('README.md', 'copy', generateReadmeSection(brain), brain.copy.readmeSection.trim().length > 0, 'README section');

  // ---- launch checklist (derived from missing pieces)
  const missingKinds = new Set(detectMissing(brain, ctx).map((m) => m.kind));
  const checklist = generateLaunchChecklist(missingKinds);
  addText('LAUNCH-CHECKLIST.md', 'checklist', `# Launch checklist — ${brain.name}\n\n${renderChecklistMarkdown(checklist)}\n`, true, 'Launch checklist');

  // ---- project metadata JSON (always real)
  const metadata = {
    schemaVersion: 1,
    app: 'LumenDeck',
    generatedAt: now.toISOString(),
    project: {
      id: brain.id,
      name: brain.name,
      type: brain.type,
      status: brain.status,
      identity: brain.identity,
      style: brain.style,
      goals: brain.activeGoals,
      renderCount: brain.renders.length,
      recipeCount: brain.recipes.length,
    },
  };
  addText('project.metadata.json', 'meta', JSON.stringify(metadata, null, 2), true, 'Project metadata');

  const present = slots.filter((s) => s.present).length;
  return {
    folderName,
    slots,
    entries,
    zip: zipSync(entries),
    summary: { total: slots.length, present, todo: slots.length - present },
  };
}

/** Build the ExportRecord that records this pack on the brain. */
export function packExportRecord(pack: ReleasePack, now: Date): ExportRecord {
  return {
    id: creativeId('exp'),
    kind: 'release-pack',
    label: `Release Pack (${pack.summary.present}/${pack.summary.total} slots)`,
    fileName: `${pack.folderName}.zip`,
    at: now.toISOString(),
    itemCount: pack.summary.total,
    bytes: pack.zip.length,
  };
}
