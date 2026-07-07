import type React from 'react';
import { useState } from 'react';
import { CAPSULES } from '../../core/capsules';
import type { WorkflowNode } from '../../core/types';
import type { FieldProfile } from '../../core/field/fieldProfile';
import type { MotionParamPatch } from '../../core/motion/renderPlan';
import { Icon } from '../icons';

interface Props {
  /** The ghost's own id (for the store actions). */
  ghostId: string;
  /** The origin node the ghost controls. */
  node: WorkflowNode;
  /** Curated field profile (drives the axis labels shown on the chip). */
  profile: FieldProfile;
  intensity: number;
  pinned: boolean;
  recording: boolean;
  /** Live param patches applyField produced at the ghost's current position. */
  patches: MotionParamPatch[];
  onIntensity: (v: number) => void;
  onPin: () => void;
  onSaveAnchor: (name: string) => void;
  onRecordToggle: () => void;
  onCollapse: () => void;
  /** Arrow keys nudge the ghost per-axis; Enter saves an anchor; Esc collapses. */
  onNudge: (axis: 'x' | 'y' | 'z', delta: number) => void;
}

/**
 * CSS3D chip for a Render-Space Ghost (v0.16.0): the live value readout, the
 * labeled field axes, an intensity slider, and the Pin / Save anchor / Record /
 * Collapse toolbar. Rides a CSS3DObject at the ghost's world center. Keyboard
 * operable per the a11y contract (arrows nudge, Enter saves, Esc collapses).
 *
 * Honest framing: the ghost drives generation VALUES by its position in a
 * deterministic curated field — NOT a trained model.
 */
export function GhostChip({
  ghostId, node, profile, intensity, pinned, recording, patches,
  onIntensity, onPin, onSaveAnchor, onRecordToggle, onCollapse, onNudge,
}: Props) {
  const def = CAPSULES[node.kind];
  const [askName, setAskName] = useState(false);
  const [name, setName] = useState('');

  const axes = ([['x', profile.x], ['y', profile.y], ['z', profile.z]] as const)
    .filter(([, axis]) => !!axis)
    .map(([key, axis]) => ({ key, label: axis!.label }));

  const NUDGE = 0.05;
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onCollapse(); return; }
    if (e.key === 'Enter') { e.preventDefault(); setAskName(true); return; }
    // Arrows: left/right => X, up/down => Z, with Shift for Y (height).
    if (e.key === 'ArrowLeft') { e.preventDefault(); onNudge(e.shiftKey ? 'y' : 'x', -NUDGE); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); onNudge(e.shiftKey ? 'y' : 'x', NUDGE); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); onNudge(e.shiftKey ? 'y' : 'z', -NUDGE); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); onNudge(e.shiftKey ? 'y' : 'z', NUDGE); }
  };

  const submitName = () => {
    const trimmed = name.trim();
    if (trimmed) onSaveAnchor(trimmed);
    setAskName(false);
    setName('');
  };

  return (
    <div
      className={`ghost-chip${pinned ? ' pinned' : ''}${recording ? ' recording' : ''}`}
      role="group"
      tabIndex={0}
      aria-label={`3D controller for ${def.title} — arrow keys move it, Enter saves an anchor, Escape collapses`}
      style={{ '--accent': def.accent } as React.CSSProperties}
      onKeyDown={onKey}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="ghost-chip-head">
        <span className="ghost-chip-title">Ghost · {def.title}</span>
        {recording ? <span className="ghost-chip-rec" aria-label="Recording path">REC</span> : null}
      </div>

      <div className="ghost-chip-values" aria-label="Live values">
        {patches.length === 0
          ? <span className="ghost-chip-empty">No mapped params</span>
          : patches.map((p) => (
              <span key={p.param} className="ghost-chip-value">
                <em>{p.param}</em>{formatValue(p.value)}
              </span>
            ))}
      </div>

      {axes.length > 0 ? (
        <div className="ghost-chip-axes" aria-label="Field axes">
          {axes.map((a) => (
            <span key={a.key} className={`ghost-chip-axis axis-${a.key}`}>{a.key.toUpperCase()}: {a.label}</span>
          ))}
        </div>
      ) : null}

      <label className="ghost-chip-intensity">
        <span>Intensity</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={intensity}
          aria-label={`Ghost intensity for ${def.title}`}
          onChange={(e) => onIntensity(Number(e.target.value))}
        />
        <span className="ghost-chip-intensity-val">{Math.round(intensity * 100)}%</span>
      </label>

      {askName ? (
        <div className="ghost-chip-nameform">
          <input
            autoFocus
            className="ghost-chip-nameinput"
            value={name}
            placeholder="Anchor name"
            aria-label="Anchor name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); submitName(); }
              else if (e.key === 'Escape') { e.preventDefault(); setAskName(false); setName(''); }
            }}
          />
          <button type="button" className="btn ghost-chip-btn" onClick={submitName} title="Save anchor">
            {Icon.save({ size: 13 })}
          </button>
        </div>
      ) : (
        <div className="ghost-chip-toolbar" role="toolbar" aria-label="Ghost controls">
          <button type="button" className="btn ghost-chip-btn" aria-pressed={pinned} onClick={onPin} title={pinned ? 'Unpin ghost' : 'Pin ghost'}>
            Pin
          </button>
          <button type="button" className="btn ghost-chip-btn" onClick={() => setAskName(true)} title="Save this spot as an anchor">
            {Icon.save({ size: 13 })}
          </button>
          <button type="button" className={`btn ghost-chip-btn${recording ? ' rec-on' : ''}`} aria-pressed={recording} onClick={onRecordToggle} title={recording ? 'Stop recording the path' : 'Record the path into a Motion clip'}>
            {Icon.pulse({ size: 13 })}
          </button>
          <button type="button" className="btn ghost-chip-btn" onClick={onCollapse} title="Collapse ghost (keeps current values)" data-ghost-id={ghostId}>
            {Icon.close({ size: 13 })}
          </button>
        </div>
      )}
    </div>
  );
}

/** Compact numeric readout: integers as-is, else up to 2 decimals (trimmed). */
function formatValue(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(2).replace(/\.?0+$/, '');
}
