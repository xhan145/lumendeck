import type React from 'react';
import { CAPSULES, CAPSULE_KINDS } from './core/capsules';
import { findAsset } from './core/shelf';
import type { CapsuleKind } from './core/types';
import { findNode } from './core/workflow';
import { useStudio, type ViewId } from './state/store';
import { CapsuleIcon, Icon } from './components/icons';
import { TurboForgePanel } from './components/TurboForgePanel';
import './styles/base.css';
import './styles/app.css';

function navLabel(view: ViewId): string {
  return view === 'recipe' ? 'Recipe View' : view === 'graph' ? 'Graph View' : view === 'shelf' ? 'Model Shelf' : 'Gallery';
}

function Field({ nodeId, paramId, label, value }: { nodeId: string; paramId: string; label: string; value: unknown }) {
  const updateParam = useStudio((state) => state.updateParam);
  const asText = String(value ?? '');
  if (typeof value === 'boolean') {
    return (
      <label className="field-inline">
        <span className="field-label">{label}</span>
        <input type="checkbox" checked={value} onChange={(event) => updateParam(nodeId, paramId, event.target.checked)} />
      </label>
    );
  }
  if (typeof value === 'number') {
    return (
      <label className="field">
        <span className="field-label">{label}</span>
        <input type="number" value={value} onChange={(event) => updateParam(nodeId, paramId, Number(event.target.value))} />
      </label>
    );
  }
  if (paramId === 'positive' || paramId === 'negative') {
    return (
      <label className="field">
        <span className="field-label">{label}</span>
        <textarea rows={3} value={asText} onChange={(event) => updateParam(nodeId, paramId, event.target.value)} />
      </label>
    );
  }
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input value={asText} onChange={(event) => updateParam(nodeId, paramId, event.target.value)} />
    </label>
  );
}

function RecipeView() {
  const { workflow, selectedNodeId, selectNode } = useStudio();
  return (
    <main className="recipe" aria-label="Recipe View">
      <div className="recipe-inner">
        <p className="recipe-intro">Build a render from friendly capsules. Expert graph wiring stays available in Graph View.</p>
        {workflow.nodes.map((node) => {
          const def = CAPSULES[node.kind];
          return (
            <button
              key={node.id}
              type="button"
              className={`card recipe-card ${selectedNodeId === node.id ? 'selected' : ''}`}
              style={{ '--accent': def.accent } as React.CSSProperties}
              onClick={() => selectNode(node.id)}
            >
              <div className="recipe-card-head">
                <span className="cap-icon"><CapsuleIcon kind={node.kind} /></span>
                <h2>{def.title}</h2>
              </div>
              <p className="recipe-card-desc">{def.description}</p>
              <div className="recipe-fields">
                {def.params.filter((param) => param.id !== 'slots' && param.id !== 'assetId').slice(0, 3).map((param) => (
                  <Field key={param.id} nodeId={node.id} paramId={param.id} label={param.label} value={node.params[param.id]} />
                ))}
              </div>
            </button>
          );
        })}
      </div>
    </main>
  );
}

function GraphView() {
  const { workflow, addCapsule } = useStudio();
  return (
    <main className="graph-wrap" aria-label="Graph View">
      <div className="graph-toolbar">
        {CAPSULE_KINDS.map((kind: CapsuleKind) => (
          <button key={kind} className="btn" type="button" onClick={() => addCapsule(kind, 80, 80)}>
            <CapsuleIcon kind={kind} /> {CAPSULES[kind].title}
          </button>
        ))}
      </div>
      <div className="graph-stage">
        {workflow.nodes.map((node) => {
          const def = CAPSULES[node.kind];
          return (
            <article
              key={node.id}
              tabIndex={0}
              className="gnode"
              style={{ left: node.x, top: node.y, '--accent': def.accent } as React.CSSProperties}
            >
              <div className="gnode-head"><CapsuleIcon kind={node.kind} /> {def.title}</div>
              <div className="gnode-summary">{def.description}</div>
            </article>
          );
        })}
      </div>
      <div className="graph-hint">{workflow.nodes.length} capsules, {workflow.edges.length} links.</div>
    </main>
  );
}

function ShelfView() {
  const { shelf, workflow, updateParam } = useStudio();
  const modelNode = findNode(workflow, 'model');
  return (
    <main className="shelf" aria-label="Model Shelf">
      <div className="shelf-inner">
        <div className="shelf-head"><h2>Model Shelf</h2><span className="sub">Checkpoints and LoRAs with compatibility metadata.</span></div>
        <div className="shelf-grid">
          {shelf.map((asset) => (
            <article key={asset.id} className={`card asset-card ${asset.installed ? '' : 'uninstalled'}`}>
              <div className="asset-head">
                <h3>{asset.name}</h3>
                <span className={`chip family-${asset.family}`}>{asset.family}</span>
              </div>
              <div className="asset-meta">
                <span>{asset.assetType}</span>
                <span className="mono">{asset.hash}</span>
                <span>{asset.sizeMB.toLocaleString()} MB</span>
              </div>
              <p className="asset-note">{asset.compatibility}</p>
              {asset.assetType === 'checkpoint' && modelNode ? (
                <button className="btn" type="button" disabled={!asset.installed} onClick={() => updateParam(modelNode.id, 'assetId', asset.id)}>
                  Use model
                </button>
              ) : null}
            </article>
          ))}
        </div>
      </div>
    </main>
  );
}

