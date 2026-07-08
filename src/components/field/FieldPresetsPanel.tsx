import { useEffect, useMemo, useState } from 'react';
import { useStudio } from '../../state/store';
import {
  presetAxesUsed,
  inertParamsForModel,
  type AxisBundle,
  type FieldPreset,
  type PresetNodeKind,
} from '../../core/field/presets';
import { Icon } from '../icons';
import '../../styles/fieldpresets.css';

/**
 * Field Presets panel — pick one of the 10 curated presets (each maps a ghost's
 * X, Y AND Z position to a distinct render-param bundle), edit an axis, and save
 * a custom preset. Lives in the graph/motion dock beside the Streaming Preview +
 * Motion/Audio/Evolve panels. Consumes ONLY the store's field slice + the pure
 * preset helpers; the store owns the presets list, active id, and persistence.
 *
 * HONEST FRAMING (spec §"Field presets"): the field is a curated, deterministic
 * parameter map — NOT a trained latent space. Params the current model ignores
 * (e.g. a turbo model pins CFG) are surfaced as a hint, never silently dead.
 *
 * The editor enforces the headline guarantee: a custom preset can only be saved
 * once ALL THREE axes bind a parameter (Save stays disabled with a hint until).
 */

/** The six node kinds an axis bundle can drive (from the preset contract). */
const NODE_KINDS: PresetNodeKind[] = ['sampler', 'imageLoader', 'hiresFix', 'controlNetRack', 'loraRack', 'video'];
const NODE_LABELS: Record<PresetNodeKind, string> = {
  sampler: 'Sampler',
  imageLoader: 'Load Image',
  hiresFix: 'Hires Fix',
  controlNetRack: 'ControlNet',
  loraRack: 'LoRA',
  video: 'Video',
};

/** Editable single-param axis (the editor builds one-param bundles). */
interface AxisDraft {
  label: string;
  node: PresetNodeKind;
  param: string;
  min: number;
  max: number;
}

const AXES: { key: 'x' | 'y' | 'z'; glyph: string }[] = [
  { key: 'x', glyph: 'X' },
  { key: 'y', glyph: 'Y' },
  { key: 'z', glyph: 'Z' },
];

/** Seed an editor draft from a preset's axis bundle (its FIRST param). */
function draftFromBundle(bundle: AxisBundle | undefined): AxisDraft {
  const p = bundle?.params[0];
  return {
    label: bundle?.label ?? '',
    node: p?.node ?? 'sampler',
    param: p?.param ?? '',
    min: typeof p?.min === 'number' ? p.min : 0,
    max: typeof p?.max === 'number' ? p.max : 1,
  };
}

const EMPTY_DRAFT: AxisDraft = { label: '', node: 'sampler', param: '', min: 0, max: 1 };

function toBundle(d: AxisDraft): AxisBundle {
  return { label: d.label.trim(), params: [{ node: d.node, param: d.param.trim(), min: d.min, max: d.max }] };
}

/** An axis is "used" once it names both a label and a parameter. */
function axisFilled(d: AxisDraft): boolean {
  return d.label.trim().length > 0 && d.param.trim().length > 0;
}

