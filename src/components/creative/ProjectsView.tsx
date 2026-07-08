import { useMemo, useRef, useState } from 'react';
import { useStudio } from '../../state/store';
import { Icon } from '../icons';
import { ReadinessRing } from './ReadinessRing';
import { NextActionCard } from './NextActionCard';
import { MissingPanel } from './MissingPanel';
import { CriticPanel } from './CriticPanel';
import { Timeline } from './Timeline';
import { updateBrain } from '../../core/creative/brain';
import { detectMissing } from '../../core/creative/missing';
import { scoreReadiness } from '../../core/creative/readiness';
import { nextAction } from '../../core/creative/nextAction';
import { parseProjectFile } from '../../core/creative/brain';
import type { ProjectBrain, ProjectStatus, ProjectType } from '../../core/creative/types';
import '../../styles/creative.css';

const TYPES: ProjectType[] = ['artwork', 'campaign', 'brand', 'app', 'exploration'];
const STATUSES: ProjectStatus[] = ['spark', 'in-progress', 'polishing', 'release-ready', 'shipped', 'archived'];

function CommaField({ label, value, onCommit, placeholder }: { label: string; value: string; onCommit: (v: string) => void; placeholder?: string }) {
  const [draft, setDraft] = useState(value);
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input value={draft} placeholder={placeholder} onChange={(e) => setDraft(e.target.value)} onBlur={() => onCommit(draft)} />
    </label>
  );
}

