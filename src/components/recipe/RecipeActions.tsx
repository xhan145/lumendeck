import { useRef, useState } from 'react';
import { downloadJson, slugify } from '../../bridge/exporter';
import { buildLumenFile, parseLumenFile } from '../../core/lumenFile';
import { TEMPLATES } from '../../data/templates';
import { useStudio } from '../../state/store';
import { Icon } from '../icons';

function TemplatesModal({ onClose }: { onClose: () => void }) {
  const applyTemplate = useStudio((s) => s.applyTemplate);
  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Recipe templates">
        <div className="drawer-head">
          <h2>Start from a template</h2>
          <button className="btn icon" type="button" aria-label="Close templates" onClick={onClose}>{Icon.close()}</button>
        </div>
        <div className="drawer-body">
          <div className="template-list">
            {TEMPLATES.map((t) => (
              <article key={t.id} className="card template-card">
                <div>
                  <h3>{t.name}</h3>
                  <p className="field-help">{t.description}</p>
                </div>
                <button className="btn primary" type="button" onClick={() => { applyTemplate(t.id); onClose(); }}>
                  Use
                </button>
              </article>
            ))}
          </div>
        </div>
      </aside>
    </>
  );
}

export function RecipeActions() {
  const workflow = useStudio((s) => s.workflow);
  const rackPresets = useStudio((s) => s.rackPresets);
  const loadWorkflowFile = useStudio((s) => s.loadWorkflowFile);
  const fileInput = useRef<HTMLInputElement>(null);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    const name = slugify(workflow.name, 'recipe');
    downloadJson(buildLumenFile(workflow, rackPresets, new Date()), `${name}.lumen`);
  };

  const openFile = async (file: File) => {
    setError(null);
    const text = await file.text();
    const res = parseLumenFile(text);
    if (res.ok) {
      loadWorkflowFile(res.file);
    } else {
      setError(res.error);
    }
  };

  return (
    <div className="recipe-actions">
      <button className="btn" type="button" onClick={save}>{Icon.save({ size: 14 })} Save recipe</button>
      <button className="btn" type="button" onClick={() => fileInput.current?.click()}>{Icon.folder({ size: 14 })} Open recipe</button>
      <button className="btn" type="button" onClick={() => setTemplatesOpen(true)}>{Icon.grid({ size: 14 })} Templates</button>
      <input
        ref={fileInput}
        type="file"
        accept=".lumen,.json,application/json"
        className="visually-hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void openFile(f);
          e.target.value = '';
        }}
      />
      {error ? <p className="recipe-actions-error" role="alert">{Icon.warning({ size: 14 })} {error}</p> : null}
      {templatesOpen ? <TemplatesModal onClose={() => setTemplatesOpen(false)} /> : null}
    </div>
  );
}