function numOr(value: string, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function FieldPresetsPanel() {
  const workflow = useStudio((s) => s.workflow);
  const presets = useStudio((s) => s.field.presets);
  const activePresetId = useStudio((s) => s.field.activePresetId);

  const setActiveFieldPreset = useStudio((s) => s.setActiveFieldPreset);
  const saveFieldPreset = useStudio((s) => s.saveFieldPreset);
  const updateFieldPresetAxis = useStudio((s) => s.updateFieldPresetAxis);
  const deleteFieldPreset = useStudio((s) => s.deleteFieldPreset);

  const activePreset: FieldPreset | null = useMemo(
    () => presets.find((p) => p.id === activePresetId) ?? null,
    [presets, activePresetId],
  );
  const activeIsCustom = !!activePreset && !activePreset.builtin;

  // ---- editor drafts (seeded from the active preset for tweak-and-save) -----
  const [name, setName] = useState('');
  const [drafts, setDrafts] = useState<{ x: AxisDraft; y: AxisDraft; z: AxisDraft }>({
    x: { ...EMPTY_DRAFT }, y: { ...EMPTY_DRAFT }, z: { ...EMPTY_DRAFT },
  });

  // Re-seed the editor whenever the active preset changes so "edit an axis, save
  // a variant" starts from the current field mapping (not stale drafts).
  useEffect(() => {
    if (!activePreset) return;
    setDrafts({
      x: draftFromBundle(activePreset.axes.x),
      y: draftFromBundle(activePreset.axes.y),
      z: draftFromBundle(activePreset.axes.z),
    });
  }, [activePreset]);

  const setAxis = (key: 'x' | 'y' | 'z', patch: Partial<AxisDraft>) =>
    setDrafts((d) => ({ ...d, [key]: { ...d[key], ...patch } }));

  const allAxesFilled = axisFilled(drafts.x) && axisFilled(drafts.y) && axisFilled(drafts.z);
  const nameOk = name.trim().length > 0;
  // Belt-and-suspenders: the contract validator must also agree every axis binds
  // (it needs only the axes — Pick<FieldPreset,'axes'>).
  const validatorOk = presetAxesUsed({
    axes: { x: toBundle(drafts.x), y: toBundle(drafts.y), z: toBundle(drafts.z) },
  });
  const canSave = nameOk && allAxesFilled && validatorOk;

  const onSave = () => {
    if (!canSave) return;
    const id = saveFieldPreset(name.trim(), {
      x: toBundle(drafts.x),
      y: toBundle(drafts.y),
      z: toBundle(drafts.z),
    });
    setActiveFieldPreset(id);
    setName('');
  };

  const onApplyAxis = (key: 'x' | 'y' | 'z') => {
    if (!activeIsCustom || !activePreset) return;
    if (!axisFilled(drafts[key])) return;
    updateFieldPresetAxis(activePreset.id, key, toBundle(drafts[key]));
  };

  // ---- inert-param hint for the current model + workflow -------------------
  const modelId = String(workflow.nodes.find((n) => n.kind === 'model')?.params.assetId ?? '');
  // Enabled slot counts for the two racks, so a loraRack.weight / controlNetRack.
  // strength axis with ZERO enabled slots is surfaced as inert (it fans out to
  // enabled slots — none means nothing to drive).
  const enabledSlots = useMemo(() => {
    const countEnabled = (kind: 'loraRack' | 'controlNetRack'): number => {
      const slots = workflow.nodes.find((n) => n.kind === kind)?.params.slots;
      return Array.isArray(slots) ? slots.filter((s) => (s as { enabled?: boolean })?.enabled).length : 0;
    };
    return { loraRack: countEnabled('loraRack'), controlNetRack: countEnabled('controlNetRack') };
  }, [workflow]);
  const inert = useMemo(
    () => (activePreset ? inertParamsForModel(activePreset, modelId, enabledSlots) : []),
    [activePreset, modelId, enabledSlots],
  );

  return (
    <section className="fieldpresets-panel" aria-label="Field presets">
      <header className="fp-head">
        <h3 className="fp-title">{Icon.grid({ size: 14 })} Field presets</h3>
        <span className="fp-status" role="status" aria-live="polite">
          {activePreset ? activePreset.name : 'Auto field'}
        </span>
      </header>

      <p className="field-help fp-note">
        Each preset maps the ghost's X, Y and Z to a render-param bundle. Curated + deterministic — not a trained model.
      </p>

      {/* ---- preset picker ------------------------------------------------- */}
      <ul className="fp-list" role="listbox" aria-label="Field presets">
        <li>
          <button
            type="button"
            className={`fp-item fp-none ${activePresetId == null ? 'active' : ''}`}
            role="option"
            aria-selected={activePresetId == null}
            title="Use the auto-derived field (v0.16 behaviour)"
            onClick={() => setActiveFieldPreset(null)}
          >
            <span className="fp-item-name">Auto field (no preset)</span>
            <span className="fp-item-axes">ghost derives axes from the node</span>
          </button>
        </li>
        {presets.map((preset) => {
          const active = preset.id === activePresetId;
          return (
            <li key={preset.id} className="fp-row">
              <button
                type="button"
                className={`fp-item ${active ? 'active' : ''}`}
                role="option"
                aria-selected={active}
                title={preset.description || preset.name}
                onClick={() => setActiveFieldPreset(preset.id)}
              >
                <span className="fp-item-name">
                  {preset.name}
                  {preset.builtin ? <span className="fp-badge">built-in</span> : <span className="fp-badge custom">custom</span>}
                </span>
                <span className="fp-item-axes">
                  <span className="fp-axis-chip"><b>X</b> {preset.axes.x.label}</span>
                  <span className="fp-axis-chip"><b>Y</b> {preset.axes.y.label}</span>
                  <span className="fp-axis-chip"><b>Z</b> {preset.axes.z.label}</span>
                </span>
              </button>
              <button
                type="button"
                className="btn icon fp-del"
                aria-label={preset.builtin ? `Hide ${preset.name}` : `Delete ${preset.name}`}
                title={preset.builtin ? 'Hide this built-in preset' : 'Delete this custom preset'}
                onClick={() => deleteFieldPreset(preset.id)}
              >
                {Icon.trash({ size: 14 })}
              </button>
            </li>
          );
        })}
      </ul>

      {/* ---- inert-param hint --------------------------------------------- */}
      {inert.length > 0 ? (
        <p className="fp-inert" role="note">
          {Icon.warning({ size: 14 })} The current model ignores: {inert.join(', ')}. Those axes won't affect this render.
        </p>
      ) : null}

      {/* ---- axis editor + save-as-custom --------------------------------- */}
      <div className="fp-editor" role="group" aria-label="Edit axes and save a custom preset">
        <div className="fp-editor-head">
          <span className="fp-editor-title">Edit axes</span>
          <span className="field-help">All three axes must bind a parameter.</span>
        </div>

        {AXES.map(({ key, glyph }) => {
          const d = drafts[key];
          const filled = axisFilled(d);
          return (
            <div key={key} className={`fp-axis-edit ${filled ? '' : 'empty'}`} role="group" aria-label={`${glyph} axis`}>
              <span className={`fp-axis-glyph fp-axis-${key}`} aria-hidden="true">{glyph}</span>
              <input
                className="fp-axis-name"
                value={d.label}
                placeholder="Axis label"
                aria-label={`${glyph} axis label`}
                onChange={(e) => setAxis(key, { label: e.target.value })}
              />
              <select
                className="fp-axis-node"
                value={d.node}
                aria-label={`${glyph} axis node`}
                onChange={(e) => setAxis(key, { node: e.target.value as PresetNodeKind })}
              >
                {NODE_KINDS.map((k) => (
                  <option key={k} value={k}>{NODE_LABELS[k]}</option>
                ))}
              </select>
              <input
                className="fp-axis-param"
                value={d.param}
                placeholder="param"
                aria-label={`${glyph} axis parameter`}
                onChange={(e) => setAxis(key, { param: e.target.value })}
              />
              <input
                type="number"
                className="fp-axis-num"
                value={d.min}
                step="any"
                aria-label={`${glyph} axis minimum`}
                onChange={(e) => setAxis(key, { min: numOr(e.target.value, d.min) })}
              />
              <input
                type="number"
                className="fp-axis-num"
                value={d.max}
                step="any"
                aria-label={`${glyph} axis maximum`}
                onChange={(e) => setAxis(key, { max: numOr(e.target.value, d.max) })}
              />
              {activeIsCustom ? (
                <button
                  type="button"
                  className="btn fp-axis-apply"
                  disabled={!filled}
                  aria-disabled={!filled}
                  title={filled ? `Update the ${glyph} axis on "${activePreset?.name}"` : 'Fill the axis label + parameter first'}
                  onClick={() => onApplyAxis(key)}
                >
                  Apply
                </button>
              ) : null}
            </div>
          );
        })}

        <div className="fp-save-row">
          <input
            className="fp-save-name"
            value={name}
            placeholder="Custom preset name"
            aria-label="Custom preset name"
            onChange={(e) => setName(e.target.value)}
          />
          <button
            type="button"
            className="btn primary fp-save"
            disabled={!canSave}
            aria-disabled={!canSave}
            title={canSave ? 'Save these axes as a new custom preset' : 'Name it and bind all three axes (X, Y, Z) to save'}
            onClick={onSave}
          >
            {Icon.save({ size: 14 })} Save preset
          </button>
        </div>
        {!canSave ? (
          <p className="field-help fp-save-hint">
            {!nameOk
              ? 'Name the preset to save it.'
              : 'Every axis (X, Y and Z) needs a label and a parameter before you can save.'}
          </p>
        ) : null}
      </div>
    </section>
  );
}
