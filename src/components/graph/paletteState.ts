/**
 * Pure collapse/expand state machine for the CollapsiblePalette wrapper.
 * No DOM: the component owns timers and focus, this module owns the rules —
 * fully unit-testable (see tests/orbNodes.test.ts).
 *
 * Rules (from the design spec):
 * - The palette stays open while the pointer OR keyboard focus is inside it.
 * - Leaving with both outside collapses it — but only via a delayed
 *   'collapse-timeout' the component schedules (~250ms), so brushing past the
 *   edge never flickers.
 * - Pinning disables auto-collapse entirely (and Escape).
 * - Escape collapses immediately (the component then refocuses the tab).
 */

export interface PaletteState {
  open: boolean;
  pinned: boolean;
  pointerInside: boolean;
  focusInside: boolean;
}

export type PaletteEvent =
  | { type: 'pointer-enter' }
  | { type: 'pointer-leave' }
  | { type: 'focus-in' }
  | { type: 'focus-out' }
  | { type: 'expand' }
  | { type: 'escape' }
  | { type: 'collapse-timeout' }
  | { type: 'set-pinned'; pinned: boolean };

/** Collapsed at rest; pinned palettes start (and stay) open. */
export function initialPaletteState(pinned: boolean): PaletteState {
  return { open: pinned, pinned, pointerInside: false, focusInside: false };
}

export function paletteReducer(state: PaletteState, event: PaletteEvent): PaletteState {
  // Every no-op returns the SAME state object so React can bail out of the
  // re-render — dispatches at rest never wake the component tree.
  switch (event.type) {
    case 'pointer-enter':
      if (state.pointerInside && state.open) return state;
      return { ...state, pointerInside: true, open: true };
    case 'pointer-leave':
      // Collapse is deferred to the component's delayed 'collapse-timeout'.
      if (!state.pointerInside) return state;
      return { ...state, pointerInside: false };
    case 'focus-in':
      if (state.focusInside && state.open) return state;
      return { ...state, focusInside: true, open: true };
    case 'focus-out':
      if (!state.focusInside) return state;
      return { ...state, focusInside: false };
    case 'expand':
      if (state.open) return state;
      return { ...state, open: true };
    case 'escape':
      if (state.pinned) return state;
      if (!state.open && !state.focusInside) return state;
      return { ...state, open: false, focusInside: false };
    case 'collapse-timeout':
      if (state.pinned || state.pointerInside || state.focusInside || !state.open) return state;
      return { ...state, open: false };
    case 'set-pinned': {
      const open = event.pinned ? true : state.open;
      if (state.pinned === event.pinned && state.open === open) return state;
      return { ...state, pinned: event.pinned, open };
    }
    default:
      return state;
  }
}
