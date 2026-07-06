import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';
import { useStudio } from '../../state/store';
import { Icon } from '../icons';
import { initialPaletteState, paletteReducer, type PaletteEvent } from './paletteState';

/** Delay before auto-collapse after the pointer leaves, so it never flickers. */
const COLLAPSE_DELAY_MS = 250;

interface Props {
  /** The existing toolbar content (unchanged) from GraphView / Graph3DView. */
  children: React.ReactNode;
}

/**
 * Shared auto-collapsing wrapper for the node palette, used by BOTH the 2D and
 * 3D graph toolbars so behavior is identical. At rest it is a slim vertical
 * "Nodes" tab (~40px); it expands on hover, click, or focus-within, and
 * collapses (after a short delay) when pointer AND keyboard focus leave.
 * Escape collapses and refocuses the tab. The pin button disables
 * auto-collapse and persists via appSettings.palettePinned.
 */
export function CollapsiblePalette({ children }: Props) {
  const pinned = useStudio((s) => s.appSettings.palettePinned ?? false);
  const updateAppSettings = useStudio((s) => s.updateAppSettings);
  const [state, setState] = useState(() => initialPaletteState(pinned));
  const tabRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | null>(null);

  const dispatch = useCallback((event: PaletteEvent) => {
    setState((s) => paletteReducer(s, event));
  }, []);

  const clearCollapseTimer = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const scheduleCollapse = useCallback(() => {
    clearCollapseTimer();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      dispatch({ type: 'collapse-timeout' });
    }, COLLAPSE_DELAY_MS);
  }, [clearCollapseTimer, dispatch]);

  // Keep the reducer's pinned flag in sync with the persisted setting.
  useEffect(() => {
    dispatch({ type: 'set-pinned', pinned });
  }, [pinned, dispatch]);

  useEffect(() => clearCollapseTimer, [clearCollapseTimer]);

  const onPointerEnter = () => {
    clearCollapseTimer();
    dispatch({ type: 'pointer-enter' });
  };

  const onPointerLeave = () => {
    dispatch({ type: 'pointer-leave' });
    scheduleCollapse();
  };

  // Focus tracking lives on the CONTENT (not the tab): focusing the collapsed
  // tab must not auto-expand, or Escape-collapse would immediately reopen.
  const onContentFocus = () => {
    clearCollapseTimer();
    dispatch({ type: 'focus-in' });
  };

  const onContentBlur = (e: React.FocusEvent) => {
    const next = e.relatedTarget as Node | null;
    if (next && contentRef.current?.contains(next)) return; // focus moved within
    dispatch({ type: 'focus-out' });
    scheduleCollapse();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Escape' || !state.open || pinned) return;
    e.stopPropagation();
    clearCollapseTimer();
    dispatch({ type: 'escape' });
    tabRef.current?.focus();
  };

  return (
    <div
      className={`collapsible-palette ${state.open ? 'open' : 'collapsed'}`}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onKeyDown={onKeyDown}
    >
      <button
        ref={tabRef}
        type="button"
        className="palette-tab"
        aria-expanded={state.open}
        aria-label="Node palette"
        title="Open the node palette"
        onClick={() => {
          clearCollapseTimer();
          dispatch({ type: 'expand' });
        }}
      >
        <span className="palette-tab-icon" aria-hidden="true">{Icon.graph({ size: 14 })}</span>
        <span className="palette-tab-label">Nodes</span>
      </button>
      <div
        ref={contentRef}
        className="graph-toolbar"
        role="toolbar"
        aria-label="Add capsule"
        onFocusCapture={onContentFocus}
        onBlurCapture={onContentBlur}
      >
        <div className="palette-pin-row">
          <button
            type="button"
            className="btn palette-pin"
            aria-pressed={pinned}
            title={pinned ? 'Unpin: auto-collapse the palette when not in use' : 'Pin the palette open'}
            onClick={() => updateAppSettings({ palettePinned: !pinned })}
          >
            Pin
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