function ProjectDetail({ brain }: { brain: ProjectBrain }) {
  const update = useStudio((s) => s.updateProjectBrain);
  const gallery = useStudio((s) => s.gallery);
  const analysisContext = useStudio((s) => s.analysisContext);
  const buildPack = useStudio((s) => s.buildProjectReleasePack);
  const genCaptions = useStudio((s) => s.generateProjectCaptions);
  const markShipped = useStudio((s) => s.markProjectShipped);
  const exportFile = useStudio((s) => s.exportProjectFile);
  const deleteProject = useStudio((s) => s.deleteProject);
  const linkRender = useStudio((s) => s.linkRenderToProject);
  const unlinkRender = useStudio((s) => s.unlinkRenderFromProject);
  const addPrompt = useStudio((s) => s.addPromptToProject);
  const addAsset = useStudio((s) => s.addAssetToProject);
  const addLink = useStudio((s) => s.addPublishedLink);

  const ctx = analysisContext();
  const missing = useMemo(() => detectMissing(brain, ctx), [brain, ctx]);
  const readiness = useMemo(() => scoreReadiness(brain, ctx).score, [brain, ctx]);
  const action = useMemo(() => nextAction(brain, ctx), [brain, ctx]);
  const [packNote, setPackNote] = useState<string | null>(null);
  const [promptDraft, setPromptDraft] = useState('');

  const patch = (fn: (b: ProjectBrain) => ProjectBrain) => update(brain.id, fn);
  const setIdentity = (k: keyof ProjectBrain['identity'], v: string) =>
    patch((b) => updateBrain(b, { identity: { ...b.identity, [k]: v } }, new Date(), { type: 'identity-updated', label: `Updated ${k}` }));
  const setStyle = (k: keyof ProjectBrain['style'], v: string[] | string) =>
    patch((b) => updateBrain(b, { style: { ...b.style, [k]: v } }, new Date(), { type: 'style-updated', label: `Updated ${k}` }));

  const linkedIds = new Set(brain.renders);
  const linkable = gallery.filter((g) => !linkedIds.has(g.id)).slice(0, 12);
  const renderById = new Map(gallery.map((g) => [g.id, g]));

  return (
    <div className="project-detail">
      <header className="project-detail-head card creative-card">
        <ReadinessRing score={readiness} size={72} label="ready" />
        <div className="project-detail-title">
          <input className="project-name-input" value={brain.name} onChange={(e) => patch((b) => updateBrain(b, { name: e.target.value }, new Date()))} aria-label="Project name" />
          <div className="project-detail-selects">
            <select value={brain.type} onChange={(e) => patch((b) => updateBrain(b, { type: e.target.value as ProjectType }, new Date()))} aria-label="Project type">
              {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <select value={brain.status} onChange={(e) => patch((b) => updateBrain(b, { status: e.target.value as ProjectStatus }, new Date()))} aria-label="Project status">
              {STATUSES.map((s) => <option key={s} value={s}>{s.replace('-', ' ')}</option>)}
            </select>
          </div>
        </div>
        <div className="project-detail-actions">
          <button className="btn primary" type="button" onClick={() => { const p = buildPack(brain.id); setPackNote(p ? `Built ${p.summary.present}/${p.summary.total} slots → ${p.folderName}.zip` : null); }}>
            {Icon.download({ size: 15 })} Build Release Pack
          </button>
          <button className="btn" type="button" onClick={() => genCaptions(brain.id)}>{Icon.edit({ size: 14 })} Captions</button>
          <button className="btn" type="button" onClick={() => markShipped(brain.id)}>{Icon.trophy({ size: 14 })} Ship</button>
          <button className="btn icon" type="button" aria-label="Export project file" title="Export .lumendeck.project.json" onClick={() => exportFile(brain.id)}>{Icon.save({ size: 15 })}</button>
          <button className="btn icon danger" type="button" aria-label="Delete project" onClick={() => deleteProject(brain.id)}>{Icon.trash({ size: 15 })}</button>
        </div>
        {packNote ? <p className="pack-note">{Icon.ok({ size: 13 })} {packNote}</p> : null}
      </header>

      <NextActionCard action={action} />

      <div className="project-detail-grid">
        <section className="card creative-card">
          <div className="creative-card-head"><h3>{Icon.compass({ size: 15 })} Brief &amp; identity</h3></div>
          <CommaField label="Logline" value={brain.identity.logline} onCommit={(v) => setIdentity('logline', v)} placeholder="One sentence: what is this?" />
          <CommaField label="Audience" value={brain.identity.audience} onCommit={(v) => setIdentity('audience', v)} placeholder="Who is it for?" />
          <CommaField label="Promise" value={brain.identity.promise} onCommit={(v) => setIdentity('promise', v)} placeholder="What outcome does it deliver?" />
          <CommaField label="Mood" value={brain.style.mood} onCommit={(v) => setStyle('mood', v)} placeholder="e.g. calm, confident, midnight" />
          <CommaField label="Style tags (comma-separated)" value={brain.style.styleTags.join(', ')} onCommit={(v) => setStyle('styleTags', v.split(',').map((s) => s.trim()).filter(Boolean))} />
          <CommaField label="Palette (comma-separated hex)" value={brain.style.palette.join(', ')} onCommit={(v) => setStyle('palette', v.split(',').map((s) => s.trim()).filter(Boolean))} />
          <CommaField label="Goals (comma-separated)" value={brain.activeGoals.join(', ')} onCommit={(v) => patch((b) => updateBrain(b, { activeGoals: v.split(',').map((s) => s.trim()).filter(Boolean) }, new Date()))} />
          {brain.style.palette.length ? (
            <div className="palette-row" aria-hidden="true">{brain.style.palette.map((c, i) => <span key={i} style={{ background: c }} />)}</div>
          ) : null}
        </section>

        <MissingPanel items={missing} />

        <section className="card creative-card">
          <div className="creative-card-head"><h3>{Icon.image({ size: 15 })} Renders</h3><span className="spacer" /><span className="chip">{brain.renders.length}</span></div>
          <div className="linked-renders">
            {brain.renders.map((id) => {
              const g = renderById.get(id);
              return (
                <div key={id} className={`linked-render ${g ? '' : 'orphan'}`} title={g ? 'Linked render' : 'Broken link — render not found'}>
                  {g ? <img src={g.dataUrl} alt="linked render" /> : <span className="linked-render-orphan">{Icon.warning({ size: 18 })}</span>}
                  <button className="linked-render-x" type="button" aria-label="Unlink render" onClick={() => unlinkRender(brain.id, id)}>{Icon.close({ size: 11 })}</button>
                </div>
              );
            })}
            {brain.renders.length === 0 ? <p className="creative-empty">No renders linked yet.</p> : null}
          </div>
          {linkable.length ? (
            <>
              <p className="field-help">Link from gallery:</p>
              <div className="linkable-renders">
                {linkable.map((g) => (
                  <button key={g.id} type="button" className="linkable-render" title="Link to project" onClick={() => linkRender(brain.id, g.id)}>
                    <img src={g.dataUrl} alt="gallery render" />
                    <span className="linkable-plus">{Icon.plus({ size: 12 })}</span>
                  </button>
                ))}
              </div>
            </>
          ) : null}
          <div className="asset-quick">
            <button className="btn tiny" type="button" onClick={() => { const g = gallery[0]; if (g) addAsset(brain.id, 'Logo', 'logo', g.id); }} disabled={!gallery.length}>{Icon.plus({ size: 11 })} Logo from newest render</button>
            <button className="btn tiny" type="button" onClick={() => addLink(brain.id, 'Published link', 'https://')}>{Icon.link({ size: 11 })} Add published link</button>
          </div>
        </section>

        <section className="card creative-card">
          <div className="creative-card-head"><h3>{Icon.edit({ size: 15 })} Prompts</h3><span className="spacer" /><span className="chip">{brain.prompts.length}</span></div>
          <ul className="prompt-list">
            {brain.prompts.map((p) => <li key={p.id}><span className={p.lastProducedAt ? 'dot-ok' : 'dot-warn'} aria-hidden="true" />{p.text}</li>)}
            {brain.prompts.length === 0 ? <p className="creative-empty">No prompts recorded.</p> : null}
          </ul>
          <div className="field-inline">
            <input value={promptDraft} placeholder="Add a prompt…" onChange={(e) => setPromptDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && promptDraft.trim()) { addPrompt(brain.id, promptDraft.trim()); setPromptDraft(''); } }} />
            <button className="btn tiny" type="button" onClick={() => { if (promptDraft.trim()) { addPrompt(brain.id, promptDraft.trim()); setPromptDraft(''); } }}>Add</button>
          </div>
        </section>

        <CriticPanel brain={brain} ctx={ctx} />
        <Timeline brain={brain} />
      </div>
    </div>
  );
}

