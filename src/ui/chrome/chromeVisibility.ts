/**
 * Autohide-chrome visibility rule — PURE (the useAutoHide hook wires timers and
 * pointer/focus listeners around this). One function so "when is the bar on
 * screen" is a unit-tested fact (tests/chromeVisibility.test.ts).
 *
 * A bar is visible while any of these hold:
 *  - autohide is disabled (pinned via appSettings.chromeAutohide === false)
 *  - the pointer is over the bar, or near its screen edge (reveal gesture)
 *  - keyboard focus is inside it (NEVER hide mid-interaction)
 *  - it is inside the idle grace period after its last reveal/activity
 */

export interface ChromeInputs {
  /** Autohide opted out (chromeAutohide === false) — always visible. */
  pinned: boolean;
  /** Pointer currently over the bar. */
  hovering: boolean;
  /** document.activeElement is inside the bar. */
  focusWithin: boolean;
  /** Pointer within EDGE_PROXIMITY_PX of the bar's screen edge. */
  nearEdge: boolean;
  /** ms since the last reveal-worthy activity (mount, hover end, edge leave). */
  msSinceActivity: number;
  /** Idle grace before hiding. */
  idleMs: number;
}

export const CHROME_IDLE_MS = 2500;
/**
 * Reveal zone = the TRUE screen edge only. A wider zone (e.g. 24px) overlaps
 * always-visible view chrome — the graph palette tab sits at (12,12) — turning
 * intended in-view clicks into surprise bar reveals under the pointer.
 */
export const EDGE_PROXIMITY_PX = 4;

export function chromeVisible(i: ChromeInputs): boolean {
  if (i.pinned || i.hovering || i.focusWithin || i.nearEdge) return true;
  return i.msSinceActivity < i.idleMs;
}
