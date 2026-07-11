import type { ConstellationNode } from './types';

/**
 * Minimal HTML overlay above the constellation canvas. Semantic, keyboard-safe,
 * screen-reader friendly: the selected node is announced through a polite
 * atomic live region, Back is a real button with a disabled state at the root,
 * and the layer is pointer-events:none except its interactive islands so orbit
 * gestures pass through to the canvas.
 *
 * In list/fallback mode the decorative header hides and the focus block goes
 * visually-hidden (announcements keep working) so the overlay never paints on
 * top of the fallback tree.
 *
 * Copy stays sparse by design — the graphics carry the message; the overlay
 * only states it: FREE. OPEN. YOURS.
 */

export interface ConstellationOverlayProps {
  node: ConstellationNode;
  satelliteCount: number;
  canGoBack: boolean;
  onBack: () => void;
  /** 'scene' over the canvas; 'list' over the fallback tree (compact). */
  mode?: 'scene' | 'list';
}

const FALLBACK_DESCRIPTION = 'Unexplored territory — select a satellite to chart it.';

export function ConstellationOverlay({ node, satelliteCount, canGoBack, onBack, mode = 'scene' }: ConstellationOverlayProps) {
  return (
    <div className={`constellation-overlay${mode === 'list' ? ' constellation-overlay--list' : ''}`}>
      <header className="constellation-head">
        <p className="constellation-eyebrow">FREE. OPEN. YOURS.</p>
        <p className="constellation-subline">Every branch is visible. Every capability is reachable.</p>
      </header>

      <section className="constellation-focus" aria-live="polite" aria-atomic="true">
        {/* tabIndex -1: the view moves focus here when a promotion or a
            disabled Back would otherwise drop focus to <body>. */}
        <h2 className="constellation-title" tabIndex={-1}>
          {node.label}
        </h2>
        <p className="constellation-desc">{node.description || FALLBACK_DESCRIPTION}</p>
        <p className="constellation-meta">
          {satelliteCount === 0
            ? 'No satellites in this orbit — a frontier node.'
            : `${satelliteCount} ${satelliteCount === 1 ? 'satellite' : 'satellites'} in orbit · click one to travel`}
        </p>
      </section>

      <nav className="constellation-nav" aria-label="Constellation navigation">
        <button
          type="button"
          className="btn constellation-back"
          onClick={onBack}
          disabled={!canGoBack}
          title={canGoBack ? 'Return to the previous orbit' : 'You are at the root of the constellation'}
        >
          ← Back
        </button>
      </nav>
    </div>
  );
}

export { FALLBACK_DESCRIPTION };
