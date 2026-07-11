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

    const recompute = () => {
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
      const t = now();
      if (t - lastMove < MOVE_THROTTLE_MS) return;
      lastMove = t;
      const near = edge === 'top' ? e.clientY <= EDGE_PROXIMITY_PX : e.clientX <= EDGE_PROXIMITY_PX;
      const f = flags.current;
      if (near && !f.nearEdge) f.lastActivity = t; // re-arm the grace on reveal
      if (!near && f.nearEdge) f.lastActivity = t; // grace countdown starts on leave
      f.nearEdge = near;
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
