import { useMemo, useRef, useState } from 'react';
import { Icon } from '../icons';
import type { ProjectBrain, ProjectEvent } from '../../core/creative/types';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const EVENT_ICON: Partial<Record<ProjectEvent['type'], (p?: { size?: number }) => React.ReactNode>> = {
  created: Icon.sparkle,
  'status-changed': Icon.pulse,
  'asset-linked': Icon.image,
  'render-linked': Icon.image,
  'prompt-added': Icon.edit,
  'export-built': Icon.trophy,
  'link-published': Icon.link,
  'recipe-linked': Icon.beaker,
  'captions-updated': Icon.edit,
  archived: Icon.trash,
};

function fmt(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Temporal-replay scrubber over a project's event history. Dragging the handle
 * (or arrow keys) replays the project state up to that event. Reuses the Motion
 * scrubber interaction pattern (pointer capture + role="slider" keyboard map).
 */
export function Timeline({ brain }: { brain: ProjectBrain }) {
  const events = useMemo(() => [...brain.events].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)), [brain.events]);
  const last = Math.max(0, events.length - 1);
  const [idx, setIdx] = useState(last);
  const trackRef = useRef<HTMLDivElement | null>(null);

  // Keep the cursor on the newest event when the history grows.
  const cursor = clamp(idx, 0, last);
  const active = events[cursor];

  const seekFromClientX = (clientX: number) => {
    const el = trackRef.current;
    if (!el || events.length <= 1) return;
    const rect = el.getBoundingClientRect();
    const frac = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    setIdx(Math.round(frac * last));
  };

  return (
    <section className="card creative-card timeline-panel" aria-label="Project timeline">
      <div className="creative-card-head">
        <h3>{Icon.clock({ size: 15 })} Timeline</h3>
        <span className="spacer" />
        <span className="chip">{events.length} event{events.length === 1 ? '' : 's'}</span>
      </div>
      {events.length === 0 ? (
        <p className="creative-empty">No history yet.</p>
      ) : (
        <>
          <div
            className="timeline-track"
            ref={trackRef}
            onPointerDown={(e) => {
              (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
              seekFromClientX(e.clientX);
            }}
            onPointerMove={(e) => {
              if (e.buttons === 1) seekFromClientX(e.clientX);
            }}
            role="slider"
            aria-label="Scrub project history"
            aria-valuemin={0}
            aria-valuemax={last}
            aria-valuenow={cursor}
            aria-valuetext={active ? active.label : ''}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft') { setIdx((v) => clamp(v - 1, 0, last)); e.preventDefault(); }
              else if (e.key === 'ArrowRight') { setIdx((v) => clamp(v + 1, 0, last)); e.preventDefault(); }
              else if (e.key === 'Home') { setIdx(0); e.preventDefault(); }
              else if (e.key === 'End') { setIdx(last); e.preventDefault(); }
            }}
          >
            <span className="timeline-line" aria-hidden="true" />
            <span className="timeline-fill" style={{ width: `${last === 0 ? 100 : (cursor / last) * 100}%` }} aria-hidden="true" />
            {events.map((ev, i) => (
              <button
                key={ev.id}
                type="button"
                className={`timeline-tick ${i <= cursor ? 'reached' : ''} ${i === cursor ? 'current' : ''}`}
                style={{ left: `${last === 0 ? 50 : (i / last) * 100}%` }}
                title={`${fmt(ev.at)} · ${ev.label}`}
                aria-label={`${fmt(ev.at)} ${ev.label}`}
                onClick={(e) => { e.stopPropagation(); setIdx(i); }}
              />
            ))}
          </div>
          <ol className="timeline-events">
            {events.slice(0, cursor + 1).reverse().map((ev) => (
              <li key={ev.id} className={ev.id === active?.id ? 'active' : ''}>
                <span className="timeline-ev-icon" aria-hidden="true">{(EVENT_ICON[ev.type] ?? Icon.pulse)({ size: 13 })}</span>
                <span className="timeline-ev-label">{ev.label}</span>
                <span className="timeline-ev-date">{fmt(ev.at)}</span>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