/** Projects: brain list + full project detail (brief, missing, critic, timeline, release pack). */
export function ProjectsView() {
  const brains = useStudio((s) => s.creative.brains);
  const activeProjectId = useStudio((s) => s.creative.activeProjectId);
  const setActive = useStudio((s) => s.setActiveProject);
  const createProject = useStudio((s) => s.createProject);
  const importProject = useStudio((s) => s.importProjectFile);
  const seedDemo = useStudio((s) => s.seedCreativeDemo);
  const analysisContext = useStudio((s) => s.analysisContext);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const active = brains.find((b) => b.id === activeProjectId) ?? brains[0] ?? null;
  const ctx = analysisContext();

  const onImport = (file: File) => {
    void file.text().then((text) => {
      const res = parseProjectFile(text);
      if (res.ok) importProject(res.file);
    });
  };

  return (
    <main className="studio-page creative-page projects-page scroll" aria-label="Projects">
      <div className="projects-layout">
        <aside className="projects-rail">
          <div className="projects-rail-head">
            <h2>Projects</h2>
            <button className="btn icon" type="button" aria-label="New project" title="New project" onClick={() => setActive(createProject('New Project', 'artwork'))}>{Icon.plus({ size: 16 })}</button>
          </div>
          <div className="projects-rail-list">
            {brains.length === 0 ? (
              <div className="projects-empty">
                <p>No projects yet.</p>
                <button className="btn primary" type="button" onClick={() => setActive(createProject('New Project', 'artwork'))}>{Icon.plus({ size: 14 })} Create project</button>
                <button className="btn" type="button" onClick={seedDemo}>{Icon.sparkle({ size: 14 })} Load demo</button>
              </div>
            ) : (
              brains.map((b) => {
                const r = scoreReadiness(b, ctx).score;
                return (
                  <button key={b.id} type="button" className={`project-row ${b.id === active?.id ? 'active' : ''}`} onClick={() => setActive(b.id)}>
                    <ReadinessRing score={r} size={38} />
                    <span className="project-row-body">
                      <span className="project-row-name">{b.name}</span>
                      <span className={`chip status-${b.status}`}>{b.status.replace('-', ' ')}</span>
                    </span>
                  </button>
                );
              })
            )}
          </div>
          <div className="projects-rail-foot">
            <button className="btn tiny" type="button" onClick={() => fileRef.current?.click()}>{Icon.restore({ size: 12 })} Import</button>
            <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onImport(f); e.target.value = ''; }} />
          </div>
        </aside>
        <div className="projects-detail-pane">
          {active ? <ProjectDetail brain={active} /> : (
            <div className="card creative-card creative-empty-card">
              <span aria-hidden="true">{Icon.layers({ size: 32 })}</span>
              <p>Select or create a project to open its brain.</p>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
