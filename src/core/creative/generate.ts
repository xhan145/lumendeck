/**
 * Deterministic local copy generators. These are NOT AI — they template launch
 * copy from the project brain so the app is useful fully offline. Where a field
 * is already authored, generators prefer the human text and only fill blanks.
 *
 * (An optional AI enhancer can be layered on top later; per the local-first
 * requirement it must be opt-in. These templates are the always-available floor.)
 */
import type { ProjectBrain } from './types';

function firstSentence(text: string): string {
  const t = text.trim();
  const m = t.match(/^.*?[.!?](\s|$)/);
  return (m ? m[0] : t).trim();
}

export function generateShortDescription(brain: ProjectBrain): string {
  if (brain.copy.shortDescription.trim()) return brain.copy.shortDescription.trim();
  const logline = brain.identity.logline.trim();
  if (logline) return firstSentence(logline).slice(0, 140);
  return `${brain.name} — a ${brain.type} project built in LumenDeck.`;
}

export function generateLongDescription(brain: ProjectBrain): string {
  if (brain.copy.longDescription.trim()) return brain.copy.longDescription.trim();
  const lines: string[] = [];
  const { logline, audience, promise } = brain.identity;
  lines.push(logline.trim() || `${brain.name} is a ${brain.type} project.`);
  if (audience.trim()) lines.push(`Made for ${audience.trim()}.`);
  if (promise.trim()) lines.push(promise.trim());
  if (brain.style.styleTags.length) lines.push(`Visual direction: ${brain.style.styleTags.join(', ')}.`);
  if (brain.activeGoals.length) {
    lines.push('');
    lines.push('Goals:');
    for (const g of brain.activeGoals) lines.push(`- ${g}`);
  }
  return lines.join('\n');
}

export function generateGithubDescription(brain: ProjectBrain): string {
  if (brain.copy.githubDescription.trim()) return brain.copy.githubDescription.trim();
  const short = generateShortDescription(brain);
  // GitHub repo "About" caps around 350 chars; keep it a tight single line.
  return short.replace(/\s+/g, ' ').slice(0, 340);
}

export function generatePressSummary(brain: ProjectBrain): string {
  if (brain.copy.pressSummary.trim()) return brain.copy.pressSummary.trim();
  const short = generateShortDescription(brain);
  const audience = brain.identity.audience.trim();
  return [
    `FOR IMMEDIATE RELEASE`,
    ``,
    `${brain.name}`,
    short,
    audience ? `Aimed at ${audience}.` : '',
    `Created with LumenDeck, a local-first creative studio.`,
  ].filter(Boolean).join('\n');
}

/** Generate N launch captions from the brain. Deterministic (index-seeded). */
export function generateSocialCaptions(brain: ProjectBrain, count = 3): string[] {
  const name = brain.name;
  const logline = brain.identity.logline.trim() || `a new ${brain.type}`;
  const tags = brain.style.styleTags.slice(0, 3).map((t) => `#${t.replace(/[^a-z0-9]+/gi, '')}`).filter((t) => t.length > 1);
  const hashtags = [...tags, '#madeWithLumenDeck'].join(' ');
  const templates = [
    `Introducing ${name} — ${logline}. ${hashtags}`,
    `${name} is here. ${firstSentence(logline)} ${hashtags}`,
    `We built ${name}: ${logline}. Take a look 👀 ${hashtags}`,
    `New drop: ${name}. ${logline}. ${hashtags}`,
    `${name} — ${logline}. Ships today. ${hashtags}`,
  ];
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) out.push(templates[i % templates.length]);
  return out;
}

export function generateReadmeSection(brain: ProjectBrain): string {
  if (brain.copy.readmeSection.trim()) return brain.copy.readmeSection.trim();
  const lines: string[] = [];
  lines.push(`# ${brain.name}`);
  lines.push('');
  lines.push(generateShortDescription(brain));
  lines.push('');
  if (brain.identity.promise.trim()) {
    lines.push('## What it does');
    lines.push('');
    lines.push(brain.identity.promise.trim());
    lines.push('');
  }
  if (brain.style.styleTags.length) {
    lines.push('## Style');
    lines.push('');
    lines.push(brain.style.styleTags.join(' · '));
    lines.push('');
  }
  lines.push('_Made with LumenDeck._');
  return lines.join('\n');
}

/** A launch checklist derived from missing-piece kinds (checked = present). */
export interface ChecklistItem {
  label: string;
  done: boolean;
}

export function generateLaunchChecklist(missingKinds: Set<string>): ChecklistItem[] {
  const has = (k: string) => !missingKinds.has(k);
  return [
    { label: 'Project brief written', done: has('no-identity') },
    { label: 'Active goals set', done: has('no-goals') },
    { label: 'Logo asset linked', done: has('no-logo') },
    { label: '16:9 promo rendered', done: has('no-promo-16x9') },
    { label: '1:1 promo rendered', done: has('no-promo-1x1') },
    { label: '9:16 promo rendered', done: has('no-promo-9x16') },
    { label: 'Short description written', done: has('no-short-description') },
    { label: 'Long description written', done: has('no-long-description') },
    { label: 'Social captions drafted', done: has('no-social-captions') },
    { label: 'README copy drafted', done: has('no-readme-copy') },
    { label: 'Release ZIP built', done: has('no-release-zip') },
    { label: 'Export folder assembled', done: has('no-export-folder') },
  ];
}

export function renderChecklistMarkdown(items: ChecklistItem[]): string {
  return items.map((i) => `- [${i.done ? 'x' : ' '}] ${i.label}`).join('\n');
}
