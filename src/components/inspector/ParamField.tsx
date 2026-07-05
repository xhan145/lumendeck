import { useId } from 'react';
import type { ParamDef } from '../../core/types';
import { Icon } from '../icons';

interface Props {
  def: ParamDef;
  value: unknown;
  onChange: (value: unknown) => void;
}

/** Renders a single capsule parameter as an accessible, labelled control. */
export function ParamField({ def, value, onChange }: Props) {
  const id = useId();
  const help = def.help ? <span className="field-help" id={`${id}-help`}>{def.help}</span> : null;
  const describedBy = def.help ? `${id}-help` : undefined;

  if (def.kind === 'image') {
    const dataUrl = String(value ?? '');
    const onFile = (file: File | undefined) => {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => onChange(String(reader.result));
      reader.readAsDataURL(file);
    };
    return (
      <div className="field">
        <label className="field-label" htmlFor={id}>{def.label}</label>
        <input id={id} type="file" accept="image/*" aria-describedby={describedBy}
          onChange={(e) => onFile(e.target.files?.[0])} />
        {dataUrl ? (
          <div className="field-row" style={{ marginTop: 6 }}>
            <img src={dataUrl} alt={`${def.label} preview`} style={{ height: 48, borderRadius: 6, border: '1px solid var(--ld-border)' }} />
            <button type="button" className="btn icon" aria-label={`Clear ${def.label}`} onClick={() => onChange('')}>
              {Icon.close({ size: 14 })}
            </button>
          </div>
        ) : null}
        {help}
      </div>
    );
  }

  if (def.kind === 'toggle') {
    const checked = Boolean(value);
    return (
      <div className="field-inline">
        <span>
          <label className="field-label" htmlFor={id}>{def.label}</label>
          {help}
        </span>
        <button
          id={id}
          type="button"
          role="switch"
          aria-checked={checked}
          aria-label={def.label}
          className="switch"
          onClick={() => onChange(!checked)}
        />
      </div>
    );
  }

  if (def.kind === 'select') {
    return (
      <div className="field">
        <label className="field-label" htmlFor={id}>{def.label}</label>
        <select id={id} value={String(value ?? '')} aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}>
          {(def.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        {help}
      </div>
    );
  }

  if (def.kind === 'textarea') {
    return (
      <div className="field">
        <label className="field-label" htmlFor={id}>{def.label}</label>
        <textarea id={id} rows={3} value={String(value ?? '')} aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)} />
        {help}
      </div>
    );
  }

  if (def.kind === 'seed') {
    const n = Number(value ?? 0);
    return (
      <div className="field">
        <label className="field-label" htmlFor={id}>{def.label}</label>
        <div className="field-row">
          <input id={id} type="number" value={n} className="mono" aria-describedby={describedBy}
            onChange={(e) => onChange(Number(e.target.value))} />
          <button type="button" className="btn icon" aria-label="Randomize seed"
            title="Randomize seed" onClick={() => onChange(Math.floor(Math.random() * 0xffffffff))}>
            {Icon.dice()}
          </button>
          <button type="button" className="btn icon" aria-label="Random seed each render"
            title="-1 rolls a new seed every render" onClick={() => onChange(-1)}>
            {Icon.bolt()}
          </button>
        </div>
        {help}
      </div>
    );
  }

  if (def.kind === 'number') {
    return (
      <div className="field">
        <label className="field-label" htmlFor={id}>{def.label}</label>
        <input id={id} type="number" value={Number(value ?? 0)} min={def.min} max={def.max} step={def.step}
          aria-describedby={describedBy}
          onChange={(e) => {
            let v = Number(e.target.value);
            if (def.min !== undefined && v < def.min) v = def.min;
            if (def.max !== undefined && v > def.max) v = def.max;
            onChange(v);
          }} />
        {help}
      </div>
    );
  }

  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>{def.label}</label>
      <input id={id} type="text" value={String(value ?? '')} aria-describedby={describedBy}
        onChange={(e) => onChange(e.target.value)} />
      {help}
    </div>
  );
}
