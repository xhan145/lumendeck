import { useEffect, useRef, useState } from 'react';
import { CHROME_IDLE_MS, EDGE_PROXIMITY_PX, chromeVisible } from './chromeVisibility';

/**
 * Autohide behavior for one chrome bar (topbar or NavRail). Wires pointer /
 * focus / edge-proximity listeners around the PURE chromeVisible rule and
 * re-renders only when visibility actually flips.
 *
 * `enabled === false` (pinned) short-circuits to always-visible with no
 * listeners. Focus inside the bar always keeps it visible (keyboard-safe).
 */
export interface AutoHideBar {
  visible: boolean;
  /** Spread onto the bar wrapper element. */
  barProps: {
    onPointerEnter: () => void;
    onPointerLeave: () => void;
    onFocusCapture: () => void;
    onBlurCapture: (e: React.FocusEvent) => void;
  };
}

const POLL_MS = 250;
const MOVE_THROTTLE_MS = 80;

export function useAutoHide(edge: 'top' | 'left', enabled: boolean): AutoHideBar {
  const [visible, setVisible] = useState(true);
  const flags = useRef({ hovering: false, focusWithin: false, nearEdge: false, lastActivity: 0 });

  useEffect(() => {
    if (!enabled) {
      setVisible(true);
      return;
    }
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    flags.current.lastActivity = now(); // fresh grace period on arm
    let lastMove = 0;
    // Latest pointer position, recorded on EVERY move (cheap) so the throttled
    // path and the 250ms poll can re-derive nearEdge from fresh coordinates —
    // a leading-edge-only throttle would otherwise drop the FINAL sample of a
    // flick (pointer parked at the edge never reveals; parked off-edge never
    // hides). NaN until the first move = not near.
    let lastX = Number.NaN;
    let lastY = Number.NaN;

    const sampleNearEdge = () => {
      const c = edge === 'top' ? lastY : lastX;
      const near = Number.isFinite(c) && c <= EDGE_PROXIMITY_PX;
      const f = flags.current;
      if (near !== f.nearEdge) f.lastActivity = now(); // reveal / start hide-grace
      f.nearEdge = near;
    };

    const recompute = () => {
      sampleNearEdge(); // always fresh — never trust a stale cached flag
      const f = flags.current;
      const next = chromeVisible({
        pinned: false,
        hovering: f.hovering,
        focusWithin: f.focusWithin,
        nearEdge: f.nearEdge,
        msSinceActivity: now() - f.lastActivity,
        idleMs: CHROME_IDLE_MS,
      });
      setVisible((v) => (v === next ? v : next));
    };

    const onMove = (e: PointerEvent) => {
      lastX = e.clientX;
      lastY = e.clientY;
      const t = now();
      if (t - lastMove < MOVE_THROTTLE_MS) return; // poll picks up the trailing sample
      lastMove = t;
      recompute();
    };

    window.addEventListener('pointermove', onMove);
    const timer = window.setInterval(recompute, POLL_MS);
    recompute();
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.clearInterval(timer);
    };
  }, [edge, enabled]);

  return {
    visible: enabled ? visible : true,
    barProps: {
      onPointerEnter: () => {
        flags.current.hovering = true;
        setVisible(true);
      },
      onPointerLeave: () => {
        flags.current.hovering = false;
        flags.current.lastActivity = typeof performance !== 'undefined' ? performance.now() : Date.now();
      },
      onFocusCapture: () => {
        flags.current.focusWithin = true;
        setVisible(true);
      },
      onBlurCapture: (e: React.FocusEvent) => {
        // Only clear when focus truly left the bar (not moving between children).
        const to = e.relatedTarget as Node | null;
        if (!to || !(e.currentTarget as Node).contains(to)) {
          flags.current.focusWithin = false;
          flags.current.lastActivity = typeof performance !== 'undefined' ? performance.now() : Date.now();
        }
      },
    },
  };
}
