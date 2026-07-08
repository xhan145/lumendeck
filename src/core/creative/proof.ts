/**
 * Proof Mode. Separates concrete shipped artifacts from drafts. "Proof" = things
 * that actually exist as deliverables: exports (ZIPs, packs, PDFs), published
 * links the user entered, and renders belonging to shipped/release-ready
 * projects. Everything else is a draft.
 */
import type { ExportRecord, ProjectBrain, PublishedLink } from './types';

export interface ProofArtifact {
  id: string;
  projectId: string;
  projectName: string;
  kind: 'export' | 'link' | 'shipped-render';
  label: string;
  detail: string;
  at: string;
  /** for links */
  url?: string;
  /** for exports */
  fileName?: string;
  /** gallery id for shipped renders */
  ref?: string;
}

export interface ProofSummary {
  artifacts: ProofArtifact[];
  /** count of projects that have at least one proof artifact */
  shippedProjects: number;
  exports: number;
  links: number;
  shippedRenders: number;
}

function fromExport(brain: ProjectBrain, e: ExportRecord): ProofArtifact {
  return {
    id: e.id,
    projectId: brain.id,
    projectName: brain.name,
    kind: 'export',
    label: e.label,
    detail: `${e.kind} · ${brain.name}`,
    at: e.at,
    fileName: e.fileName,
  };
}

function fromLink(brain: ProjectBrain, l: PublishedLink): ProofArtifact {
  return {
    id: l.id,
    projectId: brain.id,
    projectName: brain.name,
    kind: 'link',
    label: l.label,
    detail: l.url,
    at: l.addedAt,
    url: l.url,
  };
}

/**
 * Collect proof artifacts across all projects. `shippedRenderIds` (optional)
 * lets callers include renders that belong to shipped projects — only renders
 * that still resolve in the gallery are included.
 */
export function collectProof(brains: ProjectBrain[], resolvesRender: (id: string) => boolean): ProofSummary {
  const artifacts: ProofArtifact[] = [];
  const shippedProjectIds = new Set<string>();

  for (const brain of brains) {
    for (const e of brain.exports) {
      artifacts.push(fromExport(brain, e));
      shippedProjectIds.add(brain.id);
    }
    for (const l of brain.publishedLinks) {
      artifacts.push(fromLink(brain, l));
      shippedProjectIds.add(brain.id);
    }
    if (brain.status === 'shipped' || brain.status === 'release-ready') {
      for (const id of brain.renders) {
        if (!resolvesRender(id)) continue;
        artifacts.push({
          id: `render_${id}`,
          projectId: brain.id,
          projectName: brain.name,
          kind: 'shipped-render',
          label: `Final render`,
          detail: `${brain.name} (${brain.status})`,
          at: brain.updatedAt,
          ref: id,
        });
        shippedProjectIds.add(brain.id);
      }
    }
  }

  artifacts.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return {
    artifacts,
    shippedProjects: shippedProjectIds.size,
    exports: artifacts.filter((a) => a.kind === 'export').length,
    links: artifacts.filter((a) => a.kind === 'link').length,
    shippedRenders: artifacts.filter((a) => a.kind === 'shipped-render').length,
  };
}
