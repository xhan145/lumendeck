import { useMemo } from 'react';
import { useStudio } from '../../state/store';
import type { AxisBundle, FieldPreset } from '../../core/field/presets';
import type { Workflow } from '../../core/types';
import { Icon } from '../icons';
import '../../styles/fieldpresets.css';

/**
 * Streaming Preview panel — the live, low-res "where does dropping the ghost
 * here land?" viewport for the active field preset. Lives in the graph/motion
 * dock beside the Field Presets + Motion/Audio/Evolve panels (only ever shown ON
 * the 3D view, where the drag→preview wiring runs). Consumes ONLY the store's
 * field slice + backend flags; the store owns the debounce token + render, and
 * Graph3DView owns feeding drag positions in (see fieldPreview.ts).
 *
 * HONEST FRAMING (spec §"Live streaming preview"): the image is a fast miniature,
 * NOT the final render. The Mock backend makes a procedural placeholder (clearly
 * labelled); with no Diffusers bridge there is a LOUD note and never a fake
 * image. "Render full" promotes the current position to a real gallery render.
 *
 * Reduced-motion: nothing auto-renders; the rendering shimmer is CSS-suppressed
 * under prefers-reduced-motion, and streaming is an explicit per-session toggle.
 */

/** Compact numeric readout: integers as-is, else 2 dp (trailing zeros trimmed). */
function fmt(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(2).replace(/\.?0+$/, '');
}

/** The live value of an axis bundle's FIRST param, read from the workflow (— when absent). */
function axisValue(bundle: AxisBundle | undefined, workflow: Workflow): string {
  const first = bundle?.params[0];
  if (!first) return '—';
  const node = workflow.nodes.find((n) => n.kind === first.node);
  const raw = node?.params[first.param];
  return typeof raw === 'number' ? fmt(raw) : '—';
}

const AXES: { key: 'x' | 'y' | 'z'; glyph: string }[] = [
  { key: 'x', glyph: 'X' },
  { key: 'y', glyph: 'Y' },
  { key: 'z', glyph: 'Z' },
];

export function StreamingPreview() {
  const workflow = useStudio((s) => s.workflow);
  const presets = useStudio((s) => s.field.presets);
  const activePresetId = useStudio((s) => s.field.activePresetId);
  const previewImage = useStudio((s) => s.field.previewImage);
  const previewPending = useStudio((s) => s.field.previewPending);
  const streamingEnabled = useStudio((s) => s.field.streamingEnabled);
  const adapterId = useStudio((s) => s.adapterId);
  const bridgeOnline = useStudio((s) => s.bridgeOnline);

  const setStreamingEnabled = useStudio((s) => s.setStreamingEnabled);
  const promoteFieldPreviewToRender = useStudio((s) => s.promoteFieldPreviewToRender);

  const activePreset: FieldPreset | null = useMemo(
    () => presets.find((p) => p.id === activePresetId) ?? null,
    [presets, activePresetId],
  );

  // Backend honesty: mock → placeholder; a real online Diffusers bridge → real;
  // anything else (bridge offline / ComfyUI) → loud "needs the bridge", no fake.
  const backendMode: 'real' | 'mock' | 'nobridge' =
    adapterId === 'mock' ? 'mock' : adapterId === 'bridge' && bridgeOnline ? 'real' : 'nobridge';

  const canRenderFull = !!activePreset;

  return (
    <section className="streaming-preview" aria-label="Streaming preview">
      <header className="sp-head">
        <h3 className="sp-title">{Icon.sparkle({ size: 14 })} Streaming preview</h3>
        <span className={`sp-status ${streamingEnabled ? 'live' : ''}`} role="status" aria-live="polite">
          {streamingEnabled ? (previewPending ? 'Rendering…' : 'Streaming') : 'Off'}
        </span>
      </header>

      <p className="field-help sp-note">
        A fast, low-res miniature of where the ghost sits in the active preset's field — not the final render.
      </p>

      {backendMode === 'nobridge' ? (
        <p className="sp-nobridge" role="alert">
          {Icon.warning({ size: 14 })} Preview needs the local Diffusers bridge. Start it (Settings → Backend);
          the preview never fabricates an image.
        </p>
      ) : null}

      {/* ---- preview stage ------------------------------------------------- */}
      <div className="sp-stage" role="group" aria-label="Latest preview">
        {previewImage ? (
          <img className="sp-img" src={previewImage} alt="Live low-res field preview" draggable={false} />
        ) : (
          <div className="sp-empty" aria-hidden={!streamingEnabled}>
            {streamingEnabled
              ? activePreset
                ? 'Drag the ghost to stream a preview.'
                : 'Pick a field preset to stream previews.'
              : 'Streaming is off.'}
          </div>
        )}
        {previewPending ? (
          <div className="sp-rendering" role="status" aria-live="polite">
            <span className="sp-spinner" aria-hidden="true" />
            Rendering…
          </div>
        ) : null}
        {backendMode === 'mock' && previewImage ? (
          <div className="sp-badge" title="Mock backend renders a procedural placeholder">
            Placeholder
          </div>
        ) : null}
      </div>

      {backendMode === 'mock' ? (
        <p className="field-help sp-mock-note">Preview is a procedural placeholder (Mock backend).</p>
      ) : null}

      {/* ---- live field values (per-axis label + current value) ------------ */}
      {activePreset ? (
        <ul className="sp-axes" aria-label="Live field values">
          {AXES.map(({ key, glyph }) => {
            const bundle = activePreset.axes[key];
            return (
              <li key={key} className="sp-axis">
                <span className={`sp-axis-glyph sp-axis-${key}`} aria-hidden="true">{glyph}</span>
                <span className="sp-axis-label">{bundle.label}</span>
                <span className="sp-axis-val mono">{axisValue(bundle, workflow)}</span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="field-help">No active preset — select one in Field Presets to navigate the field.</p>
      )}

      {/* ---- controls ------------------------------------------------------ */}
      <div className="sp-actions">
        <button
          className="btn"
          type="button"
          aria-pressed={streamingEnabled}
          title={streamingEnabled ? 'Stop streaming live previews' : 'Stream a live preview as you drag the ghost'}
          onClick={() => setStreamingEnabled(!streamingEnabled)}
        >
          {Icon.bolt({ size: 14 })} Streaming {streamingEnabled ? 'on' : 'off'}
        </button>
        <button
          className="btn primary sp-render-full"
          type="button"
          disabled={!canRenderFull}
          aria-disabled={!canRenderFull}
          title={
            canRenderFull
              ? 'Render the current field position at full resolution into the Gallery'
              : 'Select a field preset first'
          }
          onClick={() => void promoteFieldPreviewToRender()}
        >
          {Icon.image({ size: 14 })} Render full
        </button>
      </div>
    </section>
  );
}
