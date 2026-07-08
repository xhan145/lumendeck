/**
 * Frame-ownership rule for the constellation's decay (settle) driver.
 *
 * The settle driver is a short-lived rAF+timer loop (it reuses the Motion
 * Engine's starvation-proof createPlaybackDriver) that animates idle-time decay
 * effects — event ripples today — until they settle, then stops, preserving the
 * dirty-flag "the scene sleeps when nothing changes" invariant.
 *
 * DOUBLE-RENDER SAFETY (redteam graphics finding): the settle driver must NEVER
 * run while motion playback or audio reactivity owns the frame. Those loops
 * already render every frame and tick the same effects, so a concurrent settle
 * render would draw the scene TWICE per display frame — the exact hazard flagged
 * in review. This pure predicate is the single source of that mutual exclusion,
 * so "exactly one render per frame under playback + a decaying ripple" is a
 * unit-tested fact rather than a hope.
 */

export interface FrameOwnershipState {
  /** A decay effect (e.g. a live ripple) still needs animating. */
  decayActive: boolean;
  /** Motion playback is running (its loop owns the frame). */
  playing: boolean;
  /** Audio reactivity is running (its loop owns the frame). */
  audioRunning: boolean;
}

/** True iff the settle driver should own the frame: decay pending AND no other driver. */
export function settleShouldRun({ decayActive, playing, audioRunning }: FrameOwnershipState): boolean {
  return decayActive && !playing && !audioRunning;
}