function GalleryView() {
  const { gallery, restoreSnapshot, removeGalleryItem } = useStudio();
  return (
    <main className="gallery" aria-label="Gallery">
      <div className="gallery-inner">
        {gallery.length === 0 ? <div className="gallery-empty">No renders yet.</div> : null}
        <div className="gallery-grid">
          {gallery.map((item) => (
            <article key={item.id} className="card render-card">
              <img src={item.dataUrl} alt={item.manifest.prompt || 'Generated render'} />
              <div className="meta">
                <span className="p">{item.manifest.prompt || 'Untitled render'}</span>
                <span className="s"><span>{item.manifest.seed}</span><span>{new Date(item.createdAt).toLocaleTimeString()}</span></span>
                <div className="drawer-actions">
                  <button className="btn" type="button" onClick={() => restoreSnapshot(item)}>{Icon.restore()} Restore</button>
                  <button className="btn danger" type="button" onClick={() => removeGalleryItem(item.id)}>{Icon.trash()} Remove</button>
                </div>
              </div>
            </article>
          ))}
        </div>
      </div>
    </main>
  );
}

function LoraRackPanel() {
  const { shelf, rackSlots, setRackSlots, rackPresets, saveRackPreset, applyRackPreset, deleteRackPreset, workflow } = useStudio();
  const loras = shelf.filter((asset) => asset.assetType === 'lora' && asset.installed);
  const slots = rackSlots();
  const modelNode = findNode(workflow, 'model');
  const model = findAsset(shelf, String(modelNode?.params.assetId ?? ''));
  const addSlot = (assetId: string) => setRackSlots([...slots, { assetId, weight: 0.7, enabled: true }]);
  return (
    <section className="rail-section">
      <h3>LoRA Rack</h3>
      <div className="rack">
        {slots.map((slot, index) => {
          const asset = findAsset(shelf, slot.assetId);
          const warning = model && asset && model.family !== asset.family ? `${asset.family} LoRA on ${model.family}` : '';
          return (
            <div key={`${slot.assetId}-${index}`} className={`rack-row ${slot.enabled ? '' : 'disabled'}`}>
              <input
                aria-label={`Enable ${asset?.name ?? slot.assetId}`}
                type="checkbox"
                checked={slot.enabled}
                onChange={(event) => setRackSlots(slots.map((s, i) => i === index ? { ...s, enabled: event.target.checked } : s))}
              />
              <div className="rack-name"><span className="n">{asset?.name ?? slot.assetId}</span><span className="w-label">{warning || 'Compatible check ready'}</span></div>
              <input
                aria-label={`Weight for ${asset?.name ?? slot.assetId}`}
                type="number"
                step={0.1}
                value={slot.weight}
                onChange={(event) => setRackSlots(slots.map((s, i) => i === index ? { ...s, weight: Number(event.target.value) } : s))}
              />
              <button className="btn icon danger" type="button" onClick={() => setRackSlots(slots.filter((_, i) => i !== index))}>{Icon.trash()}</button>
            </div>
          );
        })}
        <label className="field">
          <span className="field-label">Add LoRA</span>
          <select value="" onChange={(event) => event.target.value && addSlot(event.target.value)}>
            <option value="">Choose...</option>
            {loras.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
          </select>
        </label>
        <div className="rack-presets-row">
          <button className="btn" type="button" onClick={() => saveRackPreset(`Stack ${rackPresets.length + 1}`)}>{Icon.save()} Save stack</button>
        </div>
        <div className="preset-chip-row">
          {rackPresets.map((preset) => (
            <span key={preset.id} className="chip preset-chip">
              <button className="apply" type="button" onClick={() => applyRackPreset(preset.id)}>{preset.name}</button>
              <button className="del" type="button" onClick={() => deleteRackPreset(preset.id)}>{Icon.close({ size: 12 })}</button>
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

function SideRail() {
  const { health, queue, enqueueRender } = useStudio();
  const errors = health.filter((issue) => issue.severity === 'error');
  return (
    <aside className="side-rail" aria-label="Studio controls">
      <section className="rail-section">
        <button className="btn primary" type="button" disabled={errors.length > 0} onClick={() => void enqueueRender()}>
          {Icon.play()} Render
        </button>
      </section>
      <TurboForgePanel />
      <LoraRackPanel />
      <section className="rail-section">
        <h3>Health</h3>
        {health.length === 0 ? <div className="health-empty">{Icon.ok()} Ready.</div> : (
          <div className="health-list">
            {health.map((issue) => <div key={issue.code} className={`health-item ${issue.severity}`}>{issue.severity === 'error' ? Icon.error() : Icon.warning()} {issue.message}</div>)}
          </div>
        )}
      </section>
      <section className="rail-section">
        <h3>Queue</h3>
        {queue.map((job) => (
          <div key={job.id} className="queue-item">
            <div className="queue-label"><span>{job.label}</span><span className={`status-${job.status}`}>{job.status}</span></div>
            <div className="progress"><div style={{ width: `${job.progress * 100}%` }} /></div>
            {job.error ? <div className="queue-error">{job.error}</div> : null}
          </div>
        ))}
      </section>
    </aside>
  );
}

export function App() {
  const { view, setView } = useStudio();
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">{Icon.logo({ size: 22 })}<span className="lumen">Lumen</span><span className="deck">Deck</span><span className="ver">0.1</span></div>
        <nav className="tabs" aria-label="Primary">
          {(['recipe', 'graph', 'shelf', 'gallery'] as ViewId[]).map((id) => (
            <button key={id} className="tab" type="button" aria-current={view === id} onClick={() => setView(id)}>
              {navLabel(id)}
            </button>
          ))}
        </nav>
      </header>
      <div className="workspace">
        <div className="main-pane">
          {view === 'recipe' ? <RecipeView /> : view === 'graph' ? <GraphView /> : view === 'shelf' ? <ShelfView /> : <GalleryView />}
        </div>
        <SideRail />
      </div>
    </div>
  );
}
