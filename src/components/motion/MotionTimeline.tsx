import { useCallback, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { CAPSULES } from '../../core/capsules';
import type { WorkflowNode } from '../../core/types';
import { useStudio } from '../../state/store';
import type { EasingKind, MotionTrack, OrbMotion } from '../../core/motion/types';
import { clipValueForOrb, sampleTrack } from '../../core/motion/interpolate';
import { bindableParams, isBindable } from '../../core/motion/binding';
import { Icon, CapsuleIcon } from '../icons';
import { TrackLane } from './TrackLane';
import { formatClock, formatRate, timeFraction, xToTime } from './timelineMath';
import '../../styles/motion.css';

const EASINGS: EasingKind[] = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'smoothstep', 'step'];
const ORB_STYLES: OrbMotion['style'][] = ['still', 'orbit', 'bob', 'pulse', 'drift'];
/** Playback rates offered in the transport rate picker. */
const RATES = [0.25, 0.5, 1, 2, 4];

/** Render-clip frame count bounds (UI clamp; the server clamps 1..120). */
const RENDER_FRAMES_MIN = 4;
const RENDER_FRAMES_MAX = 60;
const RENDER_FRAMES_DEFAULT = 12;
/** Render-clip fps bounds. */
const RENDER_FPS_MIN = 6;
const RENDER_FPS_MAX = 30;
const RENDER_FPS_DEFAULT = 12;

function clampInt(value: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(lo, Math.min(hi, Math.round(value)));
}

/** Starting orb motion for a node that has none yet (amplitude in world units). */
const DEFAULT_ORB_MOTION: OrbMotion = { style: 'still', speed: 1.2, amplitude: 48 };
/** Amplitude slider bounds (world units; the demo orbit uses ~60). */
const AMP_MIN = 0;
const AMP_MAX = 120;
const AMP_STEP = 2;

/** Human label for a (nodeId, param) — "Sampler · Guidance (CFG)". */
function trackLabel(node: WorkflowNode | undefined, param: string): string {
  if (!node) return param;
  const def = CAPSULES[node.kind];
  const pd = def.params.find((p) => p.id === param);
  return `${def.title} · ${pd?.label ?? param}`;
}

/**
 * Motion Timeline — the authoring + playback surface for the motion engine.
 * Transport (play/pause/stop/loop/rate/time), a draggable scrubber over the
 * clip duration, a per-track keyframe lane list with easing + remove, an
 * "Add track" node+param picker (guarded by isBindable), per-selected-node
 * OrbMotion controls, and a Bake action. Consumes only the store's motion
 * slice + the pure interpolation/binding fns — no scene/WebGL knowledge.
 *
 * Reduced-motion: nothing here auto-plays; playback is always an explicit
 * button press. CSS suppresses transitions under prefers-reduced-motion.
 */
