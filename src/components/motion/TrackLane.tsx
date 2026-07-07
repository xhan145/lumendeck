import { useCallback, useRef } from 'react';
import type React from 'react';
import type { MotionTrack } from '../../core/motion/types';
import { timeFraction, xToTime } from './timelineMath';

interface Props {
  track: MotionTrack;
  duration: number;
  /** Currently sampled clip time (for a faint playhead tick in the lane). */
  playheadT: number;
  /**
   * Add a keyframe at time `t` (seconds) with the value currently sampled for
   * this track (MotionTimeline resolves the value via sampleTrack/clipValueForOrb).
   */
  onAddKeyframe: (t: number) => void;
  /**
   * Move a keyframe (identified by its STABLE id, not array index) to a new time
   * (seconds). Index is unsafe: the store re-sorts by t on every edit, so a
   * dragged keyframe's index shifts once it crosses a neighbor.
   */
  onMoveKeyframe: (kfId: string, t: number) => void;
  /** Remove a keyframe by its STABLE id. */
  onRemoveKeyframe: (kfId: string) => void;
}

/**
 * A single track's keyframe lane: a horizontal strip spanning [0, duration]
 * with a draggable dot per keyframe. Clicking empty lane space adds a keyframe
 * at that time; dragging a dot re-times it (value + easing preserved); a dot's
 * context/alt-click removes it. Fully keyboard-operable via the lane buttons.
 *
 * All time<->x mapping goes through the pure helpers in timelineMath so the
 * geometry is testable without a DOM.
 */
export function TrackLane({
  track,
  duration,
  playheadT,
  onAddKeyframe,
  onMoveKeyframe,
  onRemoveKeyframe,
}: Props) {
  const laneRef = useRef<HTMLDivElement>(null);
  // Which keyframe (if any) is being dragged; captured by STABLE ID on pointer-down.
  // Never an index: the store re-sorts by t so the index of the grabbed keyframe
  // can change mid-drag once it crosses a neighbor (that was BUG 4).
  const dragRef = useRef<string | null>(null);

  const timeAtClientX = useCallback(
    (clientX: number): number => {
      const el = laneRef.current;
      if (!el) return 0;
      const rect = el.getBoundingClientRect();
      return xToTime(clientX - rect.left, duration, rect.width);
    },
    [duration],
  );

  const onLanePointerDown = (e: React.PointerEvent) => {
    // Only a bare click on the lane background adds a keyframe; dot handlers
    // stopPropagation so their drags never fall through to here.
    if (e.button !== 0) return;
    onAddKeyframe(timeAtClientX(e.clientX));
  };

  const onDotPointerDown = (kfId: string) => (e: React.PointerEvent) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    // Alt/right-modified click removes the keyframe instead of dragging it.
    if (e.altKey) {
      onRemoveKeyframe(kfId);
      return;
    }
    dragRef.current = kfId;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onDotPointerMove = (e: React.PointerEvent) => {
    const kfId = dragRef.current;
    if (kfId == null) return;
    onMoveKeyframe(kfId, timeAtClientX(e.clientX));
  };

  const onDotPointerUp = (e: React.PointerEvent) => {
    if (dragRef.current == null) return;
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    dragRef.current = null;
  };

  // Keyboard nudging: arrows move a focused keyframe (by STABLE id) by a small step.
  const onDotKeyDown = (kfId: string, t: number) => (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.5 : 0.1;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      onMoveKeyframe(kfId, t - step);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      onMoveKeyframe(kfId, t + step);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      onRemoveKeyframe(kfId);
    }
  };

  return (
    <div
      ref={laneRef}
      className="mt-lane"
      role="group"
      aria-label={`Keyframes for ${track.param}`}
      onPointerDown={onLanePointerDown}
      title="Click to add a keyframe; drag a dot to re-time it; Alt-click a dot to remove"
    >
      <span className="mt-lane-playhead" style={{ left: `${timeFraction(playheadT, duration) * 100}%` }} aria-hidden="true" />
      {track.keyframes.map((kf, index) => (
        <button
          key={kf.id}
          type="button"
          className="mt-kf"
          style={{ left: `${timeFraction(kf.t, duration) * 100}%` }}
          aria-label={`Keyframe ${index + 1} at ${kf.t.toFixed(2)}s, value ${kf.value}`}
          title={`t=${kf.t.toFixed(2)}s · value ${kf.value} (drag to move, Alt-click to remove)`}
          onPointerDown={onDotPointerDown(kf.id)}
          onPointerMove={onDotPointerMove}
          onPointerUp={onDotPointerUp}
          onKeyDown={onDotKeyDown(kf.id, kf.t)}
        />
      ))}
    </div>
  );
}