export function MotionTimeline() {
  const motion = useStudio((s) => s.motion);
  const transport = useStudio((s) => s.transport);
  const workflow = useStudio((s) => s.workflow);
  const selectedNodeId = useStudio((s) => s.selectedNodeId);

  const createClip = useStudio((s) => s.createClip);
  const deleteClip = useStudio((s) => s.deleteClip);
  const setActiveClip = useStudio((s) => s.setActiveClip);
  const addTrack = useStudio((s) => s.addTrack);
  const removeTrack = useStudio((s) => s.removeTrack);
  const addKeyframe = useStudio((s) => s.addKeyframe);
  const updateKeyframe = useStudio((s) => s.updateKeyframe);
  const removeKeyframe = useStudio((s) => s.removeKeyframe);
  const setClipDuration = useStudio((s) => s.setClipDuration);
  const setClipFps = useStudio((s) => s.setClipFps);
  const setClipLoop = useStudio((s) => s.setClipLoop);
  const setOrbMotion = useStudio((s) => s.setOrbMotion);
  const bakeClipToWorkflow = useStudio((s) => s.bakeClipToWorkflow);
  const renderActiveMotionClip = useStudio((s) => s.renderActiveMotionClip);
  const adapterId = useStudio((s) => s.adapterId);

  const play = useStudio((s) => s.transport.play);
  const pause = useStudio((s) => s.transport.pause);
  const stop = useStudio((s) => s.transport.stop);
  const seek = useStudio((s) => s.transport.seek);
  const setRate = useStudio((s) => s.transport.setRate);

  const clip = useMemo(
    () => motion.clips.find((c) => c.id === motion.activeClipId) ?? null,
    [motion.clips, motion.activeClipId],
  );

  const scrubRef = useRef<HTMLDivElement>(null);
  const scrubbingRef = useRef(false);

  // ---- add-track picker state --------------------------------------------
  const [pickNodeId, setPickNodeId] = useState('');
  const [pickParam, setPickParam] = useState('');

  const nodeById = useCallback(
    (id: string): WorkflowNode | undefined => workflow.nodes.find((n) => n.id === id),
    [workflow.nodes],
  );

  // Nodes that expose at least one bindable numeric param (candidates to bind).
  const bindableNodes = useMemo(
    () => workflow.nodes.filter((n) => bindableParams(n.kind).length > 0),
    [workflow.nodes],
  );

  const pickNode = pickNodeId ? nodeById(pickNodeId) : undefined;
  const pickParams = useMemo(
    () => (pickNode ? bindableParams(pickNode.kind) : []),
    [pickNode],
  );

  // ---- scrubber ----------------------------------------------------------
  const duration = clip?.duration ?? 0;

  const timeAtClientX = useCallback(
    (clientX: number): number => {
      const el = scrubRef.current;
      if (!el) return 0;
      const rect = el.getBoundingClientRect();
      return xToTime(clientX - rect.left, duration, rect.width);
    },
    [duration],
  );

  const onScrubPointerDown = (e: React.PointerEvent) => {
    if (!clip || e.button !== 0) return;
    scrubbingRef.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    seek(timeAtClientX(e.clientX));
  };

  const onScrubPointerMove = (e: React.PointerEvent) => {
    if (!scrubbingRef.current) return;
    seek(timeAtClientX(e.clientX));
  };

  const onScrubPointerUp = (e: React.PointerEvent) => {
    if (!scrubbingRef.current) return;
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    scrubbingRef.current = false;
  };

  const onScrubKeyDown = (e: React.KeyboardEvent) => {
    if (!clip) return;
    const step = e.shiftKey ? 1 : 0.1;
    if (e.key === 'ArrowLeft') { e.preventDefault(); seek(transport.t - step); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); seek(transport.t + step); }
    else if (e.key === 'Home') { e.preventDefault(); seek(0); }
    else if (e.key === 'End') { e.preventDefault(); seek(duration); }
  };

  // ---- add a keyframe at time t with the currently sampled value ----------
  const addKeyframeAt = useCallback(
    (track: MotionTrack, t: number) => {
      if (!clip) return;
      const node = nodeById(track.nodeId);
      // Prefer the track's own sampled value; if the track is empty, resolve
      // the value the orb would show (bound curve else the live param).
      const sampled = sampleTrack(track, t);
      const value = sampled != null
        ? sampled
        : node
          ? clipValueForOrb(clip, node, t, Number(node.params[track.param] ?? 0))
          : 0;
      addKeyframe(track.id, t, value);
    },
    [addKeyframe, clip, nodeById],
  );

  // ---- orb motion for the selected node -----------------------------------
  const selectedNode = selectedNodeId ? nodeById(selectedNodeId) : undefined;
  const selectedOrbMotion: OrbMotion =
    (selectedNodeId && clip?.orbMotions[selectedNodeId]) || DEFAULT_ORB_MOTION;

  const patchOrbMotion = (patch: Partial<OrbMotion>) => {
    if (!selectedNodeId) return;
    setOrbMotion(selectedNodeId, { ...selectedOrbMotion, ...patch });
  };

  const doAddTrack = () => {
    if (!clip || !pickNode || !pickParam) return;
    if (!isBindable(pickNode.kind, pickParam)) return;
    addTrack(pickNode.id, pickParam);
    setPickParam('');
  };

  // ---- render clip -------------------------------------------------------
  const [renderFrames, setRenderFrames] = useState(RENDER_FRAMES_DEFAULT);
  const [renderFps, setRenderFps] = useState(RENDER_FPS_DEFAULT);
  const [renderFormat, setRenderFormat] = useState<'mp4' | 'gif'>('mp4');
  const [rendering, setRendering] = useState(false);
  const [renderPct, setRenderPct] = useState(0);
  const [renderPhase, setRenderPhase] = useState('');
  const [renderError, setRenderError] = useState<string | null>(null);
  const [renderNotice, setRenderNotice] = useState<string | null>(null);

  const isMockBackend = adapterId === 'mock';
  const hasTracks = (clip?.tracks.length ?? 0) > 0;

  const doRenderClip = async () => {
    if (!clip || rendering) return;
    const frames = clampInt(renderFrames, RENDER_FRAMES_MIN, RENDER_FRAMES_MAX, RENDER_FRAMES_DEFAULT);
    const fps = clampInt(renderFps, RENDER_FPS_MIN, RENDER_FPS_MAX, RENDER_FPS_DEFAULT);
    // Normalize any out-of-range typing back into the inputs before rendering.
    setRenderFrames(frames);
    setRenderFps(fps);
    setRendering(true);
    setRenderPct(0);
    setRenderPhase('queued');
    setRenderError(null);
    setRenderNotice(null);
    try {
      const { fallbackReason } = await renderActiveMotionClip(
        { frames, fps, format: renderFormat },
        (update) => {
          const p = typeof update === 'number' ? { progress: update } : update;
          setRenderPct(Math.round((p.progress ?? 0) * 100));
          if (p.phase) setRenderPhase(p.detail ?? p.phase);
        },
      );
      setRenderPct(100);
      setRenderPhase('done');
      setRenderNotice(
        fallbackReason
          ? `Placeholder render added to the Gallery — ${fallbackReason}`
          : 'Rendered clip added to the Gallery.',
      );
    } catch (err) {
      setRenderError(err instanceof Error ? err.message : String(err));
    } finally {
      setRendering(false);
    }
  };

  const playing = transport.playing;

  return (
    <section className="motion-timeline" aria-label="Motion Timeline">
      <header className="mt-head">
        <h3 className="mt-title">{Icon.pulse({ size: 14 })} Motion Timeline</h3>
        <div className="mt-clip-picker">
          <label className="mt-inline">
            <span className="mt-inline-label">Clip</span>
            <select
              aria-label="Active motion clip"
              value={clip?.id ?? ''}
              onChange={(e) => setActiveClip(e.target.value || null)}
            >
              {motion.clips.length === 0 ? <option value="">No clips</option> : null}
              {motion.clips.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
          <button className="btn" type="button" onClick={() => createClip()} title="Create a new motion clip">
            {Icon.plus({ size: 14 })} New clip
          </button>
          <button
            className="btn icon"
            type="button"
            disabled={!clip}
            aria-label="Delete clip"
            title="Delete the active clip"
            onClick={() => clip && deleteClip(clip.id)}
          >
            {Icon.trash({ size: 14 })}
          </button>
        </div>
      </header>

      {!clip ? (
        <p className="field-help mt-empty">
          No motion clip yet. Create one to choreograph the constellation over a timeline.
        </p>
      ) : (
        <>
          {/* ---- transport ------------------------------------------------ */}
          <div className="mt-transport" role="group" aria-label="Transport">
            <button
              className="btn primary mt-play"
              type="button"
              aria-pressed={playing}
              aria-label={playing ? 'Pause playback' : 'Play'}
              title={playing ? 'Pause' : 'Play'}
              onClick={() => (playing ? pause() : play())}
            >
              {playing ? <span className="mt-pause-glyph" aria-hidden="true" /> : Icon.play({ size: 14 })}
              {playing ? 'Pause' : 'Play'}
            </button>
            <button
              className="btn mt-stop"
              type="button"
              aria-label="Stop and rewind"
              title="Stop (rewind to start)"
              onClick={() => stop()}
            >
              <span className="mt-stop-glyph" aria-hidden="true" /> Stop
            </button>
            <button
              className="btn"
              type="button"
              role="switch"
              aria-checked={clip.loop}
              aria-label="Loop clip"
              title={clip.loop ? 'Looping: playback wraps at the end' : 'Not looping: playback stops at the end'}
              onClick={() => setClipLoop(clip.id, !clip.loop)}
            >
              {Icon.restore({ size: 14 })} Loop
            </button>

            <span className="mt-time mono" role="status" aria-live="off">
              {formatClock(transport.t)} / {formatClock(duration)}
            </span>

            <label className="mt-inline mt-rate">
              <span className="mt-inline-label">Rate</span>
              <select
                aria-label="Playback rate"
                value={String(transport.playbackRate)}
                onChange={(e) => setRate(Number(e.target.value))}
              >
                {RATES.map((r) => (
                  <option key={r} value={r}>{formatRate(r)}</option>
                ))}
              </select>
            </label>
          </div>

          {/* ---- scrubber ------------------------------------------------- */}
          <div
            ref={scrubRef}
            className="mt-scrub"
            role="slider"
            tabIndex={0}
            aria-label="Playhead"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration * 100) / 100}
            aria-valuenow={Math.round(transport.t * 100) / 100}
            aria-valuetext={`${formatClock(transport.t)} of ${formatClock(duration)}`}
            onPointerDown={onScrubPointerDown}
            onPointerMove={onScrubPointerMove}
            onPointerUp={onScrubPointerUp}
            onKeyDown={onScrubKeyDown}
          >
            <div className="mt-scrub-track" aria-hidden="true" />
            <div
              className="mt-scrub-fill"
              style={{ width: `${timeFraction(transport.t, duration) * 100}%` }}
              aria-hidden="true"
            />
            <div
              className="mt-scrub-thumb"
              style={{ left: `${timeFraction(transport.t, duration) * 100}%` }}
              aria-hidden="true"
            />
          </div>

          {/* ---- clip settings ------------------------------------------- */}
          <div className="mt-clip-settings">
            <label className="mt-inline">
              <span className="mt-inline-label">Duration (s)</span>
              <input
                type="number"
                min={0.1}
                step={0.1}
                value={clip.duration}
                aria-label="Clip duration in seconds"
                onChange={(e) => setClipDuration(clip.id, Number(e.target.value))}
              />
            </label>
            <label className="mt-inline">
              <span className="mt-inline-label">FPS</span>
              <input
                type="number"
                min={1}
                max={60}
                step={1}
                value={clip.fps}
                aria-label="Clip frames per second"
                onChange={(e) => setClipFps(clip.id, Number(e.target.value))}
              />
            </label>
            <button
              className="btn"
              type="button"
              title="Write the values sampled at the current time into the workflow params (undo-safe)"
              onClick={() => bakeClipToWorkflow(transport.t)}
            >
              {Icon.save({ size: 14 })} Bake @ {formatClock(transport.t)}
            </button>
          </div>

          {/* ---- render clip --------------------------------------------- */}
          <div className="mt-render" role="group" aria-label="Render clip">
            <div className="mt-render-head">
              <span className="mt-render-title">{Icon.play({ size: 14 })} Render clip</span>
              <p className="field-help mt-render-note">
                Renders the animated generation values; orb position/scale are view-only.
              </p>
            </div>
            <div className="mt-render-controls">
              <label className="mt-inline">
                <span className="mt-inline-label">Frames</span>
                <input
                  type="number"
                  min={RENDER_FRAMES_MIN}
                  max={RENDER_FRAMES_MAX}
                  step={1}
                  value={renderFrames}
                  disabled={rendering}
                  aria-label="Number of frames to render"
                  onChange={(e) => setRenderFrames(Number(e.target.value))}
                  onBlur={(e) => setRenderFrames(clampInt(Number(e.target.value), RENDER_FRAMES_MIN, RENDER_FRAMES_MAX, RENDER_FRAMES_DEFAULT))}
                />
              </label>
              <label className="mt-inline">
                <span className="mt-inline-label">FPS</span>
                <input
                  type="number"
                  min={RENDER_FPS_MIN}
                  max={RENDER_FPS_MAX}
                  step={1}
                  value={renderFps}
                  disabled={rendering}
                  aria-label="Render frames per second"
                  onChange={(e) => setRenderFps(Number(e.target.value))}
                  onBlur={(e) => setRenderFps(clampInt(Number(e.target.value), RENDER_FPS_MIN, RENDER_FPS_MAX, RENDER_FPS_DEFAULT))}
                />
              </label>
              <label className="mt-inline">
                <span className="mt-inline-label">Format</span>
                <select
                  aria-label="Render format"
                  value={renderFormat}
                  disabled={rendering}
                  onChange={(e) => setRenderFormat(e.target.value as 'mp4' | 'gif')}
                >
                  <option value="mp4">MP4</option>
                  <option value="gif">GIF</option>
                </select>
              </label>
              <button
                className="btn primary mt-render-go"
                type="button"
                disabled={rendering || isMockBackend || !hasTracks}
                aria-disabled={rendering || isMockBackend || !hasTracks}
                title={
                  isMockBackend
                    ? 'Switch to the local Diffusers bridge to render a real motion clip (the Mock backend only produces a placeholder).'
                    : !hasTracks
                      ? 'Add at least one track (bind a numeric param) before rendering.'
                      : 'Render the animated clip into a video in the Gallery'
                }
                onClick={doRenderClip}
              >
                {Icon.play({ size: 14 })} {rendering ? 'Rendering…' : 'Render'}
              </button>
            </div>
            {isMockBackend ? (
              <p className="field-help mt-render-mock">
                Mock backend selected — rendering is disabled. It would only produce a clearly-labelled
                placeholder. Switch to the local Diffusers bridge for a real render.
              </p>
            ) : null}
            {rendering || renderPct > 0 ? (
              <div className="mt-render-progress" aria-hidden={!rendering}>
                <div
                  className="mt-render-bar"
                  role="progressbar"
                  aria-label="Render progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={renderPct}
                >
                  <div className="mt-render-fill" style={{ width: `${renderPct}%` }} />
                </div>
                <span className="mt-render-status mono" role="status" aria-live="polite">
                  {renderPhase ? `${renderPhase} · ` : ''}{renderPct}%
                </span>
              </div>
            ) : null}
            {renderNotice ? (
              <p className="field-help mt-render-ok" role="status" aria-live="polite">{renderNotice}</p>
            ) : null}
            {renderError ? (
              <p className="mt-render-err" role="alert">
                {Icon.warning({ size: 14 })} {renderError}
              </p>
            ) : null}
          </div>

          {/* ---- tracks --------------------------------------------------- */}
          <div className="mt-tracks" aria-label="Tracks">
            {clip.tracks.length === 0 ? (
              <p className="field-help">No tracks yet. Bind a numeric param below to animate it.</p>
            ) : (
              clip.tracks.map((track) => {
                const node = nodeById(track.nodeId);
                const incomingEasing = track.keyframes[0]?.easing ?? 'linear';
                return (
                  <div key={track.id} className="mt-track">
                    <div className="mt-track-info">
                      <span className="mt-track-name" title={trackLabel(node, track.param)}>
                        {trackLabel(node, track.param)}
                      </span>
                      <div className="mt-track-controls">
                        <label className="mt-inline">
                          <span className="mt-inline-label sr-only-label">Easing</span>
                          <select
                            aria-label={`Easing for ${trackLabel(node, track.param)}`}
                            value={incomingEasing}
                            onChange={(e) => {
                              // Apply the chosen easing to every keyframe on the track (by stable id).
                              const easing = e.target.value as EasingKind;
                              track.keyframes.forEach((kf) => updateKeyframe(track.id, kf.id, { easing }));
                            }}
                          >
                            {EASINGS.map((k) => (
                              <option key={k} value={k}>{k}</option>
                            ))}
                          </select>
                        </label>
                        <button
                          className="btn icon"
                          type="button"
                          aria-label={`Remove track ${trackLabel(node, track.param)}`}
                          title="Remove this track"
                          onClick={() => removeTrack(track.id)}
                        >
                          {Icon.trash({ size: 14 })}
                        </button>
                      </div>
                    </div>
                    <TrackLane
                      track={track}
                      duration={clip.duration}
                      playheadT={transport.t}
                      onAddKeyframe={(t) => addKeyframeAt(track, t)}
                      onMoveKeyframe={(kfId, t) => updateKeyframe(track.id, kfId, { t })}
                      onRemoveKeyframe={(kfId) => removeKeyframe(track.id, kfId)}
                    />
                  </div>
                );
              })
            )}

            {/* ---- add track picker -------------------------------------- */}
            <div className="mt-add-track" role="group" aria-label="Add track">
              <label className="mt-inline">
                <span className="mt-inline-label sr-only-label">Node</span>
                <select
                  aria-label="Node to bind"
                  value={pickNodeId}
                  onChange={(e) => { setPickNodeId(e.target.value); setPickParam(''); }}
                >
                  <option value="">Pick a node…</option>
                  {bindableNodes.map((n) => (
                    <option key={n.id} value={n.id}>{CAPSULES[n.kind].title}</option>
                  ))}
                </select>
              </label>
              <label className="mt-inline">
                <span className="mt-inline-label sr-only-label">Parameter</span>
                <select
                  aria-label="Parameter to bind"
                  value={pickParam}
                  disabled={!pickNode}
                  onChange={(e) => setPickParam(e.target.value)}
                >
                  <option value="">Pick a param…</option>
                  {pickParams.map((p) => {
                    const pd = pickNode ? CAPSULES[pickNode.kind].params.find((d) => d.id === p) : undefined;
                    return <option key={p} value={p}>{pd?.label ?? p}</option>;
                  })}
                </select>
              </label>
              <button
                className="btn"
                type="button"
                disabled={!pickNode || !pickParam}
                onClick={doAddTrack}
                title="Bind the selected param to a new motion track"
              >
                {Icon.plus({ size: 14 })} Add track
              </button>
            </div>
          </div>

          {/* ---- orb motion (selected node) ------------------------------ */}
          <div className="mt-orb-motion" role="group" aria-label="Orb motion">
            <div className="mt-orb-head">
              <span className="mt-orb-title">
                {selectedNode ? (
                  <>
                    <span className="mt-orb-icon"><CapsuleIcon kind={selectedNode.kind} size={14} /></span>
                    Orb motion · {CAPSULES[selectedNode.kind].title}
                  </>
                ) : (
                  'Orb motion'
                )}
              </span>
            </div>
            {selectedNode ? (
              <div className="mt-orb-controls">
                <label className="mt-inline">
                  <span className="mt-inline-label">Style</span>
                  <select
                    aria-label="Orb motion style"
                    value={selectedOrbMotion.style}
                    onChange={(e) => patchOrbMotion({ style: e.target.value as OrbMotion['style'] })}
                  >
                    {ORB_STYLES.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </label>
                <label className="mt-inline">
                  <span className="mt-inline-label">Speed</span>
                  <input
                    type="range"
                    min={0}
                    max={4}
                    step={0.1}
                    value={selectedOrbMotion.speed}
                    aria-label="Orb motion speed"
                    onChange={(e) => patchOrbMotion({ speed: Number(e.target.value) })}
                  />
                  <span className="mt-inline-val mono">{selectedOrbMotion.speed.toFixed(1)}</span>
                </label>
                <label className="mt-inline">
                  <span className="mt-inline-label">Amplitude</span>
                  <input
                    type="range"
                    min={AMP_MIN}
                    max={AMP_MAX}
                    step={AMP_STEP}
                    value={selectedOrbMotion.amplitude}
                    aria-label="Orb motion amplitude"
                    onChange={(e) => patchOrbMotion({ amplitude: Number(e.target.value) })}
                  />
                  <span className="mt-inline-val mono">{Math.round(selectedOrbMotion.amplitude)}</span>
                </label>
              </div>
            ) : (
              <p className="field-help">Select a node (click its orb) to give it a motion style.</p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
